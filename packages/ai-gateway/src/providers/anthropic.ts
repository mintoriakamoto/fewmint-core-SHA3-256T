import type { ModelProvider, ModelRequest, ProviderCompletion } from '../gateway.js';

export interface AnthropicProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  /** Injected by the caller (secrets manager) — never logged, never re-read. */
  readonly apiKey: string;
  readonly costPer1kTokens: number;
  readonly name?: string;
}

/** Anthropic-compatible Messages API adapter (spec 08 §1). */
export function anthropicProvider(config: AnthropicProviderConfig): ModelProvider {
  return {
    name: config.name ?? 'anthropic',
    costPer1kTokens: config.costPer1kTokens,
    async complete(request: ModelRequest): Promise<ProviderCompletion> {
      const res = await fetch(`${config.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: request.maxTokens ?? 1024,
          messages: [{ role: 'user', content: request.input }],
        }),
      });
      if (!res.ok) {
        throw new Error(`anthropic provider HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = data.content?.find((c) => c.type === 'text')?.text;
      if (typeof text !== 'string') {
        throw new Error('anthropic provider returned no text content');
      }
      return {
        output: text,
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0,
      };
    },
  };
}
