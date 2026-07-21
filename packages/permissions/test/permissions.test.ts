import { describe, expect, it } from 'vitest';
import { authorize, type Role } from '@cooklabs/permissions';

// The technician example from spec 02 §1.
const technician: Role = {
  name: 'technician',
  grants: [
    {
      resource: 'repair_orders',
      actions: ['read', 'list'],
      conditions: { assigned_to: '$actor.id' },
    },
    { resource: 'inspections', actions: ['create', 'update'] },
    { resource: 'photos', actions: ['create'] },
  ],
};

describe('authorize (deny by default)', () => {
  it('denies anything without a grant', () => {
    const d = authorize({
      grants: technician.grants,
      resource: 'payroll',
      action: 'read',
      actorId: 'tech_1',
    });
    expect(d.allowed).toBe(false);
  });

  it('treats export as distinct from read', () => {
    const d = authorize({
      grants: technician.grants,
      resource: 'repair_orders',
      action: 'export',
      actorId: 'tech_1',
      attributes: { assigned_to: 'tech_1' },
    });
    expect(d.allowed).toBe(false);
  });

  it('allows viewing an assigned repair order', () => {
    const d = authorize({
      grants: technician.grants,
      resource: 'repair_orders',
      action: 'read',
      actorId: 'tech_1',
      attributes: { assigned_to: 'tech_1' },
    });
    expect(d.allowed).toBe(true);
    expect(d.matchedGrant?.resource).toBe('repair_orders');
  });

  it("denies another technician's repair order", () => {
    const d = authorize({
      grants: technician.grants,
      resource: 'repair_orders',
      action: 'read',
      actorId: 'tech_1',
      attributes: { assigned_to: 'tech_2' },
    });
    expect(d.allowed).toBe(false);
  });

  it('denies when a conditioned attribute is missing (fail closed)', () => {
    const d = authorize({
      grants: technician.grants,
      resource: 'repair_orders',
      action: 'read',
      actorId: 'tech_1',
    });
    expect(d.allowed).toBe(false);
  });

  it('supports threshold operators for approval-style rules', () => {
    const grants = [
      {
        resource: 'refunds',
        actions: ['approve'] as const,
        conditions: { amount: { op: 'lte', value: 500 } as const },
      },
    ];
    expect(
      authorize({
        grants,
        resource: 'refunds',
        action: 'approve',
        actorId: 'mgr',
        attributes: { amount: 400 },
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        grants,
        resource: 'refunds',
        action: 'approve',
        actorId: 'mgr',
        attributes: { amount: 900 },
      }).allowed,
    ).toBe(false);
  });

  it('supports the in operator', () => {
    const grants = [
      {
        resource: 'jobs',
        actions: ['update'] as const,
        conditions: { status: { op: 'in', value: ['draft', 'scheduled'] } as const },
      },
    ];
    expect(
      authorize({
        grants,
        resource: 'jobs',
        action: 'update',
        actorId: 'u',
        attributes: { status: 'draft' },
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        grants,
        resource: 'jobs',
        action: 'update',
        actorId: 'u',
        attributes: { status: 'done' },
      }).allowed,
    ).toBe(false);
  });
});
