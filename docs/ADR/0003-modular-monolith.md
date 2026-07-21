# ADR-0003: Modular monolith first

Status: **Accepted** · Date: 2026-07-21

## Context

The platform spans identity, tenancy, CRM, billing, workflows, agents, knowledge, integrations,
and many verticals. A microservice-per-domain architecture is tempting but expensive: N deploy
pipelines, distributed transactions, cross-service auth, and operational surface a small team
(plus an autonomous factory) cannot yet afford.

## Decision

Start as a **modular monolith**: one deployable core app + agent runtime + workers, with hard
internal module boundaries enforced by the monorepo package structure (spec
[10](../specifications/v1/10-repository-structure.md)). Extract an independent service **only
on demonstrated need** — measured scaling limits, isolation requirements, or a genuine
operational boundary.

## Rationale

- Module boundaries (packages, events, no cross-module table access — spec
  [01 §5](../specifications/v1/01-tenancy-data-model.md)) give the decoupling benefits now,
  while keeping one build, one deploy, one transaction boundary.
- The event architecture (spec [05](../specifications/v1/05-event-schema.md)) means modules
  already communicate as if distributed; extraction later is a topology change, not a rewrite.
- Blueprint principle: avoid "huge microservice architecture" as an early distraction (spec
  [00 §6](../specifications/v1/00-overview.md)).

## Consequences

- CI enforces package boundaries (lint rules against deep imports) so the monolith stays
  modular.
- Candidate first extractions, if ever justified by evidence: the agent runtime (bursty,
  isolatable) and vision processing (GPU-bound). No extraction happens without a measurement
  showing the monolith is the constraint.
