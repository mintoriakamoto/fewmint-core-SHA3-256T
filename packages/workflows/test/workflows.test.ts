import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WorkflowEngine,
  WorkflowValidationError,
  evaluateCondition,
  parseIsoDuration,
  validateDefinition,
  type AgentInvoker,
} from '@cooklabs/workflows';
import {
  ToolGateway,
  ToolRegistry,
  executeProposedAction,
  type AgentPrincipal,
  type ToolDefinition,
} from '@cooklabs/agents';
import { InMemoryAuditLog } from '@cooklabs/audit';
import { runWithTenant, type TenantContext } from '@cooklabs/tenancy';
import packagedSchema from '../src/workflow.schema.json' with { type: 'json' };

const ctx: TenantContext = {
  tenantId: 'org_a',
  organizationId: 'org_a',
  actor: { id: 'system_wf', type: 'system' },
};

const leadQualification = {
  workflow: 'lead_qualification',
  version: 3,
  trigger: { event: 'lead.created' },
  steps: [
    { id: 'normalize', type: 'transformation', map: 'normalize_lead_v1' },
    {
      id: 'route',
      type: 'branch',
      on: 'score >= 80',
      when_true: 'personal_outreach',
      when_false: 'nurture_sequence',
    },
    {
      id: 'personal_outreach',
      type: 'agent_action',
      agent: 'sales_outreach_agent',
      next: 'end_ok',
    },
    {
      id: 'nurture_sequence',
      type: 'api_action',
      action: 'marketing.enroll_nurture',
      next: 'end_ok',
    },
    { id: 'end_ok', type: 'end', result: 'success' },
  ],
};

function makeEngine(agentBehavior: 'executed' | 'denied' = 'executed') {
  const enrolled: string[] = [];
  const outreach: string[] = [];
  const agents: AgentInvoker = {
    invoke: (agentName, _step, context) => {
      if (agentBehavior === 'denied') {
        return Promise.resolve({ status: 'denied_authorization', reason: 'no grant' });
      }
      outreach.push(`${agentName}:${String(context.lead_id)}`);
      return Promise.resolve({ status: 'executed', result: 'contacted' });
    },
  };
  const engine = new WorkflowEngine({
    transformations: {
      normalize_lead_v1: (context) => ({ lead_id: String(context.lead_id).trim().toLowerCase() }),
    },
    actions: {
      'marketing.enroll_nurture': (_params, context) => {
        enrolled.push(String(context.lead_id));
        return Promise.resolve({ enrolled: true });
      },
    },
    agents,
  });
  return { engine, enrolled, outreach };
}

describe('definition validation', () => {
  it('packaged schema is identical to the normative docs schema', () => {
    const docsSchema = JSON.parse(
      readFileSync(join(__dirname, '../../../docs/schemas/workflow.schema.json'), 'utf8'),
    );
    expect(packagedSchema).toEqual(docsSchema);
  });

  it('rejects schema violations and dangling step references', () => {
    expect(() => validateDefinition({ workflow: 'x' })).toThrow(WorkflowValidationError);
    expect(() =>
      validateDefinition({
        workflow: 'x',
        version: 1,
        trigger: { manual: true },
        steps: [{ id: 'a', type: 'transformation', map: 'm', next: 'ghost' }],
      }),
    ).toThrow(/dangling/);
  });
});

describe('engine execution', () => {
  it('runs the spec 06 example: high score routes to the agent', async () => {
    const { engine, outreach, enrolled } = makeEngine();
    const run = await runWithTenant(ctx, () =>
      engine.start(leadQualification, { lead_id: '  LEAD-1 ', score: 91 }),
    );
    expect(run.status).toBe('succeeded');
    expect(run.version).toBe(3);
    expect(run.tenantId).toBe('org_a');
    expect(outreach).toEqual(['sales_outreach_agent:lead-1']);
    expect(enrolled).toEqual([]);
  });

  it('low score routes to the nurture sequence', async () => {
    const { engine, outreach, enrolled } = makeEngine();
    const run = await runWithTenant(ctx, () =>
      engine.start(leadQualification, { lead_id: 'lead-2', score: 40 }),
    );
    expect(run.status).toBe('succeeded');
    expect(enrolled).toEqual(['lead-2']);
    expect(outreach).toEqual([]);
  });

  it('an agent denial fails the run visibly — never silent success', async () => {
    const { engine } = makeEngine('denied');
    const run = await runWithTenant(ctx, () =>
      engine.start(leadQualification, { lead_id: 'lead-3', score: 95 }),
    );
    expect(run.status).toBe('failed');
    expect(run.error).toContain('denied_authorization');
  });

  it('agent_action integrates with the real @cooklabs/agents pipeline', async () => {
    const registry = new ToolRegistry();
    const sendEmail: ToolDefinition<{ to: string }, { sent: boolean }> = {
      name: 'email.send',
      description: 'send outreach email',
      inputSchema: {
        type: 'object',
        required: ['to'],
        properties: { to: { type: 'string' } },
        additionalProperties: false,
      },
      requiredPermission: { resource: 'messages', action: 'create' },
      riskClass: 'reversible',
      execute: () => Promise.resolve({ sent: true }),
    };
    registry.register(sendEmail);
    const tools = new ToolGateway(registry);
    const audit = new InMemoryAuditLog();
    const salesAgent: AgentPrincipal = {
      id: 'agent_sales',
      name: 'sales_outreach_agent',
      version: 1,
      maxAutonomyLevel: 4,
      grants: [{ resource: 'messages', actions: ['create'] }],
    };
    const agents: AgentInvoker = {
      invoke: async (_name, _step, context) =>
        executeProposedAction(
          salesAgent,
          {
            tool: 'email.send',
            input: { to: String(context.lead_id) },
            reason: 'workflow personal outreach',
          },
          { tools, audit, publish: () => undefined },
        ),
    };
    const engine = new WorkflowEngine({
      transformations: { normalize_lead_v1: (c) => ({ lead_id: c.lead_id }) },
      actions: { 'marketing.enroll_nurture': () => Promise.resolve({}) },
      agents,
    });
    const run = await runWithTenant(ctx, () =>
      engine.start(leadQualification, { lead_id: 'lead-9', score: 99 }),
    );
    expect(run.status).toBe('succeeded');
    expect(audit.forTenant('org_a')).toHaveLength(1);
    expect(audit.forTenant('org_a')[0]?.result).toBe('success');
  });

  it('parks on human_approval and resumes with an approval ref', async () => {
    const engine = new WorkflowEngine({
      actions: { 'billing.large_refund': () => Promise.resolve({ refunded: true }) },
    });
    const definition = {
      workflow: 'refund_approval',
      version: 1,
      trigger: { manual: true },
      steps: [
        { id: 'approve', type: 'human_approval', approver_role: 'owner' },
        { id: 'refund', type: 'api_action', action: 'billing.large_refund', output: 'refund' },
        { id: 'done', type: 'end', result: 'success' },
      ],
    };
    const run = await runWithTenant(ctx, () => engine.start(definition, { amount: 900 }));
    expect(run.status).toBe('awaiting_approval');

    const resumed = await runWithTenant(ctx, () => engine.resume(run, 'appr_7'));
    expect(resumed.status).toBe('succeeded');
    expect(resumed.approvalRef).toBe('appr_7');
    expect(resumed.context.refund).toEqual({ refunded: true });
  });

  it('delay parks the run and tick resumes after the duration', async () => {
    const now = 1_000_000;
    const engine = new WorkflowEngine({
      actions: { 'crm.follow_up': () => Promise.resolve('followed-up') },
      now: () => now,
    });
    const definition = {
      workflow: 'wait_then_follow_up',
      version: 1,
      trigger: { manual: true },
      steps: [
        { id: 'wait', type: 'delay', duration: 'PT48H' },
        { id: 'follow_up', type: 'api_action', action: 'crm.follow_up', output: 'fu' },
        { id: 'done', type: 'end', result: 'success' },
      ],
    };
    const run = await runWithTenant(ctx, () => engine.start(definition, {}));
    expect(run.status).toBe('delayed');

    const early = await runWithTenant(ctx, () => engine.tick(run, now + 1000));
    expect(early.status).toBe('delayed');

    const late = await runWithTenant(ctx, () => engine.tick(run, now + 49 * 3600 * 1000));
    expect(late.status).toBe('succeeded');
    expect(late.context.fu).toBe('followed-up');
  });

  it('retry policy retries the following step, then fails visibly', async () => {
    let calls = 0;
    const engine = new WorkflowEngine({
      actions: {
        'flaky.op': () => {
          calls += 1;
          return Promise.reject(new Error('boom'));
        },
      },
    });
    const definition = {
      workflow: 'flaky',
      version: 1,
      trigger: { manual: true },
      steps: [
        { id: 'policy', type: 'retry', attempts: 3 },
        { id: 'op', type: 'api_action', action: 'flaky.op' },
        { id: 'done', type: 'end', result: 'success' },
      ],
    };
    const run = await runWithTenant(ctx, () => engine.start(definition, {}));
    expect(run.status).toBe('failed');
    expect(calls).toBe(3);
    expect(run.error).toContain('after 3 attempt(s)');
  });

  it('pins the definition version against later edits', async () => {
    const { engine } = makeEngine();
    const definition = structuredClone(leadQualification);
    const run = await runWithTenant(ctx, () =>
      engine.start(definition, { lead_id: 'x', score: 10 }),
    );
    (definition as { version: number }).version = 99;
    expect(run.version).toBe(3);
  });

  it('fails closed outside a tenant context', async () => {
    const { engine } = makeEngine();
    await expect(engine.start(leadQualification, { lead_id: 'x', score: 10 })).rejects.toThrow();
  });
});

describe('helpers', () => {
  it('evaluates comparators without eval', () => {
    expect(evaluateCondition('score >= 80', { score: 80 })).toBe(true);
    expect(evaluateCondition('status == approved', { status: 'approved' })).toBe(true);
    expect(evaluateCondition('flag != true', { flag: false })).toBe(true);
    expect(() => evaluateCondition('require("fs")', {})).toThrow();
  });

  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT48H')).toBe(48 * 3600 * 1000);
    expect(parseIsoDuration('P1DT30M')).toBe((24 * 3600 + 1800) * 1000);
    expect(() => parseIsoDuration('48h')).toThrow();
  });
});
