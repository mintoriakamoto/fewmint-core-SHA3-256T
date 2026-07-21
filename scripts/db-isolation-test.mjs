// Tenant-isolation gate (spec 11 §1): applies db/migrations to the database at
// DATABASE_URL (admin credentials), then proves as the non-superuser app role
// that RLS makes cross-tenant access impossible.
// Run: DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node scripts/db-isolation-test.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('DATABASE_URL not set; skipping is not allowed in CI — failing.');
  process.exit(1);
}

const results = [];
function assert(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();

// Apply migrations in filename order.
for (const file of readdirSync(join(ROOT, 'db', 'migrations')).sort()) {
  await admin.query(readFileSync(join(ROOT, 'db', 'migrations', file), 'utf8'));
  console.log(`applied ${file}`);
}

// Seed two tenants (admin has direct access; the app role does not).
const {
  rows: [orgA],
} = await admin.query(`INSERT INTO organizations (name) VALUES ('Tenant A') RETURNING id`);
const {
  rows: [orgB],
} = await admin.query(`INSERT INTO organizations (name) VALUES ('Tenant B') RETURNING id`);

// Connect as the app role.
const url = new URL(adminUrl);
url.username = 'cooklabs_app';
url.password = 'app_dev_only';
const app = new pg.Client({ connectionString: url.toString() });
await app.connect();

async function inTenant(client, tenantId, fn) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    return await fn();
  } finally {
    await client.query('COMMIT').catch(() => client.query('ROLLBACK'));
  }
}

// 1. Each tenant writes its own row through the app role.
await inTenant(app, orgA.id, () =>
  app.query(
    `INSERT INTO locations (tenant_id, organization_id, name, created_by)
     VALUES ($1, $1, 'A main', 'test')`,
    [orgA.id],
  ),
);
await inTenant(app, orgB.id, () =>
  app.query(
    `INSERT INTO locations (tenant_id, organization_id, name, created_by)
     VALUES ($1, $1, 'B main', 'test')`,
    [orgB.id],
  ),
);

// 2. Tenant B sees only its own rows.
const bRows = await inTenant(app, orgB.id, () => app.query('SELECT name FROM locations'));
assert(
  'tenant B sees only its own locations',
  bRows.rows.length === 1 && bRows.rows[0].name === 'B main',
  JSON.stringify(bRows.rows),
);

// 3. No tenant context → no rows (fail closed).
await app.query('BEGIN');
const noCtx = await app.query('SELECT count(*)::int AS n FROM locations');
await app.query('COMMIT');
assert('no tenant context returns zero rows', noCtx.rows[0].n === 0, `n=${noCtx.rows[0].n}`);

// 4. Cross-tenant write is rejected by the policy WITH CHECK.
let crossWriteBlocked = false;
try {
  await inTenant(app, orgA.id, () =>
    app.query(
      `INSERT INTO locations (tenant_id, organization_id, name, created_by)
       VALUES ($1, $1, 'sneaky', 'test')`,
      [orgB.id],
    ),
  );
} catch {
  crossWriteBlocked = true;
}
assert('cross-tenant INSERT is rejected', crossWriteBlocked);

// 5. Audit log is append-only for the app role.
await inTenant(app, orgA.id, () =>
  app.query(
    `INSERT INTO audit_logs (tenant_id, organization_id, actor_id, actor_type, action,
       resource_type, permission, reason, result, created_by)
     VALUES ($1, $1, 'user_1', 'user', 'x', 'y', 'p', 'r', 'success', 'test')`,
    [orgA.id],
  ),
);
let auditUpdateBlocked = false;
try {
  await inTenant(app, orgA.id, () => app.query(`UPDATE audit_logs SET reason = 'tampered'`));
} catch {
  auditUpdateBlocked = true;
}
assert('audit_logs UPDATE denied for app role', auditUpdateBlocked);

// 6. App role has no direct access to the tenant registry.
let registryBlocked = false;
try {
  await app.query('SELECT * FROM organizations');
} catch {
  registryBlocked = true;
}
assert('app role cannot read organizations directly', registryBlocked);

await app.end();
await admin.end();

if (results.some((r) => !r.ok)) {
  console.error('\nTenant-isolation gate FAILED');
  process.exit(1);
}
console.log('\nTenant-isolation gate passed');
