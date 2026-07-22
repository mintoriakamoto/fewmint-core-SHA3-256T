import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer, type ApiDeps } from '@cooklabs/api';
import { InMemoryAuditLog } from '@cooklabs/audit';
import { RoleRegistry, type AuthenticatedSession } from '@cooklabs/auth';
import { BillingService } from '@cooklabs/billing';
import { CrmService } from '@cooklabs/crm';
import type { EventEnvelope } from '@cooklabs/events';
import { SchedulingService } from '@cooklabs/scheduling';
import type { Grant } from '@cooklabs/permissions';

const platformGrants: Grant[] = [
  { resource: 'customers', actions: ['create', 'read', 'list'] },
  { resource: 'leads', actions: ['create', 'update', 'read', 'list'] },
  { resource: 'appointments', actions: ['create', 'update', 'read', 'list'] },
  { resource: 'invoices', actions: ['create', 'update', 'read', 'list'] },
];

const sessions: Record<string, AuthenticatedSession> = {
  'token-owner': {
    identity: { type: 'user', id: 'user_owner', email: 'o@x.com', mfaVerified: true },
    memberships: [{ identityId: 'user_owner', organizationId: 'org_a', roles: ['owner'] }],
  },
  'token-tech': {
    identity: { type: 'user', id: 'user_tech', email: 't@x.com', mfaVerified: true },
    memberships: [{ identityId: 'user_tech', organizationId: 'org_a', roles: ['technician'] }],
  },
};

const roles = new RoleRegistry();
roles.register({
  name: 'owner',
  grants: [
    { resource: 'customers', actions: ['create', 'read', 'list'] },
    { resource: 'appointments', actions: ['create', 'read', 'list'] },
    { resource: 'invoices', actions: ['create', 'read', 'list'] },
  ],
});
roles.register({
  name: 'technician',
  grants: [{ resource: 'appointments', actions: ['read', 'list'] }],
});

const audit = new InMemoryAuditLog();
const events: EventEnvelope[] = [];
const serviceDeps = {
  grants: platformGrants,
  audit,
  publish: (e: EventEnvelope) => events.push(e),
};

const deps: ApiDeps = {
  resolveToken: (token) => sessions[token],
  roles,
  audit,
  crm: new CrmService(serviceDeps),
  scheduling: new SchedulingService(serviceDeps),
  billing: new BillingService(serviceDeps),
};

const server = createApiServer(deps);
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));

function post(path: string, body: unknown, token?: string, org = 'org_a') {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      'x-organization-id': org,
    },
    body: JSON.stringify(body),
  });
}

describe('api surface (spec 04 §3)', () => {
  it('health is open', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('401 without a valid bearer token', async () => {
    const res = await post('/customers', { name: 'Ada' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string }; request_id: string };
    expect(body.error.code).toBe('unauthenticated');
    expect(body.request_id).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBe(body.request_id);
  });

  it('403 for an org the session has no membership in', async () => {
    const res = await post('/customers', { name: 'Ada' }, 'token-owner', 'org_other');
    expect(res.status).toBe(403);
  });

  it('creates a customer; tenant_id in the body is ignored', async () => {
    const res = await post(
      '/customers',
      { name: 'Ada', email: 'ada@x.com', tenant_id: 'org_evil' },
      'token-owner',
    );
    expect(res.status).toBe(201);
    const customer = (await res.json()) as { tenant_id: string; id: string };
    expect(customer.tenant_id).toBe('org_a'); // from verified membership, not body
    expect(events.at(-1)?.event_type).toBe('customer.created');
  });

  it('validation failures return structured 400s with details', async () => {
    const res = await post('/customers', { email: 'no-name@x.com' }, 'token-owner');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: string[] } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.join(' ')).toContain('name');
  });

  it("denies a technician's customer creation and audits the denial", async () => {
    const before = audit.forTenant('org_a').length;
    const res = await post('/customers', { name: 'Nope' }, 'token-tech');
    expect(res.status).toBe(403);
    const trail = audit.forTenant('org_a');
    expect(trail.length).toBe(before + 1);
    expect(trail.at(-1)?.result).toBe('denied');
    expect(trail.at(-1)?.actor.id).toBe('user_tech');
  });

  it('domain conflicts map to 409', async () => {
    const first = await post(
      '/appointments',
      {
        customer_id: 'c1',
        resource_id: 'bay_9',
        starts_at: '2026-08-05T09:00:00Z',
        ends_at: '2026-08-05T10:00:00Z',
      },
      'token-owner',
    );
    expect(first.status).toBe(201);
    const clash = await post(
      '/appointments',
      {
        customer_id: 'c2',
        resource_id: 'bay_9',
        starts_at: '2026-08-05T09:30:00Z',
        ends_at: '2026-08-05T10:30:00Z',
      },
      'token-owner',
    );
    expect(clash.status).toBe(409);
  });

  it('invoices reject float money with a 500-free structured error', async () => {
    const res = await post(
      '/invoices',
      { customer_id: 'c1', lines: [{ description: 'x', quantity: 1, unit_price_cents: 9.99 }] },
      'token-owner',
    );
    expect(res.status).toBe(400); // schema catches non-integer before the service
  });

  it('unknown routes are structured 404s', async () => {
    const res = await post('/nope', {}, 'token-owner');
    expect(res.status).toBe(404);
  });
});
