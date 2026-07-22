import { buildAuditRecord, type AuditLog } from '@cooklabs/audit';
import { createEvent, type EventEnvelope } from '@cooklabs/events';
import { authorize, type Action, type Grant } from '@cooklabs/permissions';
import { InMemoryTenantRepository, getTenantContext } from '@cooklabs/tenancy';
import type { BillingService, InvoiceLine } from '@cooklabs/billing';
import type { RepairOrder, RepairOrderStatus, Vehicle } from './types.js';

export interface AutoDeps {
  readonly grants: readonly Grant[];
  readonly audit: AuditLog;
  readonly publish: (event: EventEnvelope) => void;
}

export class InvalidRepairTransitionError extends Error {
  constructor(from: RepairOrderStatus, to: RepairOrderStatus) {
    super(`Invalid repair order transition ${from} → ${to}`);
    this.name = 'InvalidRepairTransitionError';
  }
}

class DeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuthorizationDeniedError';
  }
}

const TRANSITIONS: Readonly<Record<RepairOrderStatus, RepairOrderStatus | null>> = {
  created: 'inspecting',
  inspecting: 'estimated',
  estimated: 'approved',
  approved: 'in_progress',
  in_progress: 'completed',
  completed: 'invoiced',
  invoiced: null,
};

abstract class GuardedService {
  constructor(protected readonly deps: AutoDeps) {}

  protected async guard(action: Action, resource: string, operation: string): Promise<void> {
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

  protected async success(
    operation: string,
    resource: string,
    id: string,
    permission: string,
    eventType?: string,
  ): Promise<void> {
    const ctx = getTenantContext();
    await this.deps.audit.append(
      buildAuditRecord({
        actor: ctx.actor,
        tenant_id: ctx.tenantId,
        action: operation,
        resource: { type: resource, id },
        permission,
        reason: operation,
        result: 'success',
      }),
    );
    if (eventType !== undefined) {
      this.deps.publish(
        createEvent({ event_type: eventType, tenant_id: ctx.tenantId, entity_id: id, payload: {} }),
      );
    }
  }
}

export class VehicleService extends GuardedService {
  readonly vehicles = new InMemoryTenantRepository<Vehicle>('vehicles');

  async addVehicle(input: {
    customer_id: string;
    vin: string;
    make: string;
    model: string;
    year: number;
  }): Promise<Vehicle> {
    await this.guard('create', 'vehicles', 'vehicle.add');
    const existing = this.vehicles.list((v) => v.vin === input.vin)[0];
    if (existing) throw new Error(`VIN ${input.vin} already registered (${existing.id})`);
    const vehicle = this.vehicles.insert({ ...input });
    await this.success('vehicle.add', 'vehicles', vehicle.id, 'create:vehicles');
    return vehicle;
  }
}

/**
 * Repair order lifecycle (doc 13 §1 steps 7–13). Estimates and invoices are
 * handled by @cooklabs/billing — this module never re-implements money.
 */
export class RepairOrderService extends GuardedService {
  readonly orders = new InMemoryTenantRepository<RepairOrder>('repair_orders');

  private async transition(id: string, to: RepairOrderStatus): Promise<RepairOrder> {
    const order = await this.mustGet(id);
    if (TRANSITIONS[order.status] !== to) throw new InvalidRepairTransitionError(order.status, to);
    return this.orders.updateById(id, { status: to });
  }

  async create(input: {
    customer_id: string;
    vehicle_id: string;
    complaint: string;
    appointment_id?: string;
  }): Promise<RepairOrder> {
    await this.guard('create', 'repair_orders', 'repair_order.create');
    const order = this.orders.insert({
      customer_id: input.customer_id,
      vehicle_id: input.vehicle_id,
      appointment_id: input.appointment_id ?? null,
      complaint: input.complaint,
      status: 'created',
      inspection_notes: [],
      photo_refs: [],
      technician_id: null,
      invoice_id: null,
      approval_ref: null,
    });
    await this.success('repair_order.create', 'repair_orders', order.id, 'create:repair_orders');
    return order;
  }

  async startInspection(id: string, technicianId: string): Promise<RepairOrder> {
    await this.guard('update', 'repair_orders', 'repair_order.start_inspection');
    await this.transition(id, 'inspecting');
    return this.orders.updateById(id, { technician_id: technicianId });
  }

  async recordInspection(id: string, note: string, photoRef?: string): Promise<RepairOrder> {
    await this.guard('update', 'repair_orders', 'repair_order.record_inspection');
    const order = await this.mustGet(id);
    if (order.status !== 'inspecting') {
      throw new InvalidRepairTransitionError(order.status, 'inspecting');
    }
    return this.orders.updateById(id, {
      inspection_notes: [...order.inspection_notes, note],
      photo_refs: photoRef !== undefined ? [...order.photo_refs, photoRef] : order.photo_refs,
    });
  }

  /** Builds the estimate as a billing draft invoice; emits estimate.created. */
  async createEstimate(
    id: string,
    lines: readonly InvoiceLine[],
    billing: BillingService,
    taxBps?: number,
  ): Promise<RepairOrder> {
    await this.guard('update', 'repair_orders', 'repair_order.create_estimate');
    const order = await this.mustGet(id);
    if (order.status !== 'inspecting') {
      throw new InvalidRepairTransitionError(order.status, 'estimated');
    }
    const invoice = await billing.createInvoice({
      customer_id: order.customer_id,
      lines,
      ...(taxBps !== undefined ? { tax_bps: taxBps } : {}),
    });
    await this.transition(id, 'estimated');
    const updated = await this.orders.updateById(id, { invoice_id: invoice.id });
    await this.success(
      'repair_order.create_estimate',
      'repair_orders',
      id,
      'update:repair_orders',
      'estimate.created',
    );
    return updated;
  }

  /** Customer approval (from the estimate_approval workflow's human gate). */
  async approveEstimate(id: string, approvalRef: string): Promise<RepairOrder> {
    await this.guard('update', 'repair_orders', 'repair_order.approve_estimate');
    await this.transition(id, 'approved');
    const updated = await this.orders.updateById(id, { approval_ref: approvalRef });
    await this.success(
      'repair_order.approve_estimate',
      'repair_orders',
      id,
      'update:repair_orders',
      'estimate.approved',
    );
    return updated;
  }

  async startWork(id: string): Promise<RepairOrder> {
    await this.guard('update', 'repair_orders', 'repair_order.start_work');
    const updated = await this.transition(id, 'in_progress');
    await this.success(
      'repair_order.start_work',
      'repair_orders',
      id,
      'update:repair_orders',
      'job.started',
    );
    return updated;
  }

  async completeWork(id: string): Promise<RepairOrder> {
    await this.guard('update', 'repair_orders', 'repair_order.complete_work');
    const updated = await this.transition(id, 'completed');
    await this.success(
      'repair_order.complete_work',
      'repair_orders',
      id,
      'update:repair_orders',
      'job.completed',
    );
    return updated;
  }

  /** Issues the backing invoice through billing and closes the order. */
  async invoice(id: string, billing: BillingService, dueAt: string): Promise<RepairOrder> {
    await this.guard('update', 'repair_orders', 'repair_order.invoice');
    const order = await this.mustGet(id);
    if (order.status !== 'completed')
      throw new InvalidRepairTransitionError(order.status, 'invoiced');
    if (order.invoice_id === null) throw new Error(`repair order ${id} has no estimate invoice`);
    await billing.issue(order.invoice_id, dueAt);
    return this.transition(id, 'invoiced');
  }

  private async mustGet(id: string): Promise<RepairOrder> {
    const order = await this.orders.findById(id);
    if (!order) throw new Error(`repair order ${id} not found`);
    return order;
  }
}
