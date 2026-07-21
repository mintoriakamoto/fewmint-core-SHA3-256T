import { describe, expect, it } from 'vitest';
import {
  ToolGateway,
  ToolRegistry,
  executeProposedAction,
  type AgentPrincipal,
  type PipelineDeps,
  type SecretsProvider,
  type ToolDefinition,
} from '@cooklabs/agents';
import { InMemoryAuditLog } from '@cooklabs/audit';
import type { EventEnvelope } from '@cooklabs/events';
import { runWithTenant, type TenantContext } from '@cooklabs/tenancy';

const ctx: TenantContext = {
  tenantId: 'org_a',
  organizationId: 'org_a',
  actor: { id: 'agent_sa', type: 'agent' },
};

function makeTools(executedWith: { credentials?: Record<string, string> }) {
  const registry = new ToolRegistry();
  const createEstimate: ToolDefinition<
    { customer_id: string; total: number },
    { estimate_id: string }
  > = {
    name: 'crm.create_estimate',
    description: 'Create an estimate for a customer',
    inputSchema: {
      type: 'object',
      required: ['customer_id', 'total'],
      properties: { customer_id: { type: 'string' }, total: { type: 'number' } },
      additionalProperties: false,
    },
    requiredPermission: { resource: 'estimates', action: 'create' },
    riskClass: 'reversible',
    execute(input, credentials) {
      executedWith.credentials = { ...credentials };
      return Promise.resolve({ estimate_id: `est_for_${input.customer_id}` });
    },
    verify(result) {
      return result.estimate_id.startsWith('est_');
    },
  };
  const deleteCustomer: ToolDefinition<{ customer_id: string }, { deleted: boolean }> = {
    name: 'crm.delete_customer',
    description: 'Destructive deletion — approval gated (spec 03 §3)',
    inputSchema: {
      type: 'object',
      required: ['customer_id'],
      properties: { customer_id: { type: 'string' } },
      additionalProperties: false,
    },
    requiredPermission: { resource: 'customers', action: 'delete' },
    riskClass: 'irreversible',
    approvalGated: true,
    execute: () => Promise.resolve({ deleted: true }),
  };
  registry.register(createEstimate);
  registry.register(deleteCustomer);

  const secrets: SecretsProvider = {
    credentialsFor: () => Promise.resolve({ api_key: 'sk-secret-123' }),
  };
  return new ToolGateway(registry, secrets);
}

const serviceAdvisor: AgentPrincipal = {
  id: 'agent_sa',
  name: 'service_advisor',
  version: 1,
  maxAutonomyLevel: 4,
  grants: [
    { resource: 'estimates', actions: ['create'] },
    { resource: 'customers', actions: ['delete'] },
  ],
};

function makeDeps(tools: ToolGateway) {
  const audit = new InMemoryAuditLog();
  const events: EventEnvelope[] = [];
  const deps: PipelineDeps = { tools, audit, publish: (e) => events.push(e) };
  return { audit, events, deps };
}

describe('agent execution pipeline (spec 03 §2)', () => {
  it('executes a valid, authorized action; injects credentials; audits and emits', async () => {
    const executedWith: { credentials?: Record<string, string> } = {};
    const tools = makeTools(executedWith);
    const { audit, events, deps } = makeDeps(tools);

    const outcome = await runWithTenant(ctx, () =>
      executeProposedAction(
        serviceAdvisor,
        {
          tool: 'crm.create_estimate',
          input: { customer_id: 'cus_1', total: 420 },
          reason: 'customer approved inspection findings',
        },
        deps,
      ),
    );

    expect(outcome.status).toBe('executed');
    // Credentials reached the tool via the gateway, not via the proposed action.
    expect(executedWith.credentials).toEqual({ api_key: 'sk-secret-123' });
    const records = audit.forTenant('org_a');
    expect(records).toHaveLength(1);
    expect(records[0]?.result).toBe('success');
    expect(records[0]?.actor.type).toBe('agent');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('agent.action.completed');
    expect(events[0]?.payload).toEqual({ tool: 'crm.create_estimate', status: 'executed' });
  });

  it('rejects schema-invalid input before anything executes', async () => {
    const tools = makeTools({});
    const { audit, deps } = makeDeps(tools);
    const outcome = await runWithTenant(ctx, () =>
      executeProposedAction(
        serviceAdvisor,
        { tool: 'crm.create_estimate', input: { customer_id: 42 }, reason: 'bad shape' },
        deps,
      ),
    );
    expect(outcome.status).toBe('rejected_schema');
    expect(audit.forTenant('org_a')[0]?.result).toBe('denied');
  });

  it('denies and audits actions outside the agent grants', async () => {
    const tools = makeTools({});
    const { audit, deps } = makeDeps(tools);
    const limited: AgentPrincipal = { ...serviceAdvisor, grants: [] };
    const outcome = await runWithTenant(ctx, () =>
      executeProposedAction(
        limited,
        { tool: 'crm.create_estimate', input: { customer_id: 'c', total: 1 }, reason: 'x' },
        deps,
      ),
    );
    expect(outcome.status).toBe('denied_authorization');
    expect(audit.forTenant('org_a')[0]?.result).toBe('denied');
  });

  it('enforces the autonomy ceiling: below L3 tools cannot execute', async () => {
    const tools = makeTools({});
    const { deps } = makeDeps(tools);
    const drafter: AgentPrincipal = { ...serviceAdvisor, maxAutonomyLevel: 2 };
    const outcome = await runWithTenant(ctx, () =>
      executeProposedAction(
        drafter,
        { tool: 'crm.create_estimate', input: { customer_id: 'c', total: 1 }, reason: 'x' },
        deps,
      ),
    );
    expect(outcome.status).toBe('denied_policy');
  });

  it('parks approval-gated actions as pending, and executes with an approval ref', async () => {
    const tools = makeTools({});
    const { audit, deps } = makeDeps(tools);

    const pending = await runWithTenant(ctx, () =>
      executeProposedAction(
        serviceAdvisor,
        { tool: 'crm.delete_customer', input: { customer_id: 'c1' }, reason: 'gdpr request' },
        deps,
      ),
    );
    expect(pending.status).toBe('pending_approval');

    const approved = await runWithTenant(ctx, () =>
      executeProposedAction(
        serviceAdvisor,
        {
          tool: 'crm.delete_customer',
          input: { customer_id: 'c1' },
          reason: 'gdpr request',
          approvalRef: 'appr_42',
        },
        deps,
      ),
    );
    expect(approved.status).toBe('executed');
    const last = audit.forTenant('org_a').at(-1);
    expect(last?.approval).toBe('appr_42');
  });

  it('unknown tools are rejected — free-text output has no execution path', async () => {
    const tools = makeTools({});
    const { deps } = makeDeps(tools);
    const outcome = await runWithTenant(ctx, () =>
      executeProposedAction(
        serviceAdvisor,
        { tool: 'run_any_sql', input: 'DROP TABLE customers', reason: 'model said so' },
        deps,
      ),
    );
    expect(outcome.status).toBe('rejected_schema');
  });

  it('fails closed outside a tenant context', async () => {
    const tools = makeTools({});
    const { deps } = makeDeps(tools);
    await expect(
      executeProposedAction(
        serviceAdvisor,
        { tool: 'crm.create_estimate', input: { customer_id: 'c', total: 1 }, reason: 'x' },
        deps,
      ),
    ).rejects.toThrow();
  });
});
