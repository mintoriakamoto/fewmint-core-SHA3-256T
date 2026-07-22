import { randomUUID } from 'node:crypto';
import { getTenantContext } from '@cooklabs/tenancy';
import { validateDefinition, type WorkflowDefinition, type WorkflowStep } from './definition.js';

export type RunStatus =
  'running' | 'succeeded' | 'failed' | 'cancelled' | 'awaiting_approval' | 'delayed';

export interface StepRecord {
  readonly stepId: string;
  readonly type: string;
  readonly status: 'succeeded' | 'failed' | 'awaiting_approval' | 'delayed' | 'denied';
  readonly detail?: string;
  readonly attempts: number;
}

export interface WorkflowRun {
  readonly runId: string;
  readonly workflow: string;
  /** Runs pin the version they started on (spec 06 §4). */
  readonly version: number;
  readonly tenantId: string;
  status: RunStatus;
  /** Named values produced by steps (`output`) plus the trigger payload. */
  readonly context: Record<string, unknown>;
  readonly steps: StepRecord[];
  currentStepId: string | undefined;
  approvalRef?: string;
  resumeAt?: number;
  error?: string;
}

/**
 * Bridges agent_action steps to the agent runtime. Production wiring calls
 * @cooklabs/agents executeProposedAction — the pipeline gates (schema, authz,
 * autonomy, approval) apply unchanged; the engine only sees the outcome.
 */
export interface AgentInvoker {
  invoke(
    agentName: string,
    step: WorkflowStep,
    context: Readonly<Record<string, unknown>>,
  ): Promise<{ status: string; result?: unknown; reason?: string }>;
}

type Transformation = (context: Readonly<Record<string, unknown>>) => Record<string, unknown>;
type ActionHandler = (
  params: Readonly<Record<string, unknown>>,
  context: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/**
 * Safe comparator evaluation over the run context — `"score >= 80"`. This is
 * a deliberate non-Turing-complete parser; workflow conditions never eval code.
 */
export function evaluateCondition(
  expression: string,
  context: Readonly<Record<string, unknown>>,
): boolean {
  const match = expression.match(/^\s*([A-Za-z_][\w.]*)\s*(>=|<=|==|!=|>|<)\s*(.+?)\s*$/);
  if (!match) throw new Error(`Unsupported condition expression: ${expression}`);
  const [, name, op, rawLiteral] = match as unknown as [string, string, string, string];
  const actual = name.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, context);
  let expected: unknown;
  if (/^-?\d+(\.\d+)?$/.test(rawLiteral)) expected = Number(rawLiteral);
  else if (rawLiteral === 'true' || rawLiteral === 'false') expected = rawLiteral === 'true';
  else expected = rawLiteral.replace(/^['"]|['"]$/g, '');
  switch (op) {
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case '>=':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    case '<':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected;
    case '<=':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
    default:
      throw new Error(`Unsupported operator: ${op}`);
  }
}

/** Parses the subset of ISO-8601 durations the DSL uses (PnDTnHnMnS). */
export function parseIsoDuration(duration: string): number {
  const match = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) throw new Error(`Unsupported ISO-8601 duration: ${duration}`);
  const [, d, h, m, s] = match;
  const ms =
    (Number(d ?? 0) * 24 * 3600 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0)) *
    1000;
  if (ms === 0) throw new Error(`Zero-length duration: ${duration}`);
  return ms;
}

/**
 * Structural port to the agent message bus (spec 14) — satisfied by
 * @cooklabs/comms MessageBus without a hard dependency.
 */
export interface ConversationPort {
  request(
    from: { readonly id: string; readonly type: 'agent' },
    to: string,
    content: string,
    taskRef?: string,
  ): Promise<{ readonly performative: string; readonly content: string } | undefined>;
}

export interface EngineDeps {
  readonly transformations?: Readonly<Record<string, Transformation>>;
  readonly actions?: Readonly<Record<string, ActionHandler>>;
  readonly agents?: AgentInvoker;
  readonly bus?: ConversationPort;
  readonly notify?: (message: string, context: Readonly<Record<string, unknown>>) => void;
  readonly now?: () => number;
}

/**
 * Workflow engine (spec 06). Executes a versioned definition step by step.
 * Failed steps follow retry policy then land in a visible failed state; runs
 * park on human_approval/delay and resume explicitly — never silent success.
 */
export class WorkflowEngine {
  constructor(private readonly deps: EngineDeps = {}) {}

  async start(
    definitionInput: unknown,
    triggerPayload: Record<string, unknown> = {},
  ): Promise<WorkflowRun> {
    const definition = validateDefinition(definitionInput);
    const ctx = getTenantContext(); // tenant-scoped, fail closed
    const run: WorkflowRun = {
      runId: randomUUID(),
      workflow: definition.workflow,
      version: definition.version,
      tenantId: ctx.tenantId,
      status: 'running',
      context: { ...triggerPayload },
      steps: [],
      currentStepId: definition.steps[0]?.id,
    };
    // Pin the definition by value so later edits never affect in-flight runs.
    this.definitions.set(run.runId, structuredClone(definition) as WorkflowDefinition);
    await this.advance(run);
    return run;
  }

  /** Continues a run parked in awaiting_approval with a granted approval. */
  async resume(run: WorkflowRun, approvalRef: string): Promise<WorkflowRun> {
    if (run.status !== 'awaiting_approval') {
      throw new Error(`Run ${run.runId} is not awaiting approval (status: ${run.status})`);
    }
    run.approvalRef = approvalRef;
    run.context['approval_ref'] = approvalRef; // visible to downstream steps
    run.status = 'running';
    const definition = this.definition(run);
    const step = definition.steps.find((s) => s.id === run.currentStepId);
    this.record(run, step!, 'succeeded', `approved: ${approvalRef}`, 1);
    run.currentStepId = this.follow(definition, step!);
    await this.advance(run);
    return run;
  }

  /** Wakes delayed runs whose resume time has passed. */
  async tick(run: WorkflowRun, now: number): Promise<WorkflowRun> {
    if (run.status !== 'delayed' || run.resumeAt === undefined || now < run.resumeAt) return run;
    run.status = 'running';
    delete run.resumeAt;
    await this.advance(run);
    return run;
  }

  private readonly definitions = new Map<string, WorkflowDefinition>();

  private definition(run: WorkflowRun): WorkflowDefinition {
    const definition = this.definitions.get(run.runId);
    if (!definition) throw new Error(`Unknown run ${run.runId}`);
    return definition;
  }

  private record(
    run: WorkflowRun,
    step: WorkflowStep,
    status: StepRecord['status'],
    detail: string | undefined,
    attempts: number,
  ): void {
    run.steps.push({
      stepId: step.id,
      type: step.type,
      ...(detail !== undefined ? { detail } : {}),
      status,
      attempts,
    });
  }

  private follow(definition: WorkflowDefinition, step: WorkflowStep): string | undefined {
    if (step.next !== undefined) return step.next;
    const index = definition.steps.findIndex((s) => s.id === step.id);
    return definition.steps[index + 1]?.id;
  }

  private async advance(run: WorkflowRun): Promise<void> {
    const definition = this.definition(run);
    let pendingRetry: { attempts: number } | undefined;

    while (run.status === 'running' && run.currentStepId !== undefined) {
      const step = definition.steps.find((s) => s.id === run.currentStepId);
      if (!step) {
        run.status = 'failed';
        run.error = `unknown step ${run.currentStepId}`;
        return;
      }

      if (step.type === 'end') {
        this.record(run, step, 'succeeded', step.result, 1);
        run.status =
          step.result === 'success'
            ? 'succeeded'
            : step.result === 'cancelled'
              ? 'cancelled'
              : 'failed';
        run.currentStepId = undefined;
        return;
      }

      if (step.type === 'human_approval') {
        this.record(run, step, 'awaiting_approval', step.approver_role, 1);
        run.status = 'awaiting_approval';
        return; // parked; resume() continues
      }

      if (step.type === 'delay') {
        const now = this.deps.now?.() ?? Date.now();
        run.resumeAt = now + parseIsoDuration(step.duration ?? 'PT1H');
        this.record(run, step, 'delayed', step.duration, 1);
        run.status = 'delayed';
        run.currentStepId = this.follow(definition, step);
        return; // parked; tick() continues
      }

      if (step.type === 'branch') {
        const branch = evaluateCondition(step.on!, run.context)
          ? step.when_true!
          : step.when_false!;
        this.record(run, step, 'succeeded', `→ ${branch}`, 1);
        run.currentStepId = branch;
        continue;
      }

      if (step.type === 'retry') {
        pendingRetry = { attempts: step.attempts ?? 1 };
        this.record(run, step, 'succeeded', `policy for next step: ${step.attempts} attempts`, 1);
        run.currentStepId = this.follow(definition, step);
        continue;
      }

      const maxAttempts = pendingRetry?.attempts ?? 1;
      pendingRetry = undefined;
      let attempt = 0;
      let lastError = '';
      let done = false;
      while (attempt < maxAttempts && !done) {
        attempt += 1;
        try {
          await this.executeStep(run, step);
          done = true;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
      if (!done) {
        this.record(run, step, 'failed', lastError, attempt);
        run.status = 'failed';
        run.error = `step ${step.id} failed after ${attempt} attempt(s): ${lastError}`;
        return; // visible failure — never silent success
      }
      this.record(run, step, 'succeeded', undefined, attempt);
      run.currentStepId = this.follow(definition, step);
    }
    if (run.status === 'running') {
      run.status = 'failed';
      run.error = 'workflow ended without an end step';
    }
  }

  private async executeStep(run: WorkflowRun, step: WorkflowStep): Promise<void> {
    switch (step.type) {
      case 'transformation': {
        const fn = this.deps.transformations?.[step.map ?? ''];
        if (!fn) throw new Error(`unknown transformation ${step.map}`);
        Object.assign(run.context, fn(run.context));
        return;
      }
      case 'api_action':
      case 'database_action': {
        const handler = this.deps.actions?.[step.action ?? ''];
        if (!handler) throw new Error(`unknown action ${step.action}`);
        const result = await handler(step.params ?? {}, run.context);
        if (step.output !== undefined) run.context[step.output] = result;
        return;
      }
      case 'agent_action': {
        if (!this.deps.agents) throw new Error('no agent invoker configured');
        const outcome = await this.deps.agents.invoke(step.agent!, step, run.context);
        if (outcome.status !== 'executed') {
          throw new Error(`agent ${step.agent} outcome ${outcome.status}: ${outcome.reason ?? ''}`);
        }
        if (step.output !== undefined) run.context[step.output] = outcome.result;
        return;
      }
      case 'agent_conversation': {
        // spec 06/14: the initiating agent asks a peer over the bus; the
        // templated content may reference run context via {{var}}.
        if (!this.deps.bus) throw new Error('no conversation bus configured');
        const to = String(step.params?.['to'] ?? '');
        const template = String(step.params?.['content'] ?? '');
        if (to === '' || template === '') {
          throw new Error('agent_conversation requires params.to and params.content');
        }
        const content = template.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
          String(run.context[name] ?? ''),
        );
        const reply = await this.deps.bus.request(
          { id: step.agent!, type: 'agent' },
          to,
          content,
          run.runId,
        );
        if (reply === undefined) {
          throw new Error(`agent_conversation: no reply from ${to}`); // visible failure
        }
        if (step.output !== undefined) {
          run.context[step.output] = { performative: reply.performative, content: reply.content };
        }
        return;
      }
      case 'notification': {
        this.deps.notify?.(step.params?.message as string, run.context);
        return;
      }
      case 'condition': {
        run.context[step.output ?? `${step.id}_result`] = evaluateCondition(step.on!, run.context);
        return;
      }
      default:
        throw new Error(`step type ${step.type} not supported in v1 engine`);
    }
  }
}
