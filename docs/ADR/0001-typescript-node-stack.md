# ADR-0001: TypeScript/Node platform stack

Status: **Accepted** · Date: 2026-07-21

## Context

The Universal Business OS needs one primary stack for a monorepo spanning web frontend, API,
workers, shared packages, and Industry Packs. Candidates: TypeScript/Node end-to-end, or a
Python (FastAPI) backend with a TypeScript frontend.

## Decision

- **TypeScript everywhere**: Node API and workers, React web frontend, shared packages with
  end-to-end types across the monorepo boundary.
- **PostgreSQL** as the primary datastore with **row-level security** enforcing tenant
  isolation at the database layer (spec [01 §3](../specifications/v1/01-tenancy-data-model.md)).
- **Redis** for cache/queues; **object storage** for files; a search/vector layer for
  hybrid retrieval.

## Rationale

- One language across frontend, API, packages, and Industry Packs maximizes code sharing
  (schemas, validation, types) and matches the monorepo layout in spec
  [10](../specifications/v1/10-repository-structure.md).
- The AI coding workers in the Software Factory all have first-class TypeScript support,
  reducing routing friction.
- Postgres RLS provides the defense-in-depth isolation layer the tenancy model requires.

## Consequences

- Python remains available for isolated ML/evaluation tooling where it clearly wins, but such
  components integrate via APIs/queues — they don't fork the core stack.
- Team/agent onboarding standardizes on TypeScript strict mode and the coding standards in
  spec [10 §4](../specifications/v1/10-repository-structure.md).
