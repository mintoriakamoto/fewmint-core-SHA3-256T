/** Canonical v1 actions (spec 02 §3). Bulk export is distinct from read. */
export const ACTIONS = [
  'read',
  'list',
  'create',
  'update',
  'delete',
  'export',
  'approve',
  'assign',
  'execute',
] as const;

export type Action = (typeof ACTIONS)[number];

export type AttributeValue = string | number | boolean | null;
export type Attributes = Readonly<Record<string, AttributeValue>>;

export type ConditionOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' | 'in';

/**
 * ABAC condition on a resource attribute. A primitive value means strict
 * equality. The token '$actor.id' resolves to the acting identity, so
 * { assigned_to: '$actor.id' } expresses "only records assigned to me".
 */
export type Condition =
  | AttributeValue
  | { readonly op: ConditionOperator; readonly value: AttributeValue | readonly AttributeValue[] };

export interface Grant {
  readonly resource: string;
  readonly actions: readonly Action[];
  readonly conditions?: Readonly<Record<string, Condition>>;
}

export interface Role {
  readonly name: string;
  readonly grants: readonly Grant[];
}
