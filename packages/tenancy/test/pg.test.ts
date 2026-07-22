import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { PgTenantRepository, runWithTenant, type TenantContext } from '@cooklabs/tenancy';
import type { OwnershipColumns } from '@cooklabs/tenancy';

// Integration test against real Postgres + RLS. Runs when DATABASE_URL is set
// (CI db-isolation job; locally against a scratch cluster). The migration and
// two-tenant seed must have been applied by scripts/db-isolation-test.mjs.
const adminUrl = process.env.DATABASE_URL;

interface LocationRow extends OwnershipColumns {
  id: string;
  name: string;
}

describe.skipIf(!adminUrl)('PgTenantRepository against real RLS', () => {
  it('inserts and reads tenant-scoped; cross-tenant reads return nothing', async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    const {
      rows: [orgA],
    } = await admin.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Adapter A') RETURNING id`,
    );
    const {
      rows: [orgB],
    } = await admin.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Adapter B') RETURNING id`,
    );
    await admin.end();

    const appUrl = new URL(adminUrl!);
    appUrl.username = 'cooklabs_app';
    appUrl.password = 'app_dev_only';
    const app = new pg.Pool({ connectionString: appUrl.toString() });
    const repo = new PgTenantRepository<LocationRow>(app, 'locations', 'locations');

    const ctxA: TenantContext = {
      tenantId: orgA!.id,
      organizationId: orgA!.id,
      actor: { id: 'user_a', type: 'user' },
    };
    const ctxB: TenantContext = {
      tenantId: orgB!.id,
      organizationId: orgB!.id,
      actor: { id: 'user_b', type: 'user' },
    };

    const inserted = await runWithTenant(ctxA, () => repo.insert({ name: 'Adapter HQ' }));
    expect(inserted.tenant_id).toBe(orgA!.id);
    expect(inserted.created_by).toBe('user_a');

    const readBack = await runWithTenant(ctxA, () => repo.findById(inserted.id));
    expect(readBack?.name).toBe('Adapter HQ');

    // Tenant B cannot see it — RLS filters at the database.
    const crossRead = await runWithTenant(ctxB, () => repo.findById(inserted.id));
    expect(crossRead).toBeUndefined();
    const listB = await runWithTenant(ctxB, () => repo.list());
    expect(listB.every((row) => row.tenant_id === orgB!.id)).toBe(true);

    // Outside a tenant context the adapter fails closed before any SQL.
    await expect(repo.findById(inserted.id)).rejects.toThrow(/tenant context/i);

    await app.end();
  });
});
