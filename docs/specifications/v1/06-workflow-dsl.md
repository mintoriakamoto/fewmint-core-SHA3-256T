# 06 — Workflow DSL

Spec version 1.0.0 · Status: Frozen ·
Machine-readable schema: [`workflow.schema.json`](../../schemas/workflow.schema.json)

## 1. Principle

Agents and deterministic automation work together. Deterministic steps (routing, thresholds,
delays, CRUD) are workflow logic; judgment steps invoke agents. Behind any builder UI is a
**versioned workflow definition — not arbitrary generated code.**

## 2. Primitives (normative)

A workflow is a directed graph of steps drawn from exactly these primitive types:

| Primitive | Purpose |
|---|---|
| `trigger` | Event ([05](05-event-schema.md)), schedule, or manual start |
| `condition` | Boolean expression over context |
| `branch` | Route on condition/value |
| `loop` | Bounded iteration (MUST have an upper bound) |
| `delay` | Wait for duration or until timestamp |
| `human_approval` | Block until an authorized human approves/rejects |
| `agent_action` | Invoke an agent ([03](03-agent-protocol.md)) with a defined goal & budget |
| `api_action` | Invoke a typed tool/connector action ([04](04-tool-contract.md)) |
| `database_action` | Module-service data operation (never raw SQL) |
| `notification` | Notify users/channels |
| `webhook` | Outbound webhook |
| `transformation` | Pure data mapping |
| `retry` | Retry policy wrapper (attempts, backoff) |
| `compensation` | Rollback/compensating action for a failed step |
| `end` | Terminal state (success / failure / cancelled) |

## 3. Definition format (normative)

Workflows are declared in JSON/YAML validating against
[`workflow.schema.json`](../../schemas/workflow.schema.json). Minimal example:

```yaml
workflow: lead_qualification
version: 3
trigger: { event: lead.created }
steps:
  - id: normalize
    type: transformation
    map: normalize_lead_v1
  - id: dedupe
    type: database_action
    action: crm.dedupe_lead
  - id: qualify
    type: agent_action
    agent: lead_qualification_agent
    budget: { max_cost_usd: 0.50 }
    output: score
  - id: route
    type: branch
    on: "score >= 80"
    when_true: personal_outreach
    when_false: nurture_sequence
  - id: personal_outreach
    type: agent_action
    agent: sales_outreach_agent
    next: end_ok
  - id: nurture_sequence
    type: api_action
    action: marketing.enroll_nurture
    next: end_ok
  - id: end_ok
    type: end
    result: success
```

## 4. Execution rules (normative)

- **Every workflow is versioned** (`workflow_versions`). Runs pin the version they started on;
  in-flight runs are never silently migrated.
- Each run records `workflow_run_id`, step states, inputs/outputs, and cost — traced per
  [11 §5](11-deployment-gates.md).
- `agent_action` steps are subject to the full agent execution pipeline ([03 §2](03-agent-protocol.md))
  — a workflow does not bypass validation, authorization, policy, risk, or approval gates.
- Failed steps follow their declared `retry` policy, then `compensation` if defined, then land
  in a visible failed state — never silent success.
- `human_approval` steps record the approver in the audit log ([02 §5](02-identity-authorization.md)).
- Tenant workflows execute strictly within tenant context ([01](01-tenancy-data-model.md)).
