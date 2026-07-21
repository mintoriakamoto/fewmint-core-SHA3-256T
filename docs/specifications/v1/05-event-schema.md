# 05 — Event Schema

Spec version 1.0.0 · Status: Frozen ·
Machine-readable schema: [`event-envelope.schema.json`](../../schemas/event-envelope.schema.json)

## 1. Principle

Every important business change MUST produce an event. Events are the integration fabric
between modules, workflows, agents, and analytics — modules react to events instead of reaching
into each other's tables ([01 §5](01-tenancy-data-model.md)).

## 2. Envelope (normative)

```json
{
  "event_id": "01J9ZK3V4E8Q6W2N7R5T1XYZAB",
  "event_type": "invoice.overdue",
  "tenant_id": "org_8f2c1a",
  "entity_id": "inv_00042",
  "occurred_at": "2026-07-21T14:03:00Z",
  "schema_version": 1,
  "correlation_id": "corr_7d1e9b",
  "payload": {}
}
```

| Field | Rule |
|---|---|
| `event_id` | Globally unique, assigned once; consumers deduplicate on it. |
| `event_type` | Lowercase dot-namespaced `<domain>.<action>` (past tense or state). |
| `tenant_id` | Required; events never cross tenants. |
| `entity_id` | Primary entity the event concerns. |
| `occurred_at` | UTC, when the business fact happened (not when published). |
| `schema_version` | Integer; payload shape versioning per event type. |
| `correlation_id` | Ties together a causal chain (request → workflow → agent runs). |
| `payload` | Event-type-specific object, versioned by `schema_version`. |

## 3. Delivery semantics (normative)

Events MUST support: **idempotency** (at-least-once delivery; consumers are idempotent on
`event_id`), **retries** with backoff, **dead-letter handling** (failed events parked and
alerting, never dropped silently), **ordering where required** (per-entity ordering key when a
consumer needs it; global ordering is not promised), **schema versioning** (additive changes
bump `schema_version`; consumers tolerate unknown fields), and **traceability**
(`correlation_id` joins events to traces — [11 §5](11-deployment-gates.md)).

## 4. Initial event catalog

```
lead.created            lead.qualified          customer.created
appointment.booked      appointment.cancelled
estimate.created        estimate.approved
job.started             job.completed
invoice.created         invoice.overdue         payment.received
inventory.low           document.uploaded
agent.action.requested  agent.action.completed
vision.event.detected
```

New event types are added by module owners; each MUST document its payload per
`schema_version` alongside the owning module.

## 5. Vision events (evidence, not verdicts)

Computer-vision pipelines emit **evidence events**, correlated with business data
(inventory/POS/payments), carrying confidence and evidence references:

```
CAMERA/VIDEO → ingestion → frame/event selection → detection → tracking
→ classification → business-rule correlation → confidence → EVIDENCE EVENT
→ human review when appropriate
```

Normative framing rule: the system says **"possible discrepancy"** with confidence and evidence
(e.g. "3 tomatoes removed, no matching transaction, possible $6 discrepancy, confidence 94%,
video timestamp attached"). It MUST NOT assert accusations ("this person stole"). AI evidence
must remain reviewable by humans.
