import { Blackboard, type JournalRecord } from '@cooklabs/comms';
import {
  ControlPlane,
  ScoreBoard,
  type HerculesTask,
  type TaskArtifacts,
  type Worker,
} from '@cooklabs/hercules';
import { GitWorktrees, type GitExecFn } from './worktrees.js';

export { GitWorktrees, type GitExecFn, type GitResult } from './worktrees.js';

export interface FactoryOptions {
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  /** Worker registry: the Claude Code CLI adapter, mocks, future adapters. */
  readonly workers: readonly Worker[];
  readonly execFn?: GitExecFn;
  readonly now?: () => number;
}

export interface DispatchResult {
  readonly taskId: string;
  readonly workerId: string;
  readonly outcome: 'built' | 'failed';
  readonly artifacts?: TaskArtifacts;
  readonly error?: string;
}

export interface Factory {
  submit(task: unknown): HerculesTask;
  runReadyTasks(
    category?: string,
    weights?: { correctness?: number; cost?: number; speed?: number },
  ): Promise<DispatchResult[]>;
  review(
    taskId: string,
    reviewerId: string,
    verdict: 'approve' | 'reject',
    evidenceRefs: readonly string[],
  ): HerculesTask;
  merge(taskId: string, merger: Worker): Promise<HerculesTask>;
  readonly plane: ControlPlane;
  readonly board: Blackboard;
  readonly scores: ScoreBoard;
  journal(): readonly JournalRecord[];
}

/**
 * The Software Factory runner (spec 09 as a process): journaled task boards,
 * evidence-based worker selection, real git worktree isolation per task, and
 * git merge only after the control plane's review/gates pass.
 */
export function createFactory(options: FactoryOptions): Factory {
  const journalRecords: JournalRecord[] = [];
  const board = new Blackboard({ journal: (record) => journalRecords.push(record) });
  const plane = new ControlPlane(board);
  const scores = new ScoreBoard();
  const worktrees = new GitWorktrees(options.repoRoot, options.worktreeRoot, options.execFn);
  const workerById = new Map(options.workers.map((worker) => [worker.id, worker]));
  const now = options.now ?? (() => Date.now());

  return {
    plane,
    board,
    scores,
    journal: () => [...journalRecords],

    submit(task: unknown): HerculesTask {
      return plane.addTask(task);
    },

    async runReadyTasks(category = 'general', weights = {}): Promise<DispatchResult[]> {
      const results: DispatchResult[] = [];
      for (const task of plane.readyTasks()) {
        const workerId = scores.selectWorker([...workerById.keys()], category, weights);
        const worker = workerById.get(workerId)!;
        const started = now();
        try {
          const path = await worktrees.create(task.task_id, task.branch);
          (task as { worktree?: string }).worktree = path;
          const artifacts = await plane.dispatch(task.task_id, worker);
          scores.recordOutcome(workerId, category, {
            correct: true,
            costUsd: 0,
            durationMs: now() - started,
          });
          results.push({ taskId: task.task_id, workerId, outcome: 'built', artifacts });
        } catch (err) {
          // Failure honesty: recorded against the worker, task left visible.
          scores.recordOutcome(workerId, category, {
            correct: false,
            costUsd: 0,
            durationMs: now() - started,
          });
          board.post(
            task.task_id,
            { id: workerId, type: 'worker' },
            'status',
            `build failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          results.push({
            taskId: task.task_id,
            workerId,
            outcome: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    },

    review(taskId, reviewerId, verdict, evidenceRefs): HerculesTask {
      return plane.review(taskId, reviewerId, verdict, evidenceRefs);
    },

    async merge(taskId: string, merger: Worker): Promise<HerculesTask> {
      const task = plane.merge(taskId, merger); // ladder + gates checks first
      await worktrees.mergeBranch(task.branch, `Merge ${taskId}: ${task.title}`);
      await worktrees.remove(taskId, task.branch);
      return task;
    },
  };
}
