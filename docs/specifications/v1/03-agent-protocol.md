# 03 — Agent Protocol

Spec version 1.0.0 · Status: Frozen ·
Machine-readable schema: [`agent-definition.schema.json`](../../schemas/agent-definition.schema.json)

## 1. Agents are first-class platform objects

```
Agent
├── Identity            (separate from human identities — 02 §2)
├── Role
├── Goal
├── Model policy
├── Instructions
├── Tools               (typed capabilities only — 04)
├── Permissions         (compiled, enforceable — 02)
├── Knowledge           (permission-aware RAG — 01 §6)
├── Memory              (scoped — §6)
├── Budget              (tokens/cost/action quotas)
├── Triggers
├── Workflows
├── Evaluations         (§7)
└── Audit history
```

Universal templates (specialized by Industry Packs): Executive, Sales, Lead, Marketing,
Reception, Customer Support, Operations, Scheduling, Finance Assistant, Inventory, Purchasing,
Research, Document, Analytics, Vision, Compliance Assistant, HR Administration, Security.

## 2. Execution pipeline (normative)

Unrestricted LLM output MUST NOT be connected directly to business systems. Every agent action
passes through this pipeline; **this boundary is one of the most important parts of the system.**

```
EVENT / USER REQUEST
  → ORCHESTRATOR
  → CONTEXT BUILDER
  → MODEL ROUTER            (via Model Gateway — 08)
  → LLM REASONING
  → STRUCTURED PROPOSED ACTION
  → SCHEMA VALIDATOR         (typed tool schema — 04)
  → AUTHORIZATION            (02)
  → POLICY ENGINE
  → RISK ENGINE
       ├─ LOW RISK  → execute
       └─ HIGH RISK → human approval required
  → TOOL EXECUTION           (Tool Gateway — 04)
  → RESULT VERIFICATION
  → AUDIT                    (02 §5)
  → MEMORY / EVENT           (05)
```

Rules:

- The model proposes **structured actions** validated against tool schemas; free-text output
  MUST NOT be executed.
- Policy and risk evaluation happen after authorization; any gate failing stops the action and
  is audited.
- Result verification MUST confirm the tool's effect before the agent reports success
  (never-fake-success — [08 §4](08-model-gateway.md)).

## 3. Approval-gated operations (normative, minimum set)

Regardless of autonomy level, these require authorized human approval: large payments, large
refunds, payroll changes, contracts, permission changes, destructive deletion, sensitive
exports, high-value purchasing, production configuration. Thresholds ("large", "high-value")
are tenant-configurable but MUST have safe platform defaults.

## 4. Autonomy levels (normative)

| Level | Name | Meaning |
|---|---|---|
| **L0** | Observe | Read authorized information |
| **L1** | Recommend | Suggest an action |
| **L2** | Draft | Prepare email, quote, order, report, etc. |
| **L3** | Low-risk execution | Perform predefined **reversible** actions |
| **L4** | Policy-bound autonomy | Operate independently within explicit limits (budgets, quotas, allowed actions) |
| **L5** | Approval-gated | Sensitive action executes only after authorized human approval |

An agent's maximum autonomy level is part of its configuration; tenants set it during
onboarding and MAY lower it at any time.

## 5. Reliability of agent behavior

- Every agent run records `agent_run_id`, inputs, model, tools invoked, outcome, cost — traced
  per [11 §5](11-deployment-gates.md).
- Budget exhaustion (tokens, cost, action quota like "max 100 outbound contacts/day") stops the
  agent with a visible, audited state — never silent truncation of the task.

## 6. Memory (normative)

Never dump unlimited conversation history into every prompt. Memory is scoped:

| Scope | Content |
|---|---|
| Working | Current execution |
| Conversation | Current interaction |
| Entity | Customer/job/product context |
| Organizational | Authorized company knowledge |
| Procedural | How work is performed |
| Learned | Evaluated, reusable lessons |

Every record carries the metadata in [01 §7](01-tenancy-data-model.md). Learned memory MUST be
evaluated before reuse — an unverified inference MUST NOT silently become organizational fact.

## 7. Evaluation before release (normative)

Before an agent version serves tenants it MUST pass: golden test set, adversarial tests,
permission tests, tool-use tests, prompt-injection tests ([12 §3](12-security-baseline.md)),
hallucination tests, cost tests, latency tests, regression tests, and human review.

Measured: task success, accuracy, groundedness, tool correctness, policy compliance, cost/task,
latency, escalation rate, false-positive rate, false-negative rate.

Agents are **versioned** (`agent_versions`). Behavior MUST NOT be overwritten without preserving
evaluation history; a new version re-runs the evaluation suite.

## 8. Agent Builder configurations

Customer-built agents compile a declarative config into the same enforceable objects
(illustrative):

```
AGENT NAME    Warranty Follow-Up Agent
GOAL          Contact eligible customers before warranty expiration
KNOWLEDGE     Warranty policies · Customer records · Product records
TOOLS         CRM · Email · SMS · Calendar
PERMISSIONS   Read customers · Draft messages · Send approved templates
LIMIT         Max 100 outbound contacts/day
APPROVAL      Required for custom offers > $500
```

Every configuration compiles into enforceable permissions ([02 §2](02-identity-authorization.md))
— the prose goal never grants capability by itself. The full manifest shape is defined by
[`agent-definition.schema.json`](../../schemas/agent-definition.schema.json).
