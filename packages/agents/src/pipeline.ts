import { buildAuditRecord, type AuditLog } from '@cooklabs/audit';
import { createEvent, type EventEnvelope } from '@cooklabs/events';
import { authorize, type Attributes, type Grant } from '@cooklabs/permissions';
import { getTenantContext } from '@cooklabs/tenancy';
import type { ToolGateway } from './tools.js';

/** The agent identity executing (spec 03 §1, 02 §2). */
export interface AgentPrincipal {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  /** L0 observe … L5 approval-gated (spec 03 §4). */
  readonly maxAutonomyLevel: 0 | 1 | 2 | 3 | 4 | 5;
  /** Compiled, enforceable grants — never derived from prose at runtime. */
  readonly grants: readonly Grant[];
}

/**
 * A structured proposed action from the model (spec 03 §2). Free-text output
 * has no execution path: only this shape enters the pipeline.
 */
export interface ProposedAction {
  readonly tool: string;
  readonly input: unknown;
  readonly reason: string;
  /** Resource attributes for ABAC evaluation (assignment, amounts, …). */
  readonly attributes?: Attributes;
  /** Reference to a granted human approval, for approval-gated actions. */
  readonly approvalRef?: string;
}

export type ActionOutcome =
  | { readonly status: 'executed'; readonly result: unknown }
  | { readonly status: 'rejected_schema'; readonly errors: readonly string[] }
  | { readonly status: 'denied_authorization'; readonly reason: string }
  | { readonly status: 'denied_policy'; readonly reason: string }
  | { readonly status: 'pending_approval'; readonly reason: string }
  | { readonly status: 'failed_execution'; readonly reason: string };

export interface PipelineDeps {
  readonly tools: ToolGateway;
  readonly audit: AuditLog;
  readonly publish: (event: EventEnvelope) => void;
  readonly correlationId?: string;
}

/**
 * The agent execution pipeline (spec 03 §2): schema validation →
 * authorization → policy → risk/approval → tool execution → result
 * verification → audit → event. Every terminal state — including every
 * denial — is audited; failures are visible, never faked as success.
 */
export async function executeProposedAction(
  agent: AgentPrincipal,
  action: ProposedAction,
  deps: PipelineDeps,
): Promise<ActionOutcome> {
  const ctx = getTenantContext(); // fail closed outside a tenant context
  const registry = deps.tools.registry;

  const finish = async (
    outcome: ActionOutcome,
    permission: string,
    resource: { type: string; id?: string },
  ): Promise<ActionOutcome> => {
    const result =
      outcome.status === 'executed'
        ? 'success'
        : outcome.status === 'failed_execution'
          ? 'failed'
          : 'denied';
    await deps.audit.append(
      buildAuditRecord({
        actor: { id: agent.id, type: 'agent' },
        tenant_id: ctx.tenantId,
        action: `agent.${action.tool}`,
        resource,
        permission,
        reason:
          outcome.status === 'executed' ? action.reason : `${outcome.status}: ${action.reason}`,
        result,
        model_tool: `${agent.name}@${agent.version}/${action.tool}`,
        ...(action.approvalRef !== undefined ? { approval: action.approvalRef } : {}),
      }),
    );
    deps.publish(
      createEvent({
        event_type: 'agent.action.completed',
        tenant_id: ctx.tenantId,
        entity_id: agent.id,
        payload: { tool: action.tool, status: outcome.status },
        ...(deps.correlationId !== undefined ? { correlation_id: deps.correlationId } : {}),
      }),
    );
    return outcome;
  };

  // 1. Structured action + schema validation. Unknown tools and malformed
  //    inputs never reach execution.
  let tool;
  try {
    tool = registry.get(action.tool);
  } catch {
    return finish({ status: 'rejected_schema', errors: [`unknown tool ${action.tool}`] }, 'none', {
      type: 'tool',
    });
  }
  const resource = { type: tool.requiredPermission.resource };
  const permission = `${tool.requiredPermission.action}:${tool.requiredPermission.resource}`;

  const validation = registry.validateInput(action.tool, action.input);
  if (!validation.valid) {
    return finish({ status: 'rejected_schema', errors: validation.errors }, permission, resource);
  }

  // 2. Authorization from the agent's compiled grants (deny by default).
  const decision = authorize({
    grants: agent.grants,
    resource: tool.requiredPermission.resource,
    action: tool.requiredPermission.action,
    actorId: agent.id,
    ...(action.attributes !== undefined ? { attributes: action.attributes } : {}),
  });
  if (!decision.allowed) {
    return finish(
      { status: 'denied_authorization', reason: decision.reason },
      permission,
      resource,
    );
  }

  // 3. Policy: autonomy ceiling (spec 03 §4). Below L3 an agent may observe,
  //    recommend, or draft — it may not execute tools.
  if (agent.maxAutonomyLevel < 3) {
    return finish(
      {
        status: 'denied_policy',
        reason: `autonomy level L${agent.maxAutonomyLevel} cannot execute tools (L3 required)`,
      },
      permission,
      resource,
    );
  }

  // 4. Risk gate: approval-gated and irreversible operations require a human
  //    approval reference (spec 03 §3) — they park, they do not execute.
  const needsApproval = tool.approvalGated === true || tool.riskClass === 'irreversible';
  if (needsApproval && action.approvalRef === undefined) {
    return finish(
      { status: 'pending_approval', reason: `${action.tool} requires human approval` },
      permission,
      resource,
    );
  }

  // 5. Execute through the Tool Gateway (credentials injected there) and
  //    verify the result before claiming success.
  try {
    const result = await deps.tools.execute(action.tool, action.input, ctx.tenantId);
    if (tool.verify && !tool.verify(result)) {
      return finish(
        { status: 'failed_execution', reason: 'result verification failed' },
        permission,
        resource,
      );
    }
    return finish({ status: 'executed', result }, permission, resource);
  } catch (err) {
    return finish(
      { status: 'failed_execution', reason: err instanceof Error ? err.message : String(err) },
      permission,
      resource,
    );
  }
}
