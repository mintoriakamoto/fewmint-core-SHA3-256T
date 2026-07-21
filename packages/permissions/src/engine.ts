import type { Action, AttributeValue, Attributes, Condition, Grant } from './types.js';

export interface Decision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly matchedGrant?: Grant;
}

interface AuthorizeInput {
  readonly grants: readonly Grant[];
  readonly resource: string;
  readonly action: Action;
  readonly actorId: string;
  /** Attributes of the target resource/context evaluated by ABAC conditions. */
  readonly attributes?: Attributes;
}

/**
 * Deny-by-default authorization (spec 02 §1). A single shared engine —
 * feature code must not hand-roll checks. An action is allowed only when a
 * grant covers the resource + action AND every ABAC condition holds.
 */
export function authorize(input: AuthorizeInput): Decision {
  const { grants, resource, action, actorId, attributes = {} } = input;

  const candidates = grants.filter((g) => g.resource === resource && g.actions.includes(action));
  if (candidates.length === 0) {
    return { allowed: false, reason: `no grant for ${action} on ${resource}` };
  }

  for (const grant of candidates) {
    const failed = failedCondition(grant, actorId, attributes);
    if (failed === undefined) {
      return { allowed: true, reason: `granted ${action} on ${resource}`, matchedGrant: grant };
    }
  }
  return {
    allowed: false,
    reason: `conditions not satisfied for ${action} on ${resource}`,
  };
}

function failedCondition(
  grant: Grant,
  actorId: string,
  attributes: Attributes,
): string | undefined {
  if (!grant.conditions) return undefined;
  for (const [attribute, condition] of Object.entries(grant.conditions)) {
    const actual = attributes[attribute];
    if (actual === undefined) return attribute; // unknown attribute → condition fails (deny)
    if (!holds(condition, actual, actorId)) return attribute;
  }
  return undefined;
}

function holds(condition: Condition, actual: AttributeValue, actorId: string): boolean {
  if (condition === null || typeof condition !== 'object') {
    return actual === resolve(condition, actorId);
  }
  const { op, value } = condition;
  if (op === 'in') {
    const values = Array.isArray(value) ? value : [value];
    return values.some((v) => actual === resolve(v as AttributeValue, actorId));
  }
  const expected = resolve(value as AttributeValue, actorId);
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
  }
}

function resolve(value: AttributeValue, actorId: string): AttributeValue {
  return value === '$actor.id' ? actorId : value;
}
