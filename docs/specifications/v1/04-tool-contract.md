# 04 — Tool Contract

Spec version 1.0.0 · Status: Frozen

## 1. Narrow capabilities (normative)

Agents receive **narrow, typed capabilities — not unrestricted infrastructure access.**

Right:

```
create_estimate(customer_id, items[], expiration, notes)
```

Wrong (MUST NOT exist as an agent tool):

```
run_any_sql(...)
run_shell(...)
http_request_to_anywhere(...)
```

Rules:

- Every tool declares a **typed schema** (JSON Schema) for inputs and outputs. Proposed actions
  are validated against it before execution ([03 §2](03-agent-protocol.md)).
- Tools declare required permissions; the Tool Gateway enforces them per call against the
  calling agent's compiled grants ([02](02-identity-authorization.md)).
- Tools declare risk class (reversible / compensable / irreversible) and whether they are
  approval-gated ([03 §3](03-agent-protocol.md)).
- Tool calls MUST be idempotent or accept an idempotency key where retries are possible.
- Every tool execution is audited ([02 §5](02-identity-authorization.md)) and traced
  ([11 §5](11-deployment-gates.md)).

## 2. Tool Gateway & secrets (normative)

Agents MUST NOT receive unrestricted raw secrets when avoidable.

```
Agent → Tool request → TOOL GATEWAY → Secrets manager → Provider
```

- The Tool Gateway injects credentials at execution time from the secrets manager
  ([12 §4](12-security-baseline.md)). **The model sees the capability — not the secret.**
- Credentials are scoped per tenant + integration account, least-privilege, rotated.
- Agents never share unrestricted shell credentials, production secrets, or direct production
  database access merely because they are working autonomously (this applies equally to
  Software Factory workers — [09 §7](09-hercules-protocol.md)).

## 3. API standards (normative)

All platform APIs (human-facing and tool-facing) require:

Authentication · Authorization · Tenant context · Input validation · Rate limiting ·
Idempotency where applicable · Versioning · Structured errors · Audit · Observability.

Structured errors MUST distinguish: validation failure, authorization denial, policy denial,
approval required, downstream failure, and rate limit — so agents and workflows can react
correctly instead of guessing.

## 4. Integration connectors

External systems are reached only through the connector interface — provider-specific logic
MUST NOT be embedded throughout the application; it lives behind connector adapters.

```
Connector
├── Authentication
├── Capabilities
├── Actions
├── Triggers
├── Data mappings
├── Rate limits
├── Webhooks
├── Sync state
├── Errors
└── Health
```

Integration categories (non-exhaustive): accounting, payments, banks (where authorized), email,
calendar, telephony, SMS, CRM, POS, e-commerce, shipping, advertising, cloud storage,
documents, maps, industry software, IoT, authorized cameras.

Connector actions surface to agents as typed tools under this contract — a connector is not a
bypass around the Tool Gateway.
