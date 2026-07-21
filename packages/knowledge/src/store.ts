import { authorize, type Grant } from '@cooklabs/permissions';
import { getTenantContext } from '@cooklabs/tenancy';
import { classificationRank, type Classification, type KnowledgeChunk } from './types.js';

export interface SearchOptions {
  /** The reader's compiled grants; chunks they cannot `read` are invisible. */
  readonly grants: readonly Grant[];
  /** Highest classification the reader is cleared for. */
  readonly classificationCeiling: Classification;
  readonly limit?: number;
}

/**
 * Retrieved content is DATA, not instructions (spec 12 §3). The kind tag is
 * load-bearing: prompt assembly places these in a data channel and must never
 * concatenate them into system instructions.
 */
export interface RetrievedPassage {
  readonly kind: 'untrusted_data';
  readonly text: string;
  readonly score: number;
  readonly citation: {
    readonly sourceId: string;
    readonly sourceTitle: string;
    readonly chunkId: string;
    readonly uri?: string;
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * In-memory stand-in for the hybrid (vector + keyword) index. The isolation
 * contract is what matters and is permanent: tenant, classification, and
 * permission filters apply at the index level, BEFORE scoring — a swap to a
 * real vector store must preserve exactly this filter-then-rank shape.
 */
export class InMemoryHybridIndex {
  private readonly chunks: KnowledgeChunk[] = [];

  add(chunks: readonly KnowledgeChunk[]): void {
    this.chunks.push(...chunks);
  }

  search(query: string, options: SearchOptions): RetrievedPassage[] {
    const ctx = getTenantContext(); // tenant filter is never optional
    const ceiling = classificationRank(options.classificationCeiling);
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];

    const eligible = this.chunks.filter(
      (chunk) =>
        chunk.tenant_id === ctx.tenantId &&
        classificationRank(chunk.classification) <= ceiling &&
        authorize({
          grants: options.grants,
          resource: chunk.permissionResource,
          action: 'read',
          actorId: ctx.actor.id,
        }).allowed,
    );

    const scored = eligible
      .map((chunk) => {
        const tokens = tokenize(chunk.text);
        const overlap = tokens.filter((t) => queryTokens.has(t)).length;
        return { chunk, score: tokens.length === 0 ? 0 : overlap / Math.sqrt(tokens.length) };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 5);

    return scored.map(({ chunk, score }) => ({
      kind: 'untrusted_data',
      text: chunk.text,
      score,
      citation: {
        sourceId: chunk.source.id,
        sourceTitle: chunk.source.title,
        chunkId: chunk.id,
        ...(chunk.source.uri !== undefined ? { uri: chunk.source.uri } : {}),
      },
    }));
  }
}
