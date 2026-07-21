# 02 — Identity & Authorization

Spec version 1.0.0 · Status: Frozen

## 1. Model: RBAC + ABAC (normative)

Authorization MUST combine:

- **RBAC** — roles grant permission sets on resource types (e.g. `Technician`, `Service Advisor`,
  `Owner`, `Admin`).
- **ABAC** — attribute conditions narrow those grants (assignment, location, ownership, record
  state, time, amount thresholds).

Example (illustrative):

> A `Technician` CAN view **assigned** repair orders, add inspection results, upload photos.
> A `Technician` CANNOT view payroll, change billing, export the entire customer database, or
> modify agent permissions.

Rules:

- Authorization decisions MUST be made server-side by a single shared permissions package
  (see [10](10-repository-structure.md)); feature code MUST NOT hand-roll checks.
- Deny by default. An absent grant is a denial.
- Bulk/export operations are distinct permissions from single-record read.
- Administrative actions (role changes, permission grants, tenant configuration, data export,
  deletion) require elevated roles and stronger controls ([12](12-security-baseline.md)).

## 2. Identity types

| Identity | Notes |
|---|---|
| **Human user** | Belongs to one or more organizations via `memberships`; authenticates with MFA (SSO on appropriate tiers). |
| **Agent** | First-class identity, **separate from human identities**. An agent MUST NOT act as a user; it acts as itself, with its own permission set ([03](03-agent-protocol.md)). |
| **Service/system** | Internal workers and integrations; scoped machine credentials. |

Agent permissions are compiled from the agent's configuration ([03 §2](03-agent-protocol.md),
[22-style Agent Builder configs](03-agent-protocol.md#8-agent-builder-configurations)) into
enforceable grants stored in `agent_permissions` — never interpreted at runtime from prose
instructions.

## 3. Permission matrix

The canonical permission matrix is `roles × resources × actions (+ attribute conditions)`.
v1 core actions: `read`, `list`, `create`, `update`, `delete`, `export`, `approve`, `assign`,
`execute`. The full matrix is maintained as configuration data (seeded per Industry Pack),
not in this document; the *structure* here is normative.

## 4. Autonomy interplay

Role permissions bound *what* an actor may touch; agent autonomy levels
([03 §4](03-agent-protocol.md)) bound *how independently* an agent may act on it. An action
requires both: permission AND autonomy-level clearance (with approval where gated).

## 5. Audit record (normative)

Every action — human, agent, or system — MUST record:

| Field | Content |
|---|---|
| `actor` | Identity id + type (user / agent / system) |
| `tenant` | `tenant_id` (and `location_id` where applicable) |
| `action` | Canonical action name |
| `resource` | Resource type + id |
| `permission` | The grant that authorized the action |
| `reason` | Stated purpose / triggering context |
| `timestamp` | UTC |
| `result` | success / denied / failed |
| `approval` | Approval record reference, if the action was approval-gated |
| `model_tool` | Model and/or tool used, for AI-performed actions |

Audit logs are append-only, tenant-scoped for customer visibility, and retained per data
governance policy ([12 §6](12-security-baseline.md)). Authorization denials MUST be audited,
not just successes.
