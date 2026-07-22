import type { ModelProvider, ModelRequest, ProviderCompletion } from '../gateway.js';

export interface OpenAiProviderConfig {
  readonly baseUrl: string;
  readonly model: string;
  /** Injected by the caller (secrets manager) — never logged, never re-read. */
  readonly apiKey: string;
  readonly costPer1kTokens: number;
  readonly name?: string;
}

/** OpenAI-compatible Chat Completions adapter — also covers local inference
 *  servers speaking this wire format (spec 08 §1). */
export function openAiProvider(config: OpenAiProviderConfig): ModelProvider {
  return {
    name: config.name ?? 'openai',
    costPer1kTokens: config.costPer1kTokens,
    async complete(request: ModelRequest): Promise<ProviderCompletion> {
      const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
          messages: [{ role: 'user', content: request.input }],
        }),
      });
      if (!res.ok) {
        throw new Error(`openai provider HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string') {
        throw new Error('openai provider returned no message content');
      }
      return {
        output: text,
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
      };
    },
  };
}
