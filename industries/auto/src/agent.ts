import type { Action, Grant } from '@cooklabs/permissions';

/** Shape of an agent-definition manifest (normative: agent-definition.schema.json). */
export interface AgentManifest {
  readonly name: string;
  readonly version: number;
  readonly max_autonomy_level: 0 | 1 | 2 | 3 | 4 | 5;
  readonly tools: readonly string[];
  readonly permissions: readonly {
    readonly resource: string;
    readonly actions: readonly Action[];
    readonly conditions?: Readonly<Record<string, unknown>>;
  }[];
}

/**
 * Compiles a declarative agent manifest into the enforceable principal the
 * runtime consumes (spec 03 §8): grants come from the manifest's permissions
 * block — the prose goal never grants capability.
 */
export function compileServiceAdvisor(manifest: AgentManifest): {
  id: string;
  name: string;
  version: number;
  maxAutonomyLevel: 0 | 1 | 2 | 3 | 4 | 5;
  grants: readonly Grant[];
} {
  const grants: Grant[] = manifest.permissions.map((p) => {
    const base = { resource: p.resource, actions: p.actions };
    return p.conditions !== undefined
      ? { ...base, conditions: p.conditions as NonNullable<Grant['conditions']> }
      : base;
  });
  return {
    id: `agent_${manifest.name}`,
    name: manifest.name,
    version: manifest.version,
    maxAutonomyLevel: manifest.max_autonomy_level,
    grants,
  };
}
