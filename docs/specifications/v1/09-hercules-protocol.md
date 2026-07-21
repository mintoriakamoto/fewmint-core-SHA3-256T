# 09 — Hercules Protocol

Spec version 1.0.0 · Status: Frozen ·
Machine-readable schema: [`hercules-task.schema.json`](../../schemas/hercules-task.schema.json)

## 1. Role

Hercules is the **engineering control plane** of the Autonomous Software Factory — an AI
engineering director, not a sixth coding agent. It does not tell five coding agents to edit the
same files; it creates specifications, decomposes them into dependency-aware tasks, assigns the
best worker, isolates work in branches/worktrees, routes results through cross-model review and
automated gates, and decides integration on evidence.

Hercules owns: project state, architecture rules, task decomposition, routing, context
allocation, dependency management, quality gates, conflict resolution, evaluation, release
decisions, and learning from outcomes.

Per [ADR-0002](../../ADR/0002-hercules-on-claude-agent-sdk.md), Hercules is built on the
**Claude Agent SDK** as its planning/reasoning core; all other systems are invoked as external
CLI/API workers.

```
                 YOU / COOK LABS
                        │
                    HERCULES ── Understand · Plan · Control
                        │
        ┌──────────┬────┼─────┬──────────┐
     Claude      Codex  Hermes  MimoCode  Grok Build   (+ local agents)
        └──────────┴────┼─────┴──────────┘
                        ▼
   Independent review → Test/benchmark → Security review
                        ▼
              HERCULES: ACCEPT / REJECT
          reject → return task with evidence
          accept → merge PR → staging → evaluation → production
```

## 2. Worker roster & default specializations

Routing **defaults, not hard-coded limitations** — Hercules benchmarks workers over time and
learns which performs best per task category (§6).

| Worker | Default specialization |
|---|---|
| **Hercules** | Overseer, planner, router, evaluator, memory, permissions, release decisions |
| **Claude Code** | Architecture, complex reasoning, large refactors, multi-file implementation, deep review, design docs |
| **Codex (Cursor/CLI)** | Implementation, repo-level coding, debugging, tests, bug fixing, verification |
| **Hermes Agent** | Long-running autonomous tasks, research, tool-driven workflows, investigation, documentation |
| **MimoCode** | Fast implementation, targeted coding, alternative solutions, iteration, smaller modules |
| **Grok Build** | Parallel prototypes, UI/product builds, independent implementations, second opinions |
| **Local models** | Classification, log/lint triage, cheap repetitive work, documentation, test-generation assist, private tasks |

## 3. Control database (normative)

Hercules memory is **structured state, not a giant chat history**:

```
projects, epics, tasks, task_dependencies,
agents, agent_capabilities, agent_scores, agent_costs,
repositories, branches, worktrees, commits, pull_requests,
requirements, architecture_decisions,
test_runs, benchmark_runs, evaluation_results, security_findings,
reviews, critic_reports, deployments, incidents, rollbacks,
lessons, patterns, known_failures, skills
```

This enables evidence-based routing ("Codex solved 91% of backend bug tasks"; "Grok's
first-pass UI needed accessibility corrections in 23% of recent tasks"; "this auth pattern
caused a tenant-isolation bug — forbidden").

### Lesson provenance (normative)

Every lesson/pattern/known-failure record MUST carry provenance:

```
Pattern:      X implementation caused tenant leakage
Evidence:     Security test SEC-184
Status:       Forbidden
Replacement:  Tenant-scoped repository abstraction
Validated:    Yes
```

Unvalidated lessons MUST NOT become architecture rules — this prevents hallucinated "lessons"
from steering the factory.

## 4. Task protocol (normative)

Every task passes:

```
REQUEST → Requirements → Repository inspection → Impact analysis
→ Architecture check → Task decomposition → Dependency DAG → Agent selection
→ Context package → Branch/worktree → Implementation → Self-test
→ Independent review → Automated gates → Hercules evaluation
→ PR → Staging → Release
```

Every task record (see [`hercules-task.schema.json`](../../schemas/hercules-task.schema.json))
carries: task id, specification, owner, branch, worktree, dependencies, **allowed paths**,
acceptance criteria, tests, budget, deadline, status, artifacts.

The **context package** given to a worker includes: goal, relevant files, architecture rules,
interfaces, dependencies, acceptance criteria, tests, forbidden changes, security requirements,
expected output.

### Isolation (normative)

Workers MUST NOT share one working directory. Each task gets an isolated git branch +
worktree. Workers write only within their task's allowed paths. **No direct uncontrolled merge
to main** — integration happens only through Hercules-evaluated PRs that passed the gates.

## 5. Cross-model verification (normative for critical components)

Builder/reviewer separation — the reviewer is a different model/system than the builder:

```
BUILDER (e.g. Claude) → REVIEWER (e.g. Codex) → SECURITY REVIEW
→ AUTOMATED TEST SUITE → HERCULES DECISION
```

Competitive design for high-risk problems — two systems solve independently (e.g. Claude
designs tenant isolation while Codex independently reviews it for data-leak vulnerabilities):

```
Problem → Claude solution + Codex solution → evidence comparison
→ tests/benchmarks → Hercules selection
```

Hercules MUST compare **measurable evidence** (tests, benchmarks, review findings). A solution
MUST NOT be chosen merely because an LLM claims it is superior, or because it answered first.

## 6. Scoring & routing (normative)

Workers are scored per task category on: correctness, test pass rate, review findings, security
defects, regression rate, time, cost, token usage, rework, maintainability, performance.
Routing selects per the task's priorities (e.g. correctness-critical migration vs. cheap
iteration) — **evidence-based routing, not model loyalty.** Scores live in `agent_scores` /
`agent_costs` and are updated from measured outcomes, with provenance.

## 7. Permissions ladder (normative)

Hercules and its workers operate under escalating permission levels; each level requires the
gates below it:

| Level | Capability |
|---|---|
| **L1** | Read/search repository |
| **L2** | Create plans/issues/specs |
| **L3** | Create branch/worktree and modify code |
| **L4** | Run tests/builds |
| **L5** | Open PR |
| **L6** | Merge after required gates ([11](11-deployment-gates.md)) |
| **L7** | Deploy staging automatically |
| **L8** | Production deployment — **requires defined release policy / human approval** |

Workers never receive unrestricted shell credentials, production secrets, or direct production
database access merely because they work autonomously ([04 §2](04-tool-contract.md)). L8 is
never granted as standing autonomous authority in v1.

## 8. Self-improvement loop (normative gates)

```
Telemetry → Hercules analyzes → opportunity → hypothesis → issue
→ agents implement → tests → evaluation → human/policy approval
→ canary → measure → keep or rollback
```

Hercules MAY propose and implement improvements in controlled environments. It MUST NOT
silently rewrite production systems without gates, and MUST NOT amend this specification
([00 §8](00-overview.md)) or its own permission ladder.

## 9. Definition of task completion

A factory task is complete only when the Definition of Done ([11 §7](11-deployment-gates.md))
passes — never because a worker reports "Completed."

## 10. Lab hardware (non-normative)

Local machines serve as a development/private-inference lab, not production hosting: 9950X
workstation (Hercules development, coding agents, build/test), GPU server (local inference,
embeddings, batch, evaluations), Nitro V15 (portable dev/secondary worker), T440p (monitoring,
utility, test node), Raspberry Pi (health checks, watchdogs, edge experiments). Production
customer infrastructure is designed for reliability, backups, security, and scalable hosting —
never dependent solely on lab hardware.
