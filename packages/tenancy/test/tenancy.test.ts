import { describe, expect, it } from 'vitest';
import {
  CrossTenantAccessError,
  ImmutableTenantError,
  MissingTenantContextError,
  TenantScopedRepository,
  getTenantContext,
  runWithTenant,
  stampCreate,
  stampUpdate,
  tryGetTenantContext,
  type OwnershipColumns,
  type TenantContext,
} from '@cooklabs/tenancy';

const ctxA: TenantContext = {
  tenantId: 'org_a',
  organizationId: 'org_a',
  actor: { id: 'user_1', type: 'user' },
};

describe('tenant context', () => {
  it('fails closed outside a tenant context', () => {
    expect(() => getTenantContext()).toThrow(MissingTenantContextError);
    expect(tryGetTenantContext()).toBeUndefined();
  });

  it('propagates through sync and async execution', async () => {
    const seen = runWithTenant(ctxA, () => getTenantContext().tenantId);
    expect(seen).toBe('org_a');
    const seenAsync = await runWithTenant(ctxA, async () => {
      await Promise.resolve();
      return getTenantContext().tenantId;
    });
    expect(seenAsync).toBe('org_a');
  });

  it('rejects incomplete contexts', () => {
    expect(() => runWithTenant({ ...ctxA, tenantId: '' }, () => undefined)).toThrow();
  });
});

describe('ownership stamping', () => {
  it('stamps tenant columns from context, never from input', () => {
    const rec = runWithTenant(ctxA, () => stampCreate({ name: 'Ada' }));
    expect(rec.tenant_id).toBe('org_a');
    expect(rec.organization_id).toBe('org_a');
    expect(rec.created_by).toBe('user_1');
    expect(rec.location_id).toBeNull();
    expect(rec.created_at).toBe(rec.updated_at);
  });

  it('refuses to move records across tenants on update', () => {
    const rec = runWithTenant(ctxA, () => stampCreate({ name: 'Ada' }));
    runWithTenant(ctxA, () => {
      expect(() => stampUpdate(rec, { tenant_id: 'org_b' })).toThrow(ImmutableTenantError);
    });
    const ctxB: TenantContext = { ...ctxA, tenantId: 'org_b', organizationId: 'org_b' };
    runWithTenant(ctxB, () => {
      expect(() => stampUpdate(rec, {})).toThrow(ImmutableTenantError);
    });
  });
});

interface Customer extends OwnershipColumns {
  id: string;
  name: string;
}

class LeakyStore extends TenantScopedRepository<Customer> {
  constructor(private readonly rows: Customer[]) {
    super('customers');
  }
  protected fetchById(_tenantId: string, id: string): Promise<Customer | undefined> {
    // Deliberately ignores tenantId to simulate a buggy adapter.
    return Promise.resolve(this.rows.find((r) => r.id === id));
  }
}

describe('tenant-scoped repository', () => {
  it('re-asserts tenant scope even when the adapter is buggy', async () => {
    const foreign: Customer = {
      id: 'c1',
      name: 'Foreign',
      tenant_id: 'org_b',
      organization_id: 'org_b',
      location_id: null,
      created_by: 'user_9',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const repo = new LeakyStore([foreign]);
    await runWithTenant(ctxA, async () => {
      await expect(repo.findById('c1')).rejects.toThrow(CrossTenantAccessError);
    });
  });
});
