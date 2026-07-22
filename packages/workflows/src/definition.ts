import { Ajv2020 } from 'ajv/dist/2020.js';
import workflowSchema from './workflow.schema.json' with { type: 'json' };

/** A step as constrained by the normative schema (spec 06 §3). */
export interface WorkflowStep {
  readonly id: string;
  readonly type:
    | 'condition'
    | 'branch'
    | 'loop'
    | 'delay'
    | 'human_approval'
    | 'agent_action'
    | 'agent_conversation'
    | 'api_action'
    | 'database_action'
    | 'notification'
    | 'webhook'
    | 'transformation'
    | 'retry'
    | 'compensation'
    | 'end';
  readonly next?: string;
  readonly on?: string;
  readonly when_true?: string;
  readonly when_false?: string;
  readonly agent?: string;
  readonly action?: string;
  readonly map?: string;
  readonly budget?: { readonly max_cost_usd?: number; readonly max_tokens?: number };
  readonly output?: string;
  readonly approver_role?: string;
  readonly duration?: string;
  readonly max_iterations?: number;
  readonly attempts?: number;
  readonly backoff?: string;
  readonly compensates?: string;
  readonly result?: 'success' | 'failure' | 'cancelled';
  readonly params?: Record<string, unknown>;
}

export interface WorkflowDefinition {
  readonly workflow: string;
  readonly version: number;
  readonly description?: string;
  readonly trigger: {
    readonly event?: string;
    readonly schedule?: string;
    readonly manual?: boolean;
  };
  readonly steps: readonly WorkflowStep[];
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validator = ajv.compile(workflowSchema);

export class WorkflowValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid workflow definition: ${errors.join('; ')}`);
    this.name = 'WorkflowValidationError';
  }
}

/** Validates against the normative JSON Schema (schema wins over prose). */
export function validateDefinition(candidate: unknown): WorkflowDefinition {
  if (!validator(candidate)) {
    throw new WorkflowValidationError(
      (validator.errors ?? []).map(
        (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
      ),
    );
  }
  const definition = candidate as unknown as WorkflowDefinition;
  const ids = new Set(definition.steps.map((s) => s.id));
  const dangling: string[] = [];
  for (const step of definition.steps) {
    for (const ref of [step.next, step.when_true, step.when_false]) {
      if (ref !== undefined && !ids.has(ref)) dangling.push(`${step.id} → ${ref}`);
    }
  }
  if (dangling.length > 0) {
    throw new WorkflowValidationError(dangling.map((d) => `dangling step reference: ${d}`));
  }
  return definition;
}
