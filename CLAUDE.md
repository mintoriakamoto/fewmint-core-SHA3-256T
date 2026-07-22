# Cook Labs — agent guide

This repository is governed by the **Cook Labs Architecture & Protocol Specification v1**
(`docs/specifications/v1/`). It is the constitution: deviations found in code are defects, not
precedents. Read `docs/specifications/v1/00-overview.md` first; ADRs live in `docs/ADR/`.

## Layout

- `packages/*` — foundation packages (TypeScript, npm workspaces): `tenancy`, `permissions`,
  `audit`, `events`, `auth`, `ai-gateway`, `agents`, `workflows`, `knowledge`, `crm`,
  `scheduling`, `billing`, `comms` (blackboard + agent message bus, spec 14), `hercules`.
  Shared code moves only through packages (spec 10 §3).
- `industries/*` — Industry Packs. `industries/auto` is the first: pack manifest, workflow and
  agent manifests (schema-validated), auto domain services, and the doc-13 acceptance suite.
- `apps/api` — HTTP surface (node:http): auth → membership-verified tenant context → validation
  → authorize → audit → structured errors. `packages/hercules` — the Software Factory control
  plane (task DAG, permissions ladder L1–L8, worker adapters, evidence-based routing).
- `db/migrations/` — forward-only SQL migrations; every tenant table has forced RLS. The
  isolation gate is `scripts/db-isolation-test.mjs` (needs `DATABASE_URL`; CI runs it against
  a Postgres service).
- `docs/schemas/*.schema.json` — normative JSON Schemas (draft 2020-12). If prose and schema
  disagree, the schema wins.
- `scripts/validate-schemas.mjs` — compiles all schemas and validates the examples embedded in
  the spec docs; runs in CI.

## Commands

- `npm test` — vitest across all packages
- `npm run lint` / `npm run format:check` / `npm run typecheck` / `npm run build`
- `node scripts/validate-schemas.mjs` — schema gate

## Hard rules (from the spec)

- Never accept `tenant_id` from client input; it comes from `@cooklabs/tenancy` context.
  Tenant-scoped code outside a context must fail closed.
- Authorization goes through `@cooklabs/permissions` (`authorize`) — deny by default; never
  hand-roll checks.
- Every action (including denials) produces an `@cooklabs/audit` record.
- Events must validate against the envelope schema; consumers are idempotent on `event_id`.
- No raw SQL in feature code; no provider-specific logic outside adapters; no secrets in code,
  prompts, or logs.
- Nothing is "done" because an agent says so — the Definition of Done is spec 11 §7.
