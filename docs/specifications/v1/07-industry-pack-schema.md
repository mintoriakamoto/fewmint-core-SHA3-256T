# 07 — Industry Pack Schema

Spec version 1.0.0 · Status: Frozen ·
Machine-readable schema: [`industry-pack.schema.json`](../../schemas/industry-pack.schema.json)

## 1. Principle

Every vertical is defined by a declarative **Industry Pack** — configuration over code. A pack
selects core modules, adds module-owned entities, specializes agents, installs workflows and
dashboards, and wires integrations. Packs extend the Universal Business OS; they MUST NOT fork
or mutate core code or core tables ([01 §5](01-tenancy-data-model.md)).

## 2. Manifest (normative)

Packs are declared in YAML/JSON validating against
[`industry-pack.schema.json`](../../schemas/industry-pack.schema.json):

```yaml
industry: auto_repair
version: 1.0.0
modules: [crm, scheduling, estimates, inventory, invoicing]
entities: [vehicle, repair_order, inspection, technician, part]
agents: [service_advisor, diagnostic_assistant, parts_agent, retention_agent]
workflows: [appointment_to_repair, estimate_approval, maintenance_followup]
dashboards: [daily_sales, labor_utilization, average_ticket]
integrations: [accounting, payments, communications]
```

Rules:

- `industry` is a unique snake_case identifier; `version` is semver.
- Every referenced module, agent template, workflow, and dashboard MUST exist and be versioned;
  unresolved references fail validation at install time, not runtime.
- Declared entities map to module-owned tables carrying the ownership columns and RLS policies
  of [01](01-tenancy-data-model.md).
- Agents declared by a pack are agent-definition manifests ([03](03-agent-protocol.md)) and pass
  the evaluation gates before the pack ships.
- Packs targeting regulated industries MUST declare their required Compliance Pack
  ([12 §7](12-security-baseline.md)); a generic compliance claim is not acceptable.

## 3. SaaS Factory provisioning pipeline (normative)

```
INDUSTRY SPEC → Validate → Install modules → Extend schema → Configure UI
→ Install agents → Install workflows → Configure dashboards
→ Configure integrations → Seed knowledge/templates → Run tests → PROVISION SaaS
```

Provisioning MUST be idempotent and transactional per stage: a failed stage leaves a
diagnosable state and MUST NOT deliver a half-provisioned tenant as "live."

## 4. New-vertical generation workflow (target state, non-normative sequencing)

When Hercules is asked to "Create Cook Labs Towing":

1. Load towing Industry Pack requirements; 2. map against existing modules; 3. reuse (CRM,
dispatch, scheduling, billing, payments, communications, mapping); 4. identify missing modules
(tow ticket, storage lot, mileage, roadside service); 5. create architecture delta;
6. create task DAG; 7. assign parallel workers; 8. build new modules; 9. generate specialized
agents; 10. generate workflows; 11. generate dashboards; 12. run tests; 13. run security
checks; 14. deploy preview; 15. run acceptance suite; 16. present release evidence;
17. an **approved** release becomes a new Industry Pack.

All development steps run under the Hercules protocol ([09](09-hercules-protocol.md)) and the
deployment gates ([11](11-deployment-gates.md)).

## 5. Customer onboarding (normative sequence)

```
SIGN UP → Create organization → Select industry → Select plan → Provision tenant
→ Install Industry Pack → Business profile → Locations → Users + roles
→ Connect systems → Import authorized data → Configure workflows → Configure agents
→ Set autonomy limits → Knowledge ingestion → Validation → Sandbox simulation
→ Owner approval → GO LIVE
```

An onboarding AI MAY guide configuration but MUST NOT bypass security requirements, autonomy
limits, or approval steps.

## 6. Marketplace extensions

Third-party packs/agents/workflows/integrations require: permission manifest, security review,
versioning, signing, sandboxing, compatibility testing, and a **kill switch**. Marketplace
content executes under the same tool contract and permission compilation as first-party content
— there is no privileged path.
