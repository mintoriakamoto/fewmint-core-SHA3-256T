import { describe, expect, it } from 'vitest';
import { BookingConflictError, SchedulingService, type SchedulingDeps } from '@cooklabs/scheduling';
import { InMemoryAuditLog } from '@cooklabs/audit';
import type { EventEnvelope } from '@cooklabs/events';
import { runWithTenant, type TenantContext } from '@cooklabs/tenancy';

const ctx: TenantContext = {
  tenantId: 'org_a',
  organizationId: 'org_a',
  actor: { id: 'user_1', type: 'user' },
};

function makeService() {
  const audit = new InMemoryAuditLog();
  const events: EventEnvelope[] = [];
  const deps: SchedulingDeps = {
    grants: [{ resource: 'appointments', actions: ['create', 'update', 'read', 'list'] }],
    audit,
    publish: (e) => events.push(e),
  };
  return { service: new SchedulingService(deps), audit, events };
}

const slot = {
  customer_id: 'cus_1',
  resource_id: 'bay_1',
  starts_at: '2026-08-01T09:00:00Z',
  ends_at: '2026-08-01T10:00:00Z',
};

describe('scheduling', () => {
  it('books an appointment and emits appointment.booked', async () => {
    const { service, events } = makeService();
    const appt = await runWithTenant(ctx, () => service.book(slot));
    expect(appt.status).toBe('booked');
    expect(events.map((e) => e.event_type)).toEqual(['appointment.booked']);
  });

  it('rejects overlapping bookings on the same resource', async () => {
    const { service } = makeService();
    await runWithTenant(ctx, () => service.book(slot));
    await runWithTenant(ctx, async () => {
      await expect(
        service.book({
          ...slot,
          customer_id: 'cus_2',
          starts_at: '2026-08-01T09:30:00Z',
          ends_at: '2026-08-01T10:30:00Z',
        }),
      ).rejects.toThrow(BookingConflictError);
    });
  });

  it('allows the same time on a different resource, and back-to-back slots', async () => {
    const { service } = makeService();
    await runWithTenant(ctx, async () => {
      await service.book(slot);
      await service.book({ ...slot, resource_id: 'bay_2' });
      await service.book({
        ...slot,
        starts_at: '2026-08-01T10:00:00Z',
        ends_at: '2026-08-01T11:00:00Z',
      });
    });
  });

  it('cancel frees the slot and emits appointment.cancelled', async () => {
    const { service, events } = makeService();
    await runWithTenant(ctx, async () => {
      const appt = await service.book(slot);
      await service.cancel(appt.id);
      // Slot is free again after cancellation.
      await service.book({ ...slot, customer_id: 'cus_3' });
    });
    expect(events.map((e) => e.event_type)).toEqual([
      'appointment.booked',
      'appointment.cancelled',
      'appointment.booked',
    ]);
  });

  it('reschedule checks conflicts but ignores its own slot', async () => {
    const { service } = makeService();
    await runWithTenant(ctx, async () => {
      const appt = await service.book(slot);
      const moved = await service.reschedule(
        appt.id,
        '2026-08-01T09:15:00Z',
        '2026-08-01T10:15:00Z',
      );
      expect(moved.starts_at).toBe('2026-08-01T09:15:00Z');

      await service.book({
        ...slot,
        customer_id: 'cus_4',
        starts_at: '2026-08-01T11:00:00Z',
        ends_at: '2026-08-01T12:00:00Z',
      });
      await expect(
        service.reschedule(appt.id, '2026-08-01T11:30:00Z', '2026-08-01T12:30:00Z'),
      ).rejects.toThrow(BookingConflictError);
    });
  });

  it('rejects zero or negative-length appointments', async () => {
    const { service } = makeService();
    await runWithTenant(ctx, async () => {
      await expect(service.book({ ...slot, ends_at: slot.starts_at })).rejects.toThrow(/ends_at/);
    });
  });
});
