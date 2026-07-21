# 13 — Cook Labs Auto: MVP Acceptance Criteria

Spec version 1.0.0 · Status: Frozen

Cook Labs Auto is the first vertical (Phase 5). **Do not call it MVP if the core customer
journey cannot complete reliably.** These criteria are the acceptance suite Hercules runs
before any release claim ([11 §7](11-deployment-gates.md)).

## 1. End-to-end journey (all steps MUST complete)

Each step below must be demonstrable in staging by a non-developer, with data flowing to the
next step, correct tenant scoping, and audit records present.

| # | Step | Pass condition |
|---|---|---|
| 1 | Business signup | New org provisioned with Auto Industry Pack installed ([07 §3](07-industry-pack-schema.md)) |
| 2 | Organization setup | Locations, roles configured; RBAC enforced ([02](02-identity-authorization.md)) |
| 3 | Employees | Users invited, assigned roles (Owner, Service Advisor, Technician) |
| 4 | Customer created | CRM record with contacts; dedupe works |
| 5 | Vehicle | Vehicle attached to customer incl. VIN capture |
| 6 | Appointment | Booked, rescheduled, cancelled; `appointment.booked` event emitted ([05](05-event-schema.md)) |
| 7 | Repair order | Created from appointment with complaint intake |
| 8 | Inspection | Technician records results, uploads photos (permission-scoped) |
| 9 | Estimate | Line items, tax, totals correct; `estimate.created` emitted |
| 10 | Approval | Customer approval captured; `estimate.approved` emitted; state transition audited |
| 11 | Work status | Technician assignment; status progresses started → completed |
| 12 | Invoice | Generated from approved estimate; `invoice.created` emitted |
| 13 | Payment state | Payment recorded; `payment.received` emitted; overdue transition works |
| 14 | Follow-up | Post-service follow-up sent through the workflow engine ([06](06-workflow-dsl.md)) |
| 15 | Analytics | Dashboard shows the journey's metrics from real event data |

## 2. Required AI capabilities

Each agent MUST pass the evaluation gates of [03 §7](03-agent-protocol.md) before the MVP
claim:

| Capability | Acceptance |
|---|---|
| **AI Service Advisor** | Handles an inbound customer conversation, books an appointment, drafts an estimate explanation; all actions via typed tools at ≤ its configured autonomy level |
| **AI Lead Follow-up** | Detects neglected leads, executes the follow-up workflow, respects contact quotas and approval gates |
| **AI Management Summary** | Produces a daily owner summary grounded in tenant data with citations to underlying records |
| **Private knowledge** | Tenant documents ingested ([01 §6](01-tenancy-data-model.md)); agent answers cite them; cross-tenant retrieval provably impossible |

## 3. Platform requirements in scope for MVP

- **Audit logs** — every step above produces the [02 §5](02-identity-authorization.md) record.
- **Permissions** — the Technician-vs-Owner matrix is enforced and tested (positive and
  negative cases).
- **Workflow automation** — at least `appointment_to_repair`, `estimate_approval`, and
  `maintenance_followup` run as versioned workflows.
- **Usage/billing** — model usage metered per tenant through the Model Gateway
  ([08 §5](08-model-gateway.md)); a subscription with plan entitlements is enforced.
- **Tenant isolation** — the [11 §1](11-deployment-gates.md) isolation suite passes against
  Auto tables.

## 4. Key metrics instrumented (reporting available at MVP)

Average repair order · labor utilization · technician efficiency · parts margin · estimate
approval rate · comeback rate · lead conversion · customer retention · bay utilization ·
revenue per available hour.

## 5. Explicit non-goals for MVP

Parts-supplier integrations beyond one reference connector, multi-location analytics rollups,
marketplace, custom agent builder UI, and non-English localization are out of scope — deferred
per the roadmap ([00 §6](00-overview.md)).
