import { buildAuditRecord, type AuditLog } from '@cooklabs/audit';
import { createEvent, type EventEnvelope } from '@cooklabs/events';
import { authorize, type Action, type Grant } from '@cooklabs/permissions';
import {
  InMemoryTenantRepository,
  getTenantContext,
  type OwnershipColumns,
} from '@cooklabs/tenancy';

export interface Appointment extends OwnershipColumns {
  readonly id: string;
  readonly customer_id: string;
  /** The booked resource: a bay, a technician, a room. One booking at a time. */
  readonly resource_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: 'booked' | 'cancelled' | 'completed';
  readonly notes: string | null;
}

export class BookingConflictError extends Error {
  constructor(public readonly conflictingId: string) {
    super(`Resource already booked (conflicts with ${conflictingId})`);
    this.name = 'BookingConflictError';
  }
}

class DeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuthorizationDeniedError';
  }
}

export interface SchedulingDeps {
  readonly grants: readonly Grant[];
  readonly audit: AuditLog;
  readonly publish: (event: EventEnvelope) => void;
}

/**
 * Scheduling module (spec Phase 3). Double-booking a resource is rejected
 * with the conflicting appointment id; booked/cancelled transitions emit
 * catalog events (spec 05 §4).
 */
export class SchedulingService {
  readonly appointments = new InMemoryTenantRepository<Appointment>('appointments');

  constructor(private readonly deps: SchedulingDeps) {}

  private async guard(action: Action, operation: string): Promise<void> {
    const ctx = getTenantContext();
    const decision = authorize({
      grants: this.deps.grants,
      resource: 'appointments',
      action,
      actorId: ctx.actor.id,
    });
    if (!decision.allowed) {
      await this.deps.audit.append(
        buildAuditRecord({
          actor: ctx.actor,
          tenant_id: ctx.tenantId,
          action: operation,
          resource: { type: 'appointments' },
          permission: `${action}:appointments`,
          reason: decision.reason,
          result: 'denied',
        }),
      );
      throw new DeniedError(decision.reason);
    }
  }

  private async success(operation: string, id: string, eventType: string): Promise<void> {
    const ctx = getTenantContext();
    await this.deps.audit.append(
      buildAuditRecord({
        actor: ctx.actor,
        tenant_id: ctx.tenantId,
        action: operation,
        resource: { type: 'appointments', id },
        permission: `${operation.includes('book') ? 'create' : 'update'}:appointments`,
        reason: operation,
        result: 'success',
      }),
    );
    this.deps.publish(
      createEvent({ event_type: eventType, tenant_id: ctx.tenantId, entity_id: id, payload: {} }),
    );
  }

  private assertNoConflict(
    resourceId: string,
    startsAt: string,
    endsAt: string,
    ignoreId?: string,
  ): void {
    if (endsAt <= startsAt) throw new Error('ends_at must be after starts_at');
    const conflict = this.appointments.list(
      (a) =>
        a.id !== ignoreId &&
        a.resource_id === resourceId &&
        a.status === 'booked' &&
        a.starts_at < endsAt &&
        startsAt < a.ends_at,
    )[0];
    if (conflict) throw new BookingConflictError(conflict.id);
  }

  async book(input: {
    customer_id: string;
    resource_id: string;
    starts_at: string;
    ends_at: string;
    notes?: string;
  }): Promise<Appointment> {
    await this.guard('create', 'appointment.book');
    this.assertNoConflict(input.resource_id, input.starts_at, input.ends_at);
    const appointment = this.appointments.insert({
      customer_id: input.customer_id,
      resource_id: input.resource_id,
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      status: 'booked',
      notes: input.notes ?? null,
    });
    await this.success('appointment.book', appointment.id, 'appointment.booked');
    return appointment;
  }

  async reschedule(id: string, starts_at: string, ends_at: string): Promise<Appointment> {
    await this.guard('update', 'appointment.reschedule');
    const existing = await this.appointments.findById(id);
    if (!existing || existing.status !== 'booked') {
      throw new Error(`appointment ${id} is not booked`);
    }
    this.assertNoConflict(existing.resource_id, starts_at, ends_at, id);
    const updated = await this.appointments.updateById(id, { starts_at, ends_at });
    await this.success('appointment.reschedule', id, 'appointment.booked');
    return updated;
  }

  async cancel(id: string): Promise<Appointment> {
    await this.guard('update', 'appointment.cancel');
    const updated = await this.appointments.updateById(id, { status: 'cancelled' });
    await this.success('appointment.cancel', id, 'appointment.cancelled');
    return updated;
  }
}
