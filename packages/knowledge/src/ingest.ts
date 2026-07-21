import { randomUUID } from 'node:crypto';
import { getTenantContext } from '@cooklabs/tenancy';
import type { Classification, KnowledgeChunk, KnowledgeSource } from './types.js';

export interface IngestInput {
  readonly source: KnowledgeSource;
  readonly text: string;
  readonly classification: Classification;
  readonly permissionResource: string;
  /** Max characters per chunk (paragraphs are merged up to this size). */
  readonly maxChunkChars?: number;
}

/**
 * Controlled ingestion (spec 01 §6): validates, chunks by paragraph windows,
 * and stamps tenant + provenance from the ambient context — never from input.
 */
export function ingest(input: IngestInput): KnowledgeChunk[] {
  const ctx = getTenantContext();
  const text = input.text.trim();
  if (text.length === 0) throw new Error('Refusing to ingest empty content');
  const limit = input.maxChunkChars ?? 800;

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const windows: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length + 2 > limit) {
      windows.push(current);
      current = paragraph;
    } else {
      current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.length > 0) windows.push(current);

  const now = new Date().toISOString();
  return windows.map((chunkText) => ({
    id: randomUUID(),
    tenant_id: ctx.tenantId,
    source: input.source,
    classification: input.classification,
    permissionResource: input.permissionResource,
    text: chunkText,
    provenance: `ingested by ${ctx.actor.type}:${ctx.actor.id}`,
    created_at: now,
  }));
}
