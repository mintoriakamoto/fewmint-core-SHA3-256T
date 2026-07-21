# 10 — Repository Structure

Spec version 1.0.0 · Status: Frozen

## 1. Architecture shape (normative)

Per [ADR-0003](../../ADR/0003-modular-monolith.md): **modular monolith first**, not hundreds of
microservices. Independent services are extracted only when there is a demonstrated need
(scaling, isolation, or team boundary proven by measurement).

```
                WEB / MOBILE
                     │
                API GATEWAY
                     │
       ┌─────────────┴─────────────┐
    CORE APP                  AGENT RUNTIME
       ├── Identity                ├── Orchestrator
       ├── Tenants                 ├── Model Gateway
       ├── CRM                     ├── Tool Gateway
       ├── Billing                 ├── Memory
       ├── Workflows               └── Evaluations
       ├── Industry Modules
       └── Admin
              │
    ┌─────────┼────────────┐
PostgreSQL   Redis      Object Storage
    │
Search / Vector Layer
    │
Event / Job Queue
```

Application layers: frontend → API → domain → application services → agent services →
integration adapters → data → infrastructure → observability.

## 2. Monorepo layout (normative)

Per [ADR-0001](../../ADR/0001-typescript-node-stack.md), a TypeScript monorepo:

```
cooklabs/
├── apps/
│   ├── web/            # React customer app
│   ├── admin/          # Platform administration
│   ├── api/            # HTTP API (Node/TypeScript)
│   └── workers/        # Queue/job consumers
├── packages/
│   ├── auth/  tenancy/  permissions/  billing/  crm/
│   ├── workflows/  agents/  ai-gateway/  knowledge/
│   ├── events/  integrations/  analytics/  audit/  ui/
├── industries/         # Industry Packs (auto/, contractors/, retail/, …)
├── agents/
│   ├── universal/      # Agent templates
│   └── vertical/       # Pack-specialized agents
├── integrations/       # Connector adapters
├── infrastructure/     # IaC, deployment
├── tests/
│   ├── unit/  integration/  e2e/  security/  evaluations/
├── docs/
│   ├── architecture/  ADR/  specifications/  runbooks/
└── hercules/
    ├── policies/  routing/  evaluations/  prompts/  workflows/
```

## 3. Boundary rules (normative)

- `packages/*` are the only shared-code channel; apps and industries import packages, never
  each other's internals.
- Industry Packs (`industries/*`) depend on `packages/*` and declare everything via their
  manifest ([07](07-industry-pack-schema.md)); they MUST NOT patch core packages.
- Tenancy, permissions, and audit enforcement live in their packages and are consumed —
  feature code MUST NOT reimplement them ([01](01-tenancy-data-model.md),
  [02](02-identity-authorization.md)).
- Database access goes through tenant-scoped repository abstractions in the data layer; raw SQL
  in feature code is forbidden.
- Provider-specific logic lives only in `integrations/` adapters ([04 §4](04-tool-contract.md))
  and the `ai-gateway` package ([08](08-model-gateway.md)).
- Hercules-facing config (`hercules/`) is data the factory reads — policies, routing, prompts,
  evaluations — versioned like code and reviewed like code.

## 4. Coding standards (normative)

- TypeScript `strict` mode everywhere; no `any` in exported signatures.
- Single repo-wide formatter and linter configuration; CI enforces both ([11 §1](11-deployment-gates.md)).
- Every package ships unit tests; features ship integration tests; user journeys ship e2e tests
  (`tests/` taxonomy above).
- Public package APIs are explicit exports; deep imports across package boundaries are lint
  errors.
- Migrations are forward-only with documented rollback plans ([11 §3](11-deployment-gates.md)).
- Comments state constraints the code can't express; match the surrounding style.
- All work by Software Factory agents obeys task **allowed paths** ([09 §4](09-hercules-protocol.md)).
