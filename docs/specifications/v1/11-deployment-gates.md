# 11 — Deployment Gates

Spec version 1.0.0 · Status: Frozen

## 1. CI/CD gate sequence (normative)

Every change passes, in order. **Failure stops progression** — there is no override path except
a human-approved, audited exception.

```
Commit → Formatting → Lint → Type check → Unit tests
→ Dependency/security scan → Secret scan → Build
→ Integration tests → Tenant-isolation tests → Agent evaluations
→ Migration validation → E2E tests → Performance checks
→ Artifact signing → Staging → Smoke tests → Approval policy
→ Canary → Production
```

Notes:

- **Tenant-isolation tests** are mandatory for any change touching data access
  ([01 §3](01-tenancy-data-model.md)).
- **Agent evaluations** run when agent definitions, prompts, tools, or the gateway change
  ([03 §7](03-agent-protocol.md)).
- Artifacts are versioned and signed; production runs signed artifacts only. **Never deploy
  unversioned code directly from an agent workspace.**

## 2. Environment ladder

```
LOCAL → DEVELOPMENT → PREVIEW → STAGING → CANARY → PRODUCTION
```

Production deployment requires: versioned artifacts, database migration plan, backward
compatibility, health checks, rollback plan, observability, feature flags. Autonomous actors
stop at the [09 §7](09-hercules-protocol.md) permissions ladder: L8 (production) requires
defined release policy / human approval.

## 3. Feature flags (normative)

New capabilities launch gradually:

```
Feature → Internal users → Test tenants → 1% → 10% → 50% → 100%
```

If metrics degrade at any stage: automatic stop, then rollback/disable flag. Every migration
ships with a validated rollback (or documented compensating plan for irreversible steps —
which then require explicit approval).

## 4. Reliability (normative)

Every critical dependency MUST define behavior for: timeout, retry, circuit breaker, rate
limit, failure, degraded mode, recovery. Canonical example:

```
LLM unavailable → retry policy → fallback provider → still unavailable?
→ queue task → notify user → NEVER fake success
```

## 5. Observability (normative)

Signals: logs, metrics, traces, audit events, AI traces, costs, latency, errors, business KPIs.

Every request/run carries where applicable: `trace_id`, `request_id`, `tenant_id`,
`agent_run_id`, `workflow_run_id` — joinable with event `correlation_id`
([05 §2](05-event-schema.md)).

Platform dashboard minimums: API latency, error rate, queue depth, database health, LLM
latency, LLM cost, agent success, tool failures, workflow failures, security events, revenue
impact.

## 6. Honest reporting (normative)

Failed states are visible states. No component — agent, workflow, gateway, worker, or Hercules
itself — reports success it did not verify ([08 §4](08-model-gateway.md)). Outcome/ROI
attribution shown to customers distinguishes: directly attributed, AI-assisted, estimated,
potential opportunity. ROI claims are not inflated.

## 7. Definition of Done (normative)

Nothing is "done" because an AI agent says "Completed." A task is complete only when required
gates pass:

- [ ] Requirements satisfied
- [ ] Code committed
- [ ] Code reviewed (cross-model for critical components — [09 §5](09-hercules-protocol.md))
- [ ] Tests passed
- [ ] Security checks passed
- [ ] Tenant isolation verified
- [ ] Documentation updated
- [ ] Observability added
- [ ] Migration validated
- [ ] Rollback available
- [ ] Acceptance criteria demonstrated
- [ ] Artifacts recorded
- [ ] Hercules verification complete
