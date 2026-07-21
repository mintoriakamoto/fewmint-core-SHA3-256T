import { buildAuditRecord, type AuditLog } from '@cooklabs/audit';
import { createEvent, type EventEnvelope } from '@cooklabs/events';
import { authorize, type Action, type Grant } from '@cooklabs/permissions';
import { InMemoryTenantRepository, getTenantContext } from '@cooklabs/tenancy';
import type { Customer, Lead } from './types.js';

export class AuthorizationDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuthorizationDeniedError';
  }
}

export class DuplicateCustomerError extends Error {
  constructor(public readonly existingId: string) {
    super(`Customer already exists (${existingId})`);
    this.name = 'DuplicateCustomerError';
  }
}

export interface CrmDeps {
  readonly grants: readonly Grant[];
  readonly audit: AuditLog;
  readonly publish: (event: EventEnvelope) => void;
}

/**
 * CRM module service (spec Phase 3). All operations are tenant-scoped,
 * authorized through @cooklabs/permissions, audited (denials included), and
 * emit catalog events (spec 05 §4) for workflows and agents to react to.
 */
export class CrmService {
  readonly customers = new InMemoryTenantRepository<Customer>('customers');
  readonly leads = new InMemoryTenantRepository<Lead>('leads');

  constructor(private readonly deps: CrmDeps) {}

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
      throw new AuthorizationDeniedError(decision.reason);
    }
  }

  private async recordSuccess(
    operation: string,
    resource: string,
    resourceId: string,
    permission: string,
    eventType: string,
  ): Promise<void> {
    const ctx = getTenantContext();
    await this.deps.audit.append(
      buildAuditRecord({
        actor: ctx.actor,
        tenant_id: ctx.tenantId,
        action: operation,
        resource: { type: resource, id: resourceId },
        permission,
        reason: operation,
        result: 'success',
      }),
    );
    this.deps.publish(
      createEvent({
        event_type: eventType,
        tenant_id: ctx.tenantId,
        entity_id: resourceId,
        payload: {},
      }),
    );
  }

  /** Creates a customer; duplicates by email or phone are rejected (spec 06 dedupe). */
  async createCustomer(input: { name: string; email?: string; phone?: string }): Promise<Customer> {
    await this.guard('create', 'customers', 'customer.create');
    const duplicate = this.customers.list(
      (c) =>
        (input.email !== undefined && c.email === input.email) ||
        (input.phone !== undefined && c.phone === input.phone),
    )[0];
    if (duplicate) throw new DuplicateCustomerError(duplicate.id);
    const customer = this.customers.insert({
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
    });
    await this.recordSuccess(
      'customer.create',
      'customers',
      customer.id,
      'create:customers',
      'customer.created',
    );
    return customer;
  }

  async createLead(input: {
    name: string;
    source: string;
    email?: string;
    phone?: string;
  }): Promise<Lead> {
    await this.guard('create', 'leads', 'lead.create');
    const lead = this.leads.insert({
      name: input.name,
      source: input.source,
      email: input.email ?? null,
      phone: input.phone ?? null,
      status: 'new',
      score: null,
      customer_id: null,
    });
    await this.recordSuccess('lead.create', 'leads', lead.id, 'create:leads', 'lead.created');
    return lead;
  }

  /** Scores a lead; >= threshold marks it qualified, else nurture (spec 12 flow). */
  async qualifyLead(leadId: string, score: number, threshold = 80): Promise<Lead> {
    await this.guard('update', 'leads', 'lead.qualify');
    const lead = await this.leads.updateById(leadId, {
      score,
      status: score >= threshold ? 'qualified' : 'nurture',
    });
    if (lead.status === 'qualified') {
      await this.recordSuccess('lead.qualify', 'leads', lead.id, 'update:leads', 'lead.qualified');
    }
    return lead;
  }

  /** Converts a qualified lead into a customer, linking the two records. */
  async convertLead(leadId: string): Promise<{ lead: Lead; customer: Customer }> {
    await this.guard('update', 'leads', 'lead.convert');
    const lead = await this.leads.findById(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);
    if (lead.status !== 'qualified') {
      throw new Error(`lead ${leadId} is not qualified (status: ${lead.status})`);
    }
    const customer = await this.createCustomer({
      name: lead.name,
      ...(lead.email !== null ? { email: lead.email } : {}),
      ...(lead.phone !== null ? { phone: lead.phone } : {}),
    });
    const updated = await this.leads.updateById(leadId, {
      status: 'converted',
      customer_id: customer.id,
    });
    return { lead: updated, customer };
  }
}
