import { describe, expect, it } from 'vitest';
import {
  NoMembershipError,
  RoleRegistry,
  UnknownRoleError,
  establishTenantContext,
  resolveGrants,
  type AuthenticatedSession,
} from '@cooklabs/auth';
import { authorize } from '@cooklabs/permissions';
import { getTenantContext, runWithTenant } from '@cooklabs/tenancy';
import { InMemoryAuditLog, buildAuditRecord } from '@cooklabs/audit';

const session: AuthenticatedSession = {
  identity: { type: 'user', id: 'user_1', email: 'tech@example.com', mfaVerified: true },
  memberships: [
    {
      identityId: 'user_1',
      organizationId: 'org_a',
      roles: ['technician'],
      locationIds: ['loc_1'],
    },
  ],
};

describe('establishTenantContext', () => {
  it('derives the tenant from a verified membership', () => {
    const { context, membership } = establishTenantContext(session, 'org_a');
    expect(context.tenantId).toBe('org_a');
    expect(context.actor).toEqual({ id: 'user_1', type: 'user' });
    expect(membership.roles).toContain('technician');
  });

  it('rejects organizations the session does not belong to', () => {
    expect(() => establishTenantContext(session, 'org_b')).toThrow(NoMembershipError);
  });

  it('rejects locations outside the membership scope', () => {
    expect(() => establishTenantContext(session, 'org_a', 'loc_999')).toThrow(NoMembershipError);
  });
});

describe('role resolution', () => {
  const registry = new RoleRegistry();
  registry.register({
    name: 'technician',
    grants: [
      {
        resource: 'repair_orders',
        actions: ['read', 'list'],
        conditions: { assigned_to: '$actor.id' },
      },
    ],
  });

  it('fails closed on unknown roles', () => {
    expect(() => resolveGrants(['ghost_role'], registry)).toThrow(UnknownRoleError);
  });

  it('login → context → authorize → audit, end to end', async () => {
    const audit = new InMemoryAuditLog();
    const { context, membership } = establishTenantContext(session, 'org_a', 'loc_1');
    const grants = resolveGrants(membership.roles, registry);

    await runWithTenant(context, async () => {
      const ctx = getTenantContext();
      const decision = authorize({
        grants,
        resource: 'repair_orders',
        action: 'read',
        actorId: ctx.actor.id,
        attributes: { assigned_to: 'user_1' },
      });
      expect(decision.allowed).toBe(true);

      const denied = authorize({
        grants,
        resource: 'customers',
        action: 'export',
        actorId: ctx.actor.id,
      });
      expect(denied.allowed).toBe(false);

      await audit.append(
        buildAuditRecord({
          actor: ctx.actor,
          tenant_id: ctx.tenantId,
          action: 'customers.export',
          resource: { type: 'customers' },
          permission: 'export:customers',
          reason: denied.reason,
          result: 'denied',
        }),
      );
    });

    expect(audit.forTenant('org_a')).toHaveLength(1);
    expect(audit.forTenant('org_a')[0]?.result).toBe('denied');
  });
});
