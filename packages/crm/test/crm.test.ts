import { describe, expect, it } from 'vitest';
import {
  AuthorizationDeniedError,
  CrmService,
  DuplicateCustomerError,
  type CrmDeps,
} from '@cooklabs/crm';
import { InMemoryAuditLog } from '@cooklabs/audit';
import type { EventEnvelope } from '@cooklabs/events';
import { runWithTenant, type TenantContext } from '@cooklabs/tenancy';

const tenantA: TenantContext = {
  tenantId: 'org_a',
  organizationId: 'org_a',
  actor: { id: 'user_1', type: 'user' },
};
const tenantB: TenantContext = {
  tenantId: 'org_b',
  organizationId: 'org_b',
  actor: { id: 'user_2', type: 'user' },
};

function makeService(grants = true) {
  const audit = new InMemoryAuditLog();
  const events: EventEnvelope[] = [];
  const deps: CrmDeps = {
    grants: grants
      ? [
          { resource: 'customers', actions: ['create', 'read', 'list'] },
          { resource: 'leads', actions: ['create', 'update', 'read', 'list'] },
        ]
      : [],
    audit,
    publish: (e) => events.push(e),
  };
  return { service: new CrmService(deps), audit, events };
}

describe('customers', () => {
  it('creates, audits, and emits customer.created', async () => {
    const { service, audit, events } = makeService();
    const customer = await runWithTenant(tenantA, () =>
      service.createCustomer({ name: 'Ada', email: 'ada@example.com' }),
    );
    expect(customer.tenant_id).toBe('org_a');
    expect(events.map((e) => e.event_type)).toEqual(['customer.created']);
    expect(audit.forTenant('org_a')[0]?.result).toBe('success');
  });

  it('rejects duplicates by email or phone', async () => {
    const { service } = makeService();
    await runWithTenant(tenantA, () =>
      service.createCustomer({ name: 'Ada', email: 'ada@example.com' }),
    );
    await runWithTenant(tenantA, async () => {
      await expect(
        service.createCustomer({ name: 'Ada 2', email: 'ada@example.com' }),
      ).rejects.toThrow(DuplicateCustomerError);
    });
  });

  it('the same email in another tenant is NOT a duplicate (tenant isolation)', async () => {
    const { service } = makeService();
    await runWithTenant(tenantA, () =>
      service.createCustomer({ name: 'Ada', email: 'ada@example.com' }),
    );
    const other = await runWithTenant(tenantB, () =>
      service.createCustomer({ name: 'Ada B', email: 'ada@example.com' }),
    );
    expect(other.tenant_id).toBe('org_b');
  });

  it('denies and audits without a grant', async () => {
    const { service, audit, events } = makeService(false);
    await runWithTenant(tenantA, async () => {
      await expect(service.createCustomer({ name: 'X' })).rejects.toThrow(AuthorizationDeniedError);
    });
    expect(audit.forTenant('org_a')[0]?.result).toBe('denied');
    expect(events).toHaveLength(0);
  });
});

describe('leads', () => {
  it('lead lifecycle: create → qualify → convert links a customer', async () => {
    const { service, events } = makeService();
    await runWithTenant(tenantA, async () => {
      const lead = await service.createLead({
        name: 'Lin',
        source: 'web',
        email: 'lin@example.com',
      });
      const qualified = await service.qualifyLead(lead.id, 91);
      expect(qualified.status).toBe('qualified');

      const { lead: converted, customer } = await service.convertLead(lead.id);
      expect(converted.status).toBe('converted');
      expect(converted.customer_id).toBe(customer.id);
      expect(customer.email).toBe('lin@example.com');
    });
    expect(events.map((e) => e.event_type)).toEqual([
      'lead.created',
      'lead.qualified',
      'customer.created',
    ]);
  });

  it('low scores route to nurture and emit no qualified event', async () => {
    const { service, events } = makeService();
    await runWithTenant(tenantA, async () => {
      const lead = await service.createLead({ name: 'Nur', source: 'ads' });
      const scored = await service.qualifyLead(lead.id, 40);
      expect(scored.status).toBe('nurture');
      await expect(service.convertLead(lead.id)).rejects.toThrow(/not qualified/);
    });
    expect(events.map((e) => e.event_type)).toEqual(['lead.created']);
  });

  it('leads are invisible across tenants', async () => {
    const { service } = makeService();
    const lead = await runWithTenant(tenantA, () =>
      service.createLead({ name: 'Secret', source: 'referral' }),
    );
    await runWithTenant(tenantB, async () => {
      expect(await service.leads.findById(lead.id)).toBeUndefined();
      expect(service.leads.list()).toHaveLength(0);
    });
  });
});
