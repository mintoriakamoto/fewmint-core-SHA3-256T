# Database

Postgres core schema for the Universal Business OS. Governed by
[spec 01 — Tenancy & Data Model](../docs/specifications/v1/01-tenancy-data-model.md).

## Layout

- `migrations/` — forward-only SQL migrations, applied in filename order.

## Tenant isolation model

- Every tenant table carries the required ownership columns (`tenant_id`,
  `organization_id`, `created_by`, `created_at`, `updated_at`, plus
  `location_id` where location-scoped) and a **composite primary key
  `(tenant_id, id)`** so all intra-tenant references are composite FKs —
  cross-tenant references are structurally impossible.
- **Row-level security is enabled and forced** on every tenant table with a
  single `tenant_isolation` policy: `tenant_id = current_tenant_id()`.
- `current_tenant_id()` reads the `app.tenant_id` session setting. The
  application (via `@cooklabs/tenancy` context) sets it per transaction:

  ```sql
  BEGIN;
  SET LOCAL app.tenant_id = '<tenant uuid>';
  -- tenant-scoped statements…
  COMMIT;
  ```

  With no setting present, `current_tenant_id()` is NULL and every policy
  comparison fails — **no tenant context means no rows** (fail closed).
- The application connects as `cooklabs_app`: no superuser, no `BYPASSRLS`,
  and only `INSERT`/`SELECT` on the append-only tables (`audit_logs`,
  `events`).

## Verification

`scripts/db-isolation-test.mjs` applies the migrations to a scratch database
and proves, as the app role: rows inserted for tenant A are invisible under
tenant B's context, invisible with no context, and cannot be written across
tenants. CI runs it against a Postgres service container (`db-isolation` job).

Run locally: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node scripts/db-isolation-test.mjs`
