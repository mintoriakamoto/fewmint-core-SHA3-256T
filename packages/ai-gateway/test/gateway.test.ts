import { describe, expect, it } from 'vitest';
import {
  InMemoryMeter,
  ModelGateway,
  TenantBudgets,
  type ModelProvider,
  type ModelRequest,
} from '@cooklabs/ai-gateway';

function provider(name: string, behavior: 'ok' | 'error', costPer1kTokens = 1): ModelProvider {
  return {
    name,
    costPer1kTokens,
    complete(request: ModelRequest) {
      if (behavior === 'error') return Promise.reject(new Error(`${name} unavailable`));
      return Promise.resolve({
        output: `${name}: ${request.input}`,
        tokensIn: 500,
        tokensOut: 500,
      });
    },
  };
}

const req: ModelRequest = { tenantId: 'org_a', task: 'summarize', input: 'hello' };

describe('model gateway routing', () => {
  it('uses the preferred provider when healthy', async () => {
    const meter = new InMemoryMeter();
    const gw = new ModelGateway([provider('primary', 'ok'), provider('fallback', 'ok')], meter);
    const result = await gw.route(req);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.provider).toBe('primary');
    expect(meter.entries).toHaveLength(1);
  });

  it('falls back in order and meters failed attempts', async () => {
    const meter = new InMemoryMeter();
    const gw = new ModelGateway(
      [provider('primary', 'error'), provider('secondary', 'error'), provider('local', 'ok')],
      meter,
    );
    const result = await gw.route(req);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.provider).toBe('local');
    expect(meter.entries.map((e) => e.outcome)).toEqual(['error', 'error', 'ok']);
  });

  it('total failure is visible and queued — never fake success', async () => {
    const gw = new ModelGateway(
      [provider('a', 'error'), provider('b', 'error')],
      new InMemoryMeter(),
    );
    const result = await gw.route(req);
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.queued).toBe(true);
      expect(result.attempts).toHaveLength(2);
    }
  });

  it('respects tenant provider policy', async () => {
    const gw = new ModelGateway(
      [provider('cloud', 'ok'), provider('local', 'ok')],
      new InMemoryMeter(),
    );
    const result = await gw.route({ ...req, allowedProviders: ['local'] });
    if (result.status === 'ok') expect(result.provider).toBe('local');
    else expect.fail('expected ok');
  });

  it('denies visibly when the tenant budget is exhausted', async () => {
    const meter = new InMemoryMeter();
    const budgets = new TenantBudgets(meter);
    budgets.setLimit('org_a', 1); // $1
    const gw = new ModelGateway([provider('primary', 'ok', 1)], meter, budgets);

    const first = await gw.route(req); // 1000 tokens * $1/1k = $1 → exhausts budget
    expect(first.status).toBe('ok');
    const second = await gw.route(req);
    expect(second.status).toBe('denied_budget');
  });
});
