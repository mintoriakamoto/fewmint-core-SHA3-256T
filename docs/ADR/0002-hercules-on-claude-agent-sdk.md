# ADR-0002: Hercules is built on the Claude Agent SDK

Status: **Accepted** · Date: 2026-07-21

## Context

Hercules is the master overseer of the Autonomous Software Factory (spec
[09](../specifications/v1/09-hercules-protocol.md)). Two candidate shapes:

1. A fully independent orchestrator service (own scheduler, own agent loop) that shells out to
   every coding system, including Claude Code, as CLI workers.
2. Hercules built on the **Claude Agent SDK** as its reasoning/planning core, with the other
   systems (Codex via Cursor CLI, Hermes, MimoCode, Grok Build, local models) invoked as
   external CLI/API workers.

## Decision

Option 2: **Claude Agent SDK core.** Hercules' planning, decomposition, routing, and
evaluation loops run on the Agent SDK; its durable state lives in the structured control
database (spec [09 §3](../specifications/v1/09-hercules-protocol.md)) — not in conversation
history.

## Rationale

- Fastest path to a working overseer: the SDK provides the agent loop, tool execution,
  subagent orchestration, and permission hooks that option 1 would rebuild from scratch.
- The parts that make Hercules *Hercules* — control DB, task protocol, permissions ladder,
  scoring, gates — are SDK-independent and remain our code either way.
- Worker-side neutrality is preserved: workers are reached through a uniform worker adapter
  interface (spawn CLI / call API), so Claude Code holds no privileged position as a *worker*
  and routing stays evidence-based.

## Consequences

- The Hercules control plane depends on Anthropic model availability; the Model Gateway
  fallback rules (spec [08 §3](../specifications/v1/08-model-gateway.md)) apply to Hercules'
  own reasoning calls, and control-DB state must allow pausing/resuming the factory if the
  core loop is down.
- The worker adapter interface must be defined so a future migration off the SDK (to option 1)
  changes the core loop, not the workers or the control DB.
- Hercules' SDK permissions are bound to the ladder in spec
  [09 §7](../specifications/v1/09-hercules-protocol.md); the SDK's own permission hooks enforce
  L-level ceilings.
