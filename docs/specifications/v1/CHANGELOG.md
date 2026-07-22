# Specification Changelog

Versioning rules: see [00 — Overview §8](00-overview.md#8-specification-governance).
Breaking changes to normative contracts → major; additive → minor; clarifications → patch.

## 1.2.0 — 2026-07-22

Additive: durable coordination and conversational workflows.

- Workflow DSL gains the `agent_conversation` step type (doc 06 §2): the initiating agent asks
  a peer over the message bus; the step requires `agent` and `params` (`to`, `content` with
  `{{var}}` templating from run context); a silent peer is a visible failure. Normative schema
  updated (both copies parity-tested).
- Doc 14 gains journaling semantics: blackboard entries and bus messages are journaled with
  dispositions and replayable; per-agent live queues are transient by design; journal records
  project into `comms.entry.posted` / `comms.message.sent` envelopes.
- Hercules worker seam ships its first real adapter: the Claude Code CLI worker (ADR-0002) —
  guardrailed prompt from the context package, machine-readable artifacts required, non-zero
  exits and malformed output are failures.

## 1.1.0 — 2026-07-22

Additive: agent communication.

- New doc [14 — Agent Communication](14-agent-communication.md): the blackboard (append-only
  entries, digest-over-dump, evidence-required decisions, claims with conflict detection) and
  the message bus (performative envelope, idempotent delivery, dead-letter queue, escalation
  always routing to the human inbox). Content authored by agents/workers is data, never
  instructions; actions triggered by communication go through the agent execution pipeline.
- Reference implementation: `@cooklabs/comms`; Hercules task boards integrate the debate
  protocol (review decisions must cite evidence entries).

## 1.0.0 — 2026-07-21

Initial frozen release of the Cook Labs Architecture & Protocol Specification (Phase 0
artifact).

- Documents 00–13: overview & governance, tenancy/data model, identity/authorization, agent
  protocol, tool contract, event schema, workflow DSL, Industry Pack schema, model gateway,
  Hercules protocol, repository structure, deployment gates, security baseline, Cook Labs Auto
  MVP acceptance criteria.
- Machine-readable JSON Schemas (draft 2020-12): event envelope, industry pack, agent
  definition, workflow, Hercules task.
- Accepted ADRs: 0001 (TypeScript/Node stack), 0002 (Hercules on Claude Agent SDK), 0003
  (modular monolith first).
