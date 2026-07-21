# 01 — Tenancy & Data Model

Spec version 1.0.0 · Status: Frozen

## 1. Platform hierarchy

```
Cook Labs Platform
│
├── Organization
│   ├── Business Unit
│   │   ├── Location
│   │   ├── Department
│   │   └── Team
│   ├── Users
│   ├── Customers
│   ├── Agents
│   ├── Workflows
│   ├── Integrations
│   ├── Knowledge
│   └── Data
```

An **Organization** is the tenant boundary. Business units, locations, departments, and teams
are scoping structures *within* a tenant, never across tenants.

## 2. Required ownership columns (normative)

Every tenant-sensitive record MUST carry:

| Column | Rule |
|---|---|
| `tenant_id` | Required. Immutable after creation. FK to the tenant registry. |
| `organization_id` | Required (equals `tenant_id` in v1; kept distinct for future sub-org models). |
| `location_id` | Required where the entity is location-scoped; nullable otherwise. |
| `created_by` | Required. References a user **or agent** identity (see [02](02-identity-authorization.md)). |
| `created_at` / `updated_at` | Required. UTC timestamps, set server-side. |

Rules:

- Application code MUST NOT accept `tenant_id` from client input; it MUST be derived from the
  authenticated session context.
- Cross-tenant foreign keys MUST NOT exist. Any reference between rows MUST be provably
  same-tenant (composite FK including `tenant_id`, or RLS-enforced).

## 3. The isolation stack (normative)

Isolation MUST exist at every one of these layers. A missing frontend filter MUST NOT be able
to expose another company's information — the lower layers are the guarantee.

```
Authentication → Authorization → Tenant context → Database policies (RLS)
→ Application validation → Storage isolation → Vector/search isolation
→ Encryption → Audit
```

| Layer | Requirement |
|---|---|
| Authentication | Every request authenticated; no anonymous data paths to tenant data. |
| Authorization | RBAC + ABAC checks per [02](02-identity-authorization.md). |
| Tenant context | A single middleware establishes tenant context per request; queries outside a tenant context MUST fail closed. |
| Database policies | PostgreSQL **row-level security** enabled on every tenant table; policies keyed on session tenant context. Superuser/bypass roles MUST NOT be used by application code. |
| Application validation | Repository layer re-asserts tenant scope; raw SQL access from feature code is forbidden (see [10](10-repository-structure.md)). |
| Storage isolation | Object storage keys prefixed by tenant; signed URLs scoped and short-lived. |
| Vector/search isolation | Every embedding/search document carries `tenant_id`; all queries filter on it at the index level, not post-filter. |
| Encryption | TLS in transit; encryption at rest; per [12](12-security-baseline.md). |
| Audit | Every read/write of restricted data auditable per [02 §5](02-identity-authorization.md). |

Tenant-isolation tests are a **required CI gate** ([11](11-deployment-gates.md)) — automated
tests MUST attempt cross-tenant access at the API, database, storage, and search layers and
prove denial.

## 4. Core table catalog

The Universal Business OS owns these core domains. Names are canonical; migrations MUST use them.

```
organizations, locations, users, memberships, roles, permissions,
customers, contacts, leads, opportunities, tasks, appointments,
agents, agent_versions, agent_tools, agent_permissions, agent_runs,
workflows, workflow_versions, workflow_runs,
events, documents, knowledge_sources, knowledge_chunks,
integrations, integration_accounts, sync_jobs,
subscriptions, entitlements, usage_records, invoices,
notifications, audit_logs, industry_modules, module_installations
```

## 5. Vertical extension rules (normative)

Vertical products extend the core; they MUST NOT mutate it.

- Verticals add **module-owned tables** (e.g. Auto: `vehicles`, `repair_orders`, `inspections`,
  `technicians`, `parts`, `labor_operations`), each carrying the required ownership columns and
  RLS policies.
- Arbitrary customer- or vertical-specific columns MUST NOT be added to core tables. Extension
  data lives in module tables (or a module-owned extension schema) keyed to the core entity.
- Module tables are declared by the module's Industry Pack manifest ([07](07-industry-pack-schema.md))
  and installed via `module_installations`.
- A module MUST NOT read another module's tables directly; cross-module access goes through the
  owning module's service interface or events ([05](05-event-schema.md)).

## 6. Knowledge & private company intelligence

Customer information flows through controlled ingestion:

```
Documents / Manuals / SOPs / Catalogs / Pricing / Contracts /
Authorized Emails / Customer Records / Historical Jobs / Databases / Policies
   ↓ INGESTION
Malware & file validation → Parsing/OCR → Classification →
PII/security handling → Chunking → Metadata → Embeddings → Hybrid index
   ↓                                   (vector + keyword)
RAG → AI RESPONSE → CITATIONS
```

Normative rules:

- Ingestion MUST validate files (type, size, malware scan) before parsing.
- Every `knowledge_chunk` MUST carry `tenant_id`, source provenance, classification
  ([12 §6](12-security-baseline.md)), and permissions metadata; retrieval MUST be
  permission-aware (an agent or user only retrieves chunks they are authorized to read).
- AI responses grounded in knowledge SHOULD cite their sources.
- **RAG first.** Fine-tuning MAY be used only where evaluations demonstrate a real advantage;
  it is not a replacement for a current knowledge system, because company facts change.

## 7. Memory data model (agents)

Agent memory is scoped storage, not a growing chat log (behavioral rules in
[03 §6](03-agent-protocol.md)). Every memory record MUST carry:

`scope` (working | conversation | entity | organizational | procedural | learned) ·
`tenant_id` · `provenance` · `timestamp` · `confidence` · `permissions` · `retention` · `version`
