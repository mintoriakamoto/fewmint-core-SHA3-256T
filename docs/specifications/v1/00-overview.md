# 00 — Overview

**Cook Labs Architecture & Protocol Specification v1** · Spec version 1.0.0 · Status: **Frozen (Phase 0)**

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this specification are to be
interpreted as described in RFC 2119. Non-normative material (diagrams, examples, roadmap) is
labeled or self-evidently illustrative.

## 1. Company thesis

Cook Labs builds an **AI Business Operating System** that combines specialized SaaS, autonomous
AI agents, workflows, integrations, analytics, private company knowledge, computer vision,
communications, and business intelligence into one configurable platform. Businesses subscribe
instead of commissioning entirely new software.

```
BUILD CORE ONCE → CREATE REUSABLE MODULES → CONFIGURE INDUSTRY PACK
→ ADD SPECIALIZED AGENTS → CONNECT CUSTOMER SYSTEMS → DEPLOY TENANT
→ CHARGE SUBSCRIPTION + USAGE → MEASURE BUSINESS OUTCOMES → IMPROVE PLATFORM ↺
```

The business is not a collection of unrelated apps. It is one underlying platform capable of
producing, operating, selling, and continuously improving specialized AI SaaS products for many
industries.

## 2. The three major systems

Cook Labs MUST be divided into three distinct but connected platforms. This separation prevents
the architecture from becoming one enormous unmanageable application.

| System | Role | Specified in |
|---|---|---|
| **1. Autonomous Software Factory** | Hercules + coding agents build Cook Labs itself | [09 — Hercules Protocol](09-hercules-protocol.md) |
| **2. Universal Business OS** | Shared SaaS infrastructure that runs every customer | Docs 01–06, 08 |
| **3. SaaS Factory** | Converts reusable capabilities into vertical industry products | [07 — Industry Pack Schema](07-industry-pack-schema.md) |

## 3. Master architecture (non-normative diagram)

```
┌────────────────────────────────────────────────────────────┐
│                       COOK LABS INC.                       │
└────────────────────────────┬───────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
┌─────────────────────────┐     ┌──────────────────────────┐
│ AUTONOMOUS SOFTWARE     │     │ COOK LABS AI CLOUD       │
│ FACTORY                 │     │ BUSINESS OPERATING OS    │
│                         │     │                          │
│       HERCULES          │     │ Identity · Multi-tenancy │
│          │              │     │ Permissions · Billing    │
│ ┌────────┼─────────┐    │     │ CRM · Communications     │
│ │        │         │    │     │ Scheduling · Documents   │
│Claude  Codex    Hermes  │     │ Analytics · Integrations │
│Mimo    Grok      Local  │     │                          │
│ └────────┼─────────┘    │     └────────────┬─────────────┘
│          │              │                  │
│ Build / Test / Review   │    ┌─────────────┼──────────────┐
│ Secure / Deploy         │    ▼             ▼              ▼
└──────────┬──────────────┘  AGENT OS   WORKFLOW OS   KNOWLEDGE OS
           │                   └─────────────┼──────────────┘
           │                                 ▼
           │                           MODEL GATEWAY
           │                        (Cloud / Local / Specialized)
           └────────────────────┐
                                ▼
                          SaaS FACTORY
                                │
              AUTO · CONTRACTORS · RETAIL · HVAC · PLUMBING
              FARMING · TOWING · REAL ESTATE · LOGISTICS · …
                                │
                        MARKETPLACE / API
                                │
                       BUSINESS CUSTOMERS
                                │
                    DATA + EVENTS + OUTCOMES
                                │
                       MEASURED FEEDBACK ──► HERCULES ──► IMPROVE ↺
```

## 4. The operating principle

The entire system reduces to one loop:

```
UNDERSTAND BUSINESS → CONNECT AUTHORIZED DATA → CONFIGURE INDUSTRY SaaS
→ DEPLOY SPECIALIZED AGENTS → AUTOMATE WORKFLOWS
→ HUMANS APPROVE HIGH-RISK ACTIONS → MEASURE RESULTS
→ HERCULES IDENTIFIES IMPROVEMENTS
→ CLAUDE + CODEX + HERMES + MIMOCODE + GROK BUILD IN PARALLEL
→ CROSS-REVIEW → TEST → SECURE → STAGE → RELEASE → MEASURE AGAIN ↺
```

## 5. Foundational rules (normative)

These rules apply platform-wide and are elaborated in the referenced documents.

1. Every tenant-sensitive record MUST carry ownership boundaries, and isolation MUST exist at
   multiple layers; a missing frontend filter MUST NOT be able to expose another company's
   information. ([01](01-tenancy-data-model.md))
2. Agent identities MUST be separate from human identities, and every action MUST be audited.
   ([02](02-identity-authorization.md))
3. Unrestricted LLM output MUST NOT be connected directly to business systems; all agent
   actions pass through validation, authorization, policy, and risk gates. ([03](03-agent-protocol.md))
4. Agents receive narrow, typed capabilities — never unrestricted infrastructure access — and
   MUST NOT hold raw production secrets when avoidable. ([04](04-tool-contract.md))
5. Every important business change MUST produce a versioned, idempotent, traceable event.
   ([05](05-event-schema.md))
6. All AI requests MUST pass through the Model Gateway; a failed model action MUST NOT be
   silently reported as success. ([08](08-model-gateway.md))
7. All autonomous development runs under the Hercules protocol: isolated worktrees, quality
   gates, evidence-based decisions, and the permissions ladder. ([09](09-hercules-protocol.md))
8. Nothing is "done" because an agent says "Completed" — a task is complete only when the
   required gates pass. ([11](11-deployment-gates.md))
9. No component may claim to guarantee "no errors." Verification, rollback, isolation, testing,
   approvals, observability, and recovery are the mandatory mechanisms for containing errors.

## 6. Development order (roadmap, non-normative sequencing; gates are normative)

Do not begin by generating 100 verticals.

| Phase | Scope |
|---|---|
| **0 — Specifications** | Freeze this document set: requirements, architecture, repo structure, coding standards, tenant model, authorization, event format, agent protocol, tool protocol, workflow DSL, Industry Pack spec, billing model, deployment model, security model, evaluation model |
| **1 — Foundation** | Authentication, tenancy, organizations, RBAC/ABAC, database, audit, API framework, observability, CI/CD, secrets |
| **2 — AI foundation** | Model Gateway, agent runtime, Tool Gateway, memory, RAG, evaluations, policy engine, approval engine |
| **3 — Business foundation** | CRM, customers, leads, tasks, scheduling, documents, communications, billing, analytics |
| **4 — Automation** | Events, workflow engine, workflow builder, agent builder, integration framework |
| **5 — First vertical** | Cook Labs Auto — complete customer journey ([13](13-auto-mvp-acceptance.md)) |
| **6 — Real customers** | 1 design partner → 3 → 10 paying → 50 → 100; stabilize with real feedback |
| **7 — SaaS Factory** | Formalize reusable Industry Packs |
| **8 — Additional verticals** | Launch based on demand and module reuse |
| **9 — Marketplace** | Third-party ecosystem |
| **10 — Enterprise** | SSO, advanced compliance, dedicated deployments, regional hosting, SLAs, governance |

### What not to build first

Early phases MUST NOT be spent on: hundreds of verticals, custom blockchain, a large
microservice architecture, training proprietary foundation models, every possible integration,
fully autonomous production changes, a complex marketplace, global enterprise compliance, or
native apps for every platform. First prove:

```
CUSTOMER HAS PROBLEM → COOK LABS SOLVES IT → CUSTOMER PAYS
→ CUSTOMER GETS ROI → CUSTOMER STAYS
```

## 7. Business moat (non-normative)

Defensibility compounds from: universal business data model + industry schemas + vertical
workflows + agent evaluations + integration ecosystem + reliable tool execution + private
knowledge architecture + industry-specific UX + outcome attribution + marketplace + Hercules
Software Factory + reusable SaaS Factory. **The moat is not access to an LLM.**

## 8. Specification governance

- This spec is versioned semantically (see [CHANGELOG.md](CHANGELOG.md)). Breaking changes to
  any normative contract (schemas, protocols, permission semantics) require a **major** version
  bump; additive changes a **minor** bump; clarifications a **patch**.
- Amendments MUST be proposed as an ADR in [docs/ADR/](../../ADR/) or a spec PR referencing the
  affected sections, and MUST pass human review. Hercules MAY propose amendments but MUST NOT
  self-ratify changes to this specification.
- Machine-readable schemas in [docs/schemas/](../../schemas/) are normative. Where prose and
  schema disagree, the schema wins and a patch release MUST reconcile the prose.
- Every human and AI developer MUST treat this specification as binding. Deviations discovered
  in code are defects, not precedents.
