import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '@cooklabs/workflows';
import { MessageBus } from '@cooklabs/comms';
import { runWithTenant, type TenantContext } from '@cooklabs/tenancy';

const ctx: TenantContext = {
  tenantId: 'org_shop',
  organizationId: 'org_shop',
  actor: { id: 'system_wf', type: 'system' },
};

const definition = {
  workflow: 'parts_availability_check',
  version: 1,
  trigger: { event: 'estimate.created' },
  steps: [
    {
      id: 'ask_parts',
      type: 'agent_conversation',
      agent: 'service_advisor',
      params: { to: 'parts_agent', content: 'availability for {{part}}?' },
      output: 'parts_reply',
    },
    {
      id: 'route',
      type: 'branch',
      on: 'parts_reply.performative == answer',
      when_true: 'done_ok',
      when_false: 'escalated',
    },
    { id: 'done_ok', type: 'end', result: 'success' },
    { id: 'escalated', type: 'end', result: 'failure' },
  ],
};

describe('agent_conversation workflow step (spec 06 + 14)', () => {
  it('asks a peer agent over the real bus and branches on the reply', async () => {
    const bus = new MessageBus();
    bus.register('service_advisor');
    bus.register('parts_agent', (message) =>
      Promise.resolve({
        performative: 'answer' as const,
        content: `in stock: ${message.content}`,
      }),
    );
    const engine = new WorkflowEngine({ bus });
    const run = await runWithTenant(ctx, () => engine.start(definition, { part: 'brake_pads' }));
    expect(run.status).toBe('succeeded');
    const reply = run.context.parts_reply as { performative: string; content: string };
    expect(reply.performative).toBe('answer');
    expect(reply.content).toBe('in stock: availability for brake_pads?');
  });

  it('a silent peer fails the run visibly — never fake success', async () => {
    const bus = new MessageBus();
    bus.register('service_advisor');
    bus.register('parts_agent'); // no handler → no reply
    const engine = new WorkflowEngine({ bus });
    const run = await runWithTenant(ctx, () => engine.start(definition, { part: 'rotors' }));
    expect(run.status).toBe('failed');
    expect(run.error).toContain('no reply from parts_agent');
  });

  it('schema rejects agent_conversation without agent/params', async () => {
    const engine = new WorkflowEngine({});
    await expect(
      runWithTenant(ctx, () =>
        engine.start(
          {
            workflow: 'bad',
            version: 1,
            trigger: { manual: true },
            steps: [{ id: 'x', type: 'agent_conversation' }],
          },
          {},
        ),
      ),
    ).rejects.toThrow(/Invalid workflow definition/);
  });
});
