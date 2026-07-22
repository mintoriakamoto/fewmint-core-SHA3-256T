import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryMeter,
  ModelGateway,
  anthropicProvider,
  openAiProvider,
  type ModelRequest,
} from '@cooklabs/ai-gateway';

type StubBehavior = 'ok' | 'http_error' | 'malformed';
let anthropicBehavior: StubBehavior = 'ok';
let openaiBehavior: StubBehavior = 'ok';
let lastAnthropicAuth = '';

// One stub server speaking both wire formats, switched by path.
const stub = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/v1/messages') {
      lastAnthropicAuth = String(req.headers['x-api-key'] ?? '');
      if (anthropicBehavior === 'http_error') {
        res.writeHead(429).end('overloaded');
        return;
      }
      if (anthropicBehavior === 'malformed') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"weird": true}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          content: [{ type: 'text', text: 'anthropic says hi' }],
          usage: { input_tokens: 12, output_tokens: 5 },
        }),
      );
      return;
    }
    if (req.url === '/v1/chat/completions') {
      if (openaiBehavior === 'http_error') {
        res.writeHead(500).end('boom');
        return;
      }
      if (openaiBehavior === 'malformed') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices": []}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          choices: [{ message: { content: 'openai says hi' } }],
          usage: { prompt_tokens: 9, completion_tokens: 4 },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
});

let baseUrl = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => stub.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => void stub.close(() => resolve())));

const req: ModelRequest = { tenantId: 'org_a', task: 'summarize', input: 'hello' };

describe('provider adapters', () => {
  it('anthropic adapter maps the wire format and sends the key only as a header', async () => {
    anthropicBehavior = 'ok';
    const provider = anthropicProvider({
      baseUrl,
      model: 'test-model',
      apiKey: 'sk-ant-test',
      costPer1kTokens: 3,
    });
    const completion = await provider.complete(req);
    expect(completion).toEqual({ output: 'anthropic says hi', tokensIn: 12, tokensOut: 5 });
    expect(lastAnthropicAuth).toBe('sk-ant-test');
  });

  it('openai adapter maps the wire format', async () => {
    openaiBehavior = 'ok';
    const provider = openAiProvider({
      baseUrl,
      model: 'test-model',
      apiKey: 'sk-test',
      costPer1kTokens: 1,
    });
    const completion = await provider.complete(req);
    expect(completion).toEqual({ output: 'openai says hi', tokensIn: 9, tokensOut: 4 });
  });

  it('HTTP errors and malformed bodies throw — never fake success', async () => {
    anthropicBehavior = 'http_error';
    const anthropic = anthropicProvider({
      baseUrl,
      model: 'm',
      apiKey: 'k',
      costPer1kTokens: 3,
    });
    await expect(anthropic.complete(req)).rejects.toThrow(/HTTP 429/);

    openaiBehavior = 'malformed';
    const openai = openAiProvider({ baseUrl, model: 'm', apiKey: 'k', costPer1kTokens: 1 });
    await expect(openai.complete(req)).rejects.toThrow(/no message content/);
  });

  it('the gateway falls back from a failing real adapter to the next provider', async () => {
    anthropicBehavior = 'http_error';
    openaiBehavior = 'ok';
    const meter = new InMemoryMeter();
    const gateway = new ModelGateway(
      [
        anthropicProvider({ baseUrl, model: 'm', apiKey: 'k', costPer1kTokens: 3 }),
        openAiProvider({ baseUrl, model: 'm', apiKey: 'k', costPer1kTokens: 1, name: 'local' }),
      ],
      meter,
    );
    const result = await gateway.route(req);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.provider).toBe('local');
    expect(meter.entries.map((e) => e.outcome)).toEqual(['error', 'ok']);
  });
});
