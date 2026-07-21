-- 0001_core.sql — core tenant schema with row-level security (spec 01).
-- Forward-only. Rollback plan: drop the objects created here (dev/staging only);
-- production rollback is a restore, never a destructive down-migration.
--
-- The application connects as the non-superuser role cooklabs_app and sets
-- the tenant per transaction:  SET LOCAL app.tenant_id = '<tenant uuid>';
-- RLS policies key on that setting. FORCE ROW LEVEL SECURITY ensures even the
-- table owner is subject to the policies. See db/README.md.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Application role: no BYPASSRLS, no superuser (spec 01 §3).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cooklabs_app') THEN
    CREATE ROLE cooklabs_app LOGIN PASSWORD 'app_dev_only';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  -- Empty string (a set-then-cleared session GUC) is treated as no context.
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Tenant registry (not itself tenant-scoped; app role gets no direct access).
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  industry    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Global identity registry (users can belong to many orgs via memberships).
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tenant-scoped tables. Every one carries the required ownership columns
-- (spec 01 §2) and composite-keyed references so rows can never point across
-- tenants (spec 01 §2: no cross-tenant FKs).
-- ---------------------------------------------------------------------------

CREATE TABLE locations (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations (id),
  organization_id uuid NOT NULL,
  name            text NOT NULL,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT locations_same_tenant CHECK (organization_id = tenant_id)
);

CREATE TABLE memberships (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations (id),
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id),
  roles           text[] NOT NULL DEFAULT '{}',
  location_id     uuid,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES locations (tenant_id, id),
  CONSTRAINT memberships_same_tenant CHECK (organization_id = tenant_id)
);

CREATE TABLE roles (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations (id),
  organization_id uuid NOT NULL,
  name            text NOT NULL,
  grants          jsonb NOT NULL DEFAULT '[]',
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name),
  CONSTRAINT roles_same_tenant CHECK (organization_id = tenant_id)
);

-- Append-only audit (spec 02 §5): the app role can INSERT and SELECT its
-- tenant's records; UPDATE/DELETE are not granted to anyone but the owner.
CREATE TABLE audit_logs (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations (id),
  organization_id uuid NOT NULL,
  location_id     uuid,
  actor_id        text NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     text,
  permission      text NOT NULL,
  reason          text NOT NULL,
  result          text NOT NULL CHECK (result IN ('success', 'denied', 'failed')),
  approval        text,
  model_tool      text,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT audit_logs_same_tenant CHECK (organization_id = tenant_id)
);

-- Event store (spec 05): envelope columns + payload; unique event_id gives
-- consumers their idempotency anchor.
CREATE TABLE events (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES organizations (id),
  organization_id uuid NOT NULL,
  event_id        text NOT NULL UNIQUE,
  event_type      text NOT NULL,
  entity_id       text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  schema_version  integer NOT NULL DEFAULT 1,
  correlation_id  text,
  ordering_key    text,
  payload         jsonb NOT NULL DEFAULT '{}',
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT events_same_tenant CHECK (organization_id = tenant_id)
);

CREATE INDEX events_type_idx ON events (tenant_id, event_type, occurred_at);
CREATE INDEX audit_logs_actor_idx ON audit_logs (tenant_id, actor_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security: enabled AND forced on every tenant table; a single
-- tenant-match policy per table keyed on app.tenant_id (spec 01 §3).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['locations','memberships','roles','audit_logs','events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
      t
    );
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO cooklabs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON locations, memberships, roles TO cooklabs_app;
GRANT SELECT, INSERT ON audit_logs, events TO cooklabs_app; -- append-only surfaces
-- No grant on organizations/users: the app reaches them through definer-owned
-- functions added when the identity module lands; tenant tables only for now.

COMMIT;
