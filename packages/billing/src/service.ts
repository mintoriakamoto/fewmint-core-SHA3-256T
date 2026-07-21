import { buildAuditRecord, type AuditLog } from '@cooklabs/audit';
import { createEvent, type EventEnvelope } from '@cooklabs/events';
import { authorize, type Action, type Grant } from '@cooklabs/permissions';
import {
  InMemoryTenantRepository,
  getTenantContext,
  type OwnershipColumns,
} from '@cooklabs/tenancy';

/** All money is integer cents — floats never touch totals. */
export interface InvoiceLine {
  readonly description: string;
  readonly quantity: number;
  readonly unit_price_cents: number;
}

export interface Invoice extends OwnershipColumns {
  readonly id: string;
  readonly customer_id: string;
  readonly status: 'draft' | 'issued' | 'paid' | 'overdue' | 'void';
  readonly lines: readonly InvoiceLine[];
  readonly tax_bps: number;
  readonly subtotal_cents: number;
  readonly tax_cents: number;
  readonly total_cents: number;
  readonly paid_cents: number;
  readonly due_at: string | null;
}

/** Usage ledger row (spec 00 billing model): metered consumption per tenant. */
export interface UsageRecord extends OwnershipColumns {
  readonly id: string;
  readonly feature: string;
  readonly quantity: number;
  readonly unit: string;
  readonly cost_cents: number;
  readonly price_cents: number;
}

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid invoice transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

class DeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuthorizationDeniedError';
  }
}

export interface BillingDeps {
  readonly grants: readonly Grant[];
  readonly audit: AuditLog;
  readonly publish: (event: EventEnvelope) => void;
}

/**
 * Billing module (spec Phase 3). Invoice lifecycle:
 * draft → issued → paid | overdue (overdue → paid still allowed); void only
 * from draft/issued. Emits invoice.created / invoice.overdue /
 * payment.received (spec 05 §4).
 */
export class BillingService {
  readonly invoices = new InMemoryTenantRepository<Invoice>('invoices');
  readonly usage = new InMemoryTenantRepository<UsageRecord>('usage_records');

  constructor(private readonly deps: BillingDeps) {}

  private async guard(action: Action, resource: string, operation: string): Promise<void> {
    const ctx = getTenantContext();
    const decision = authorize({
      grants: this.deps.grants,
      resource,
      action,
      actorId: ctx.actor.id,
    });
    if (!decision.allowed) {
      await this.deps.audit.append(
        buildAuditRecord({
          actor: ctx.actor,
          tenant_id: ctx.tenantId,
          action: operation,
          resource: { type: resource },
          permission: `${action}:${resource}`,
          reason: decision.reason,
          result: 'denied',
        }),
      );
      throw new DeniedError(decision.reason);
    }
  }

  private emit(eventType: string, entityId: string, payload: object = {}): void {
    const ctx = getTenantContext();
    this.deps.publish(
      createEvent({
        event_type: eventType,
        tenant_id: ctx.tenantId,
        entity_id: entityId,
        payload: payload as Record<string, unknown>,
      }),
    );
  }

  /** Creates a draft invoice with totals computed in integer cents. */
  async createInvoice(input: {
    customer_id: string;
    lines: readonly InvoiceLine[];
    tax_bps?: number;
  }): Promise<Invoice> {
    await this.guard('create', 'invoices', 'invoice.create');
    if (input.lines.length === 0) throw new Error('invoice requires at least one line');
    for (const line of input.lines) {
      if (!Number.isInteger(line.unit_price_cents) || line.unit_price_cents < 0) {
        throw new Error('unit_price_cents must be a non-negative integer');
      }
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new Error('quantity must be a positive integer');
      }
    }
    const tax_bps = input.tax_bps ?? 0;
    const subtotal = input.lines.reduce((sum, l) => sum + l.quantity * l.unit_price_cents, 0);
    const tax = Math.round((subtotal * tax_bps) / 10_000);
    const invoice = this.invoices.insert({
      customer_id: input.customer_id,
      status: 'draft',
      lines: input.lines,
      tax_bps,
      subtotal_cents: subtotal,
      tax_cents: tax,
      total_cents: subtotal + tax,
      paid_cents: 0,
      due_at: null,
    });
    this.emit('invoice.created', invoice.id, { total_cents: invoice.total_cents });
    return invoice;
  }

  async issue(id: string, dueAt: string): Promise<Invoice> {
    await this.guard('update', 'invoices', 'invoice.issue');
    const invoice = await this.mustGet(id);
    if (invoice.status !== 'draft') throw new InvalidTransitionError(invoice.status, 'issued');
    return this.invoices.updateById(id, { status: 'issued', due_at: dueAt });
  }

  /** Records a payment; full payment marks paid and emits payment.received. */
  async recordPayment(id: string, amountCents: number): Promise<Invoice> {
    await this.guard('update', 'invoices', 'invoice.record_payment');
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('payment must be a positive integer amount of cents');
    }
    const invoice = await this.mustGet(id);
    if (invoice.status !== 'issued' && invoice.status !== 'overdue') {
      throw new InvalidTransitionError(invoice.status, 'paid');
    }
    const paid = invoice.paid_cents + amountCents;
    const updated = await this.invoices.updateById(id, {
      paid_cents: paid,
      ...(paid >= invoice.total_cents ? { status: 'paid' as const } : {}),
    });
    this.emit('payment.received', id, {
      amount_cents: amountCents,
      paid_in_full: paid >= invoice.total_cents,
    });
    return updated;
  }

  /** Sweeps issued invoices past due; each transition emits invoice.overdue. */
  async markOverdue(nowIso: string): Promise<Invoice[]> {
    await this.guard('update', 'invoices', 'invoice.mark_overdue');
    const due = this.invoices.list(
      (i) => i.status === 'issued' && i.due_at !== null && i.due_at < nowIso,
    );
    const flipped: Invoice[] = [];
    for (const invoice of due) {
      flipped.push(await this.invoices.updateById(invoice.id, { status: 'overdue' }));
      this.emit('invoice.overdue', invoice.id, { total_cents: invoice.total_cents });
    }
    return flipped;
  }

  async voidInvoice(id: string): Promise<Invoice> {
    await this.guard('update', 'invoices', 'invoice.void');
    const invoice = await this.mustGet(id);
    if (invoice.status !== 'draft' && invoice.status !== 'issued') {
      throw new InvalidTransitionError(invoice.status, 'void');
    }
    return this.invoices.updateById(id, { status: 'void' });
  }

  /** Meters consumption for the usage ledger (spec 00 §billing). */
  async recordUsage(input: {
    feature: string;
    quantity: number;
    unit: string;
    cost_cents: number;
    price_cents: number;
  }): Promise<UsageRecord> {
    await this.guard('create', 'usage_records', 'usage.record');
    return this.usage.insert({ ...input });
  }

  /** Per-tenant gross profit over the usage ledger: revenue minus direct cost. */
  grossProfitCents(): number {
    return this.usage.list().reduce((sum, u) => sum + (u.price_cents - u.cost_cents), 0);
  }

  private async mustGet(id: string): Promise<Invoice> {
    const invoice = await this.invoices.findById(id);
    if (!invoice) throw new Error(`invoice ${id} not found`);
    return invoice;
  }
}
