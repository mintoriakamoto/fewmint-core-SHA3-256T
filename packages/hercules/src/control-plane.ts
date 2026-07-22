import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import taskSchema from './hercules-task.schema.json' with { type: 'json' };
import { assertCapability } from './ladder.js';
import type { ContextPackage, TaskArtifacts, Worker } from './workers.js';

export type TaskStatus =
  | 'draft'
  | 'ready'
  | 'assigned'
  | 'in_progress'
  | 'self_test'
  | 'in_review'
  | 'gates'
  | 'evaluation'
  | 'pr_open'
  | 'merged'
  | 'rejected'
  | 'cancelled';

export interface HerculesTask {
  readonly task_id: string;
  readonly epic_id?: string;
  readonly title: string;
  readonly specification: string;
  readonly owner: string;
  readonly branch: string;
  readonly worktree?: string;
  readonly dependencies?: readonly string[];
  readonly allowed_paths: readonly string[];
  readonly forbidden_changes?: readonly string[];
  readonly acceptance_criteria: readonly string[];
  readonly tests?: readonly string[];
  readonly security_requirements?: readonly string[];
  readonly context?: {
    readonly relevant_files?: readonly string[];
    readonly architecture_rules?: readonly string[];
    readonly interfaces?: readonly string[];
    readonly expected_output?: string;
  };
  status: TaskStatus;
  artifacts: string[];
}

export class TaskValidationError extends Error {
  constructor(public readonly errors: readonly string[]) {
    super(`Invalid Hercules task: ${errors.join('; ')}`);
    this.name = 'TaskValidationError';
  }
}

export class DependencyCycleError extends Error {
  constructor(cycle: readonly string[]) {
    super(`Task dependency cycle: ${cycle.join(' → ')}`);
    this.name = 'DependencyCycleError';
  }
}

const addFormats =
  (addFormatsModule as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateTask = ajv.compile(taskSchema);

/**
 * Hercules control plane (spec 09 §3–§4): structured task state, dependency
 * DAG, and the dispatch protocol. In-memory v1 — the contract a Postgres
 * control database must preserve. Not a coding agent: it plans, assigns,
 * gates, and records; workers do the building.
 */
export class ControlPlane {
  private readonly tasks = new Map<string, HerculesTask>();

  addTask(input: unknown): HerculesTask {
    if (!validateTask(input)) {
      throw new TaskValidationError(
        (validateTask.errors ?? []).map(
          (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
        ),
      );
    }
    const task = structuredClone(input) as unknown as HerculesTask;
    if (this.tasks.has(task.task_id)) {
      throw new TaskValidationError([`duplicate task_id ${task.task_id}`]);
    }
    this.tasks.set(task.task_id, task);
    this.assertAcyclic(task.task_id);
    return task;
  }

  get(taskId: string): HerculesTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return task;
  }

  /** Tasks whose dependencies are ALL merged and are ready to assign. */
  readyTasks(): HerculesTask[] {
    return [...this.tasks.values()].filter(
      (task) =>
        task.status === 'ready' &&
        (task.dependencies ?? []).every((dep) => this.tasks.get(dep)?.status === 'merged'),
    );
  }

  markStatus(taskId: string, status: TaskStatus): HerculesTask {
    const task = this.get(taskId);
    task.status = status;
    return task;
  }

  /** Builds the worker context package from the task record (spec 09 §4). */
  contextPackage(taskId: string): ContextPackage {
    const task = this.get(taskId);
    return {
      goal: task.specification,
      relevantFiles: task.context?.relevant_files ?? [],
      architectureRules: task.context?.architecture_rules ?? [],
      acceptanceCriteria: task.acceptance_criteria,
      forbiddenChanges: task.forbidden_changes ?? [],
      allowedPaths: task.allowed_paths,
    };
  }

  /**
   * Dispatches one ready task to a worker: L3 (branch code) + L4 (tests) are
   * exercised by the worker run; artifacts are recorded as evidence. The
   * task lands in in_review — a DIFFERENT actor reviews (spec 09 §5); the
   * control plane never marks merged just because a worker said "done".
   */
  async dispatch(taskId: string, worker: Worker): Promise<TaskArtifacts> {
    const task = this.get(taskId);
    if (task.status !== 'ready' && task.status !== 'assigned') {
      throw new Error(`task ${taskId} is not dispatchable (status ${task.status})`);
    }
    const unmet = (task.dependencies ?? []).filter(
      (dep) => this.tasks.get(dep)?.status !== 'merged',
    );
    if (unmet.length > 0) {
      throw new Error(`task ${taskId} has unmet dependencies: ${unmet.join(', ')}`);
    }
    assertCapability(worker, 3);
    assertCapability(worker, 4);
    task.status = 'in_progress';
    const artifacts = await worker.run(task, this.contextPackage(taskId));
    task.artifacts.push(...artifacts.commits, artifacts.testReport);
    task.status = 'in_review';
    return artifacts;
  }

  /** Review + gates verdict from a reviewer that must differ from the owner. */
  review(taskId: string, reviewerId: string, verdict: 'approve' | 'reject'): HerculesTask {
    const task = this.get(taskId);
    if (task.status !== 'in_review') throw new Error(`task ${taskId} is not in review`);
    if (reviewerId === task.owner) {
      throw new Error(`reviewer must differ from owner ${task.owner} (spec 09 §5)`);
    }
    task.status = verdict === 'approve' ? 'gates' : 'rejected';
    return task;
  }

  /** Gates passed → PR → merge, with ladder enforcement on the merging actor. */
  merge(taskId: string, merger: Worker): HerculesTask {
    const task = this.get(taskId);
    if (task.status !== 'gates') throw new Error(`task ${taskId} has not passed review/gates`);
    assertCapability(merger, 5);
    assertCapability(merger, 6);
    task.status = 'merged';
    return task;
  }

  private assertAcyclic(startId: string): void {
    const visiting = new Set<string>();
    const path: string[] = [];
    const visit = (id: string): void => {
      if (visiting.has(id)) {
        this.tasks.delete(startId);
        throw new DependencyCycleError([...path, id]);
      }
      visiting.add(id);
      path.push(id);
      for (const dep of this.tasks.get(id)?.dependencies ?? []) {
        if (this.tasks.has(dep)) visit(dep);
      }
      visiting.delete(id);
      path.pop();
    };
    visit(startId);
  }
}
