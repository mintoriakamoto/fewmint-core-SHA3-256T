# Cook Labs

**An AI Business Operating System, built by an Autonomous Software Factory.**

Cook Labs is one platform with three connected systems:

1. **Autonomous Software Factory** — Hercules (master overseer) coordinates multiple AI coding
   systems (Claude Code, Codex via Cursor/CLI, Hermes Agent, MimoCode, Grok Build, local models)
   to build, test, review, secure, and deploy the platform itself.
2. **Universal Business OS** — the shared multi-tenant SaaS core: identity, tenancy, permissions,
   CRM, billing, scheduling, documents, communications, agents, workflows, knowledge, integrations,
   analytics, and audit.
3. **SaaS Factory** — turns the shared core into vertical industry products (Auto Repair,
   Contractors, HVAC, Towing, …) via declarative Industry Packs, so each new niche is configured,
   not rebuilt.

The model: **build the core once → create reusable modules → configure an Industry Pack →
deploy a tenant → charge subscription + usage → measure outcomes → improve → repeat.**

## This repository (current state)

This repository contains the **Cook Labs Architecture & Protocol Specification v1** — the
constitution every human and AI developer must follow — plus the beginning of **Phase 1
(Foundation)**: a TypeScript monorepo (npm workspaces) with the first foundation packages,
built and tested against the spec's contracts.

| Package | Implements |
|---|---|
| `@cooklabs/tenancy` | Fail-closed tenant context, ownership-column stamping, tenant-scoped repository base (spec 01) |
| `@cooklabs/permissions` | Deny-by-default RBAC + ABAC authorization engine (spec 02) |
| `@cooklabs/audit` | Mandatory audit record shape and append-only log (spec 02 §5) |
| `@cooklabs/events` | Event envelope validation against the normative schema, idempotent consumption (spec 05) |
| `@cooklabs/auth` | Identity types, membership-verified tenant-context establishment, role→grant resolution (spec 02) |
| `@cooklabs/ai-gateway` | Provider-independent Model Gateway: fallback chain, metering, tenant budgets, honest failure (spec 08) |
| `@cooklabs/agents` | The agent execution pipeline: typed tools, Tool Gateway credential injection, schema→authz→policy→approval gates (specs 03–04) |
| `@cooklabs/workflows` | Executable engine for the workflow DSL: versioned runs, branch/retry/approval/delay, agent steps via the pipeline (spec 06) |
| `@cooklabs/knowledge` | Tenant-scoped, permission-aware retrieval with classifications and citations; retrieved content tagged as untrusted data (specs 01 §6, 12) |
| `@cooklabs/crm` | Customers and leads: dedupe, qualification, conversion; authorized, audited, event-emitting (Phase 3) |
| `@cooklabs/scheduling` | Appointments with per-resource conflict detection; booked/cancelled events (Phase 3) |
| `@cooklabs/billing` | Invoices in integer cents with a state machine, overdue sweep, payments, and the usage ledger (Phase 3) |
| `@cooklabs/hercules` | Software Factory control plane: schema-validated task DAG, permissions ladder L1–L8 (L8 always human-gated), worker adapter seam, evidence-based routing (spec 09) |
| `@cooklabs/api` (apps/api) | HTTP surface per spec 04 §3: bearer auth, membership-verified tenant context, validation, authorization, audit, structured errors |

Postgres core schema with forced row-level security lives in `db/migrations/`; the
tenant-isolation gate (`scripts/db-isolation-test.mjs`) proves cross-tenant access is
impossible and runs in CI against a real Postgres.

**First Industry Pack:** `industries/auto` — Cook Labs Auto. Schema-validated pack, workflow,
and agent manifests; vehicle/repair-order services with the doc-13 state machine; and an
executable acceptance suite that walks the customer journey end to end (appointment →
repair order → inspection → estimate → workflow-gated approval → work → invoice → payment →
AI Service Advisor follow-up through the real agent pipeline).

Commands: `npm test` · `npm run lint` · `npm run typecheck` · `npm run build` ·
`node scripts/validate-schemas.mjs` (schema gate). CI runs the spec 11 §1 gate sequence in
[.github/workflows/ci.yml](.github/workflows/ci.yml).

## Reading the specification

Start with the overview, then read in numeric order. Documents use RFC 2119 keywords
(MUST / MUST NOT / SHOULD / MAY) for normative requirements.

| Document | Contents |
|---|---|
| [00 — Overview](docs/specifications/v1/00-overview.md) | Thesis, the three systems, master architecture, roadmap, spec governance |
| [01 — Tenancy & Data Model](docs/specifications/v1/01-tenancy-data-model.md) | Tenant hierarchy, isolation stack, core table catalog, extension rules |
| [02 — Identity & Authorization](docs/specifications/v1/02-identity-authorization.md) | RBAC + ABAC, permission matrix, agent identities, audit records |
| [03 — Agent Protocol](docs/specifications/v1/03-agent-protocol.md) | Agent object model, execution pipeline, autonomy levels L0–L5, memory |
| [04 — Tool Contract](docs/specifications/v1/04-tool-contract.md) | Typed tools, Tool Gateway, credential injection, narrow capabilities |
| [05 — Event Schema](docs/specifications/v1/05-event-schema.md) | Event envelope, delivery semantics, event catalog |
| [06 — Workflow DSL](docs/specifications/v1/06-workflow-dsl.md) | Workflow primitives, versioned definition format |
| [07 — Industry Pack Schema](docs/specifications/v1/07-industry-pack-schema.md) | Pack manifest, SaaS Factory provisioning pipeline |
| [08 — Model Gateway](docs/specifications/v1/08-model-gateway.md) | Provider-independent routing, fallback, failure honesty |
| [09 — Hercules Protocol](docs/specifications/v1/09-hercules-protocol.md) | Control database, task protocol, worker roster, routing, permissions ladder |
| [10 — Repository Structure](docs/specifications/v1/10-repository-structure.md) | Monorepo layout, module boundaries, coding standards |
| [11 — Deployment Gates](docs/specifications/v1/11-deployment-gates.md) | CI/CD gates, environments, feature flags, reliability, Definition of Done |
| [12 — Security Baseline](docs/specifications/v1/12-security-baseline.md) | Security controls, prompt-injection defense, secrets, DR, data governance |
| [13 — Auto MVP Acceptance](docs/specifications/v1/13-auto-mvp-acceptance.md) | Cook Labs Auto MVP acceptance criteria |

Supporting material:

- **Architecture Decision Records** — [docs/ADR/](docs/ADR/)
- **Machine-readable JSON Schemas** — [docs/schemas/](docs/schemas/) (event envelope, industry
  pack, agent definition, workflow, Hercules task)
- **Spec changelog** — [docs/specifications/v1/CHANGELOG.md](docs/specifications/v1/CHANGELOG.md)

## Accepted stack decisions

- **TypeScript/Node monorepo** with a React web frontend; PostgreSQL (row-level security),
  Redis, object storage ([ADR-0001](docs/ADR/0001-typescript-node-stack.md))
- **Hercules is built on the Claude Agent SDK** as its planning/reasoning core; other coding
  systems are invoked as external workers ([ADR-0002](docs/ADR/0002-hercules-on-claude-agent-sdk.md))
- **Modular monolith first**; services are extracted only on demonstrated need
  ([ADR-0003](docs/ADR/0003-modular-monolith.md))

## An honest limit

No architecture can truthfully guarantee "no errors." This design instead makes verification,
rollback, isolation, testing, approvals, observability, and recovery **mandatory**, so errors are
detected before they become customer-impacting failures whenever possible.
