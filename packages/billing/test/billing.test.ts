import { describe, expect, it } from 'vitest';
import { BillingService, InvalidTransitionError, type BillingDeps } from '@cooklabs/billing';
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
  const deps: BillingDeps = {
    grants: [
      { resource: 'invoices', actions: ['create', 'update', 'read', 'list'] },
      { resource: 'usage_records', actions: ['create', 'read', 'list'] },
    ],
    audit,
    publish: (e) => events.push(e),
  };
  return { service: new BillingService(deps), audit, events };
}

const lines = [
  { description: 'Brake pads', quantity: 2, unit_price_cents: 4_500 },
  { description: 'Labor', quantity: 3, unit_price_cents: 12_000 },
];

describe('invoices', () => {
  it('computes totals in integer cents with basis-point tax', async () => {
    const { service, events } = makeService();
    const invoice = await runWithTenant(ctx, () =>
      service.createInvoice({ customer_id: 'cus_1', lines, tax_bps: 825 }),
    );
    expect(invoice.subtotal_cents).toBe(45_000);
    expect(invoice.tax_cents).toBe(3_713); // round(45000 * 0.0825)
    expect(invoice.total_cents).toBe(48_713);
    expect(events.map((e) => e.event_type)).toEqual(['invoice.created']);
  });

  it('rejects float money and zero quantities', async () => {
    const { service } = makeService();
    await runWithTenant(ctx, async () => {
      await expect(
        service.createInvoice({
          customer_id: 'c',
          lines: [{ description: 'x', quantity: 1, unit_price_cents: 9.99 }],
        }),
      ).rejects.toThrow(/integer/);
      await expect(
        service.createInvoice({
          customer_id: 'c',
          lines: [{ description: 'x', quantity: 0, unit_price_cents: 100 }],
        }),
      ).rejects.toThrow(/positive/);
    });
  });

  it('lifecycle: draft → issued → partial → paid, with payment.received events', async () => {
    const { service, events } = makeService();
    await runWithTenant(ctx, async () => {
      const invoice = await service.createInvoice({ customer_id: 'cus_1', lines });
      await service.issue(invoice.id, '2026-09-01T00:00:00Z');

      const partial = await service.recordPayment(invoice.id, 20_000);
      expect(partial.status).toBe('issued');
      expect(partial.paid_cents).toBe(20_000);

      const full = await service.recordPayment(invoice.id, 25_000);
      expect(full.status).toBe('paid');
    });
    expect(events.map((e) => e.event_type)).toEqual([
      'invoice.created',
      'payment.received',
      'payment.received',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({ paid_in_full: true });
  });

  it('overdue sweep flips only issued invoices past due and emits invoice.overdue', async () => {
    const { service, events } = makeService();
    await runWithTenant(ctx, async () => {
      const late = await service.createInvoice({ customer_id: 'c1', lines });
      await service.issue(late.id, '2026-08-01T00:00:00Z');
      const onTime = await service.createInvoice({ customer_id: 'c2', lines });
      await service.issue(onTime.id, '2026-12-01T00:00:00Z');
      await service.createInvoice({ customer_id: 'c3', lines }); // draft, untouched

      const flipped = await service.markOverdue('2026-09-15T00:00:00Z');
      expect(flipped.map((i) => i.customer_id)).toEqual(['c1']);

      // An overdue invoice can still be paid.
      const paid = await service.recordPayment(late.id, 45_000);
      expect(paid.status).toBe('paid');
    });
    expect(events.filter((e) => e.event_type === 'invoice.overdue')).toHaveLength(1);
  });

  it('enforces the state machine', async () => {
    const { service } = makeService();
    await runWithTenant(ctx, async () => {
      const invoice = await service.createInvoice({ customer_id: 'c', lines });
      await expect(service.recordPayment(invoice.id, 100)).rejects.toThrow(InvalidTransitionError);
      await service.issue(invoice.id, '2026-09-01T00:00:00Z');
      await expect(service.issue(invoice.id, '2026-09-02T00:00:00Z')).rejects.toThrow(
        InvalidTransitionError,
      );
      await service.recordPayment(invoice.id, 45_000);
      await expect(service.voidInvoice(invoice.id)).rejects.toThrow(InvalidTransitionError);
    });
  });
});

describe('usage ledger', () => {
  it('meters usage and reports per-tenant gross profit', async () => {
    const { service } = makeService();
    await runWithTenant(ctx, async () => {
      await service.recordUsage({
        feature: 'ai_tokens',
        quantity: 120_000,
        unit: 'tokens',
        cost_cents: 90,
        price_cents: 300,
      });
      await service.recordUsage({
        feature: 'sms',
        quantity: 40,
        unit: 'messages',
        cost_cents: 120,
        price_cents: 400,
      });
      expect(service.grossProfitCents()).toBe(300 - 90 + (400 - 120));
    });
  });

  it('usage is tenant-scoped', async () => {
    const { service } = makeService();
    await runWithTenant(ctx, () =>
      service.recordUsage({
        feature: 'ai_tokens',
        quantity: 1,
        unit: 'tokens',
        cost_cents: 1,
        price_cents: 2,
      }),
    );
    const tenantB: TenantContext = { ...ctx, tenantId: 'org_b', organizationId: 'org_b' };
    await runWithTenant(tenantB, async () => {
      expect(service.usage.list()).toHaveLength(0);
      expect(service.grossProfitCents()).toBe(0);
    });
  });
});
