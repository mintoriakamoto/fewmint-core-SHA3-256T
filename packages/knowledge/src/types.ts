/** Data classification levels (spec 12 §6), least to most sensitive. */
export const CLASSIFICATIONS = [
  'public',
  'internal',
  'confidential',
  'restricted',
  'highly_sensitive',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(level: Classification): number {
  return CLASSIFICATIONS.indexOf(level);
}

export interface KnowledgeSource {
  readonly id: string;
  readonly title: string;
  readonly uri?: string;
}

/**
 * A retrievable chunk (spec 01 §6): tenant, provenance, classification, and
 * the permission resource a reader must hold `read` on. Classification and
 * permissions travel with the data — retrieval inherits them.
 */
export interface KnowledgeChunk {
  readonly id: string;
  readonly tenant_id: string;
  readonly source: KnowledgeSource;
  readonly classification: Classification;
  /** Resource name checked via @cooklabs/permissions on retrieval. */
  readonly permissionResource: string;
  readonly text: string;
  readonly provenance: string;
  readonly created_at: string;
}
