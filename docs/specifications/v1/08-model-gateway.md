# 08 — Model Gateway

Spec version 1.0.0 · Status: Frozen

## 1. Principle (normative)

**All AI requests pass through a provider-independent Model Gateway.** Application and agent
code MUST NOT call model providers directly.

```
Cook Labs Application
        ↓
   MODEL GATEWAY
        ├── OpenAI-compatible APIs
        ├── Anthropic-compatible APIs
        ├── Google models
        ├── xAI models
        ├── Local inference
        └── Future providers
```

## 2. Routing inputs

Routing decisions consider: quality, task type, cost, latency, privacy, context size, tool
support, availability, customer policy, data residency, and **benchmark performance** (measured,
not assumed — see [09 §6](09-hercules-protocol.md) for the same principle applied to coding
workers). Tenants MAY constrain routing (e.g. residency or provider policy); tenant policy
overrides platform preference.

## 3. Fallback (normative)

```
Preferred model
   ↓ failure
Secondary model
   ↓ failure
Local / degraded capability
   ↓
Human-visible failure state
```

Retries and fallbacks follow declared policies ([11 §4](11-deployment-gates.md)). If all
options fail, the task is queued and the user notified.

## 4. Never fake success (normative)

A failed model action MUST NOT be silently reported as success — not by the gateway, not by an
agent, not by a workflow. Degraded modes are visible states.

## 5. Metering

The gateway records per request: tenant, agent/workflow run ids, model, tokens, latency, cost,
and outcome — feeding usage billing ([usage ledger](00-overview.md)), per-tenant quotas/budgets
(one customer MUST NOT be able to accidentally create unlimited infrastructure cost), and
observability dashboards ([11 §5](11-deployment-gates.md)).
