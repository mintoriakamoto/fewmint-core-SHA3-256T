import type { LadderLevel } from './ladder.js';
import type { HerculesTask } from './control-plane.js';

/** The context package handed to a worker (spec 09 §4). */
export interface ContextPackage {
  readonly goal: string;
  readonly relevantFiles: readonly string[];
  readonly architectureRules: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly forbiddenChanges: readonly string[];
  readonly allowedPaths: readonly string[];
}

export interface TaskArtifacts {
  readonly commits: readonly string[];
  readonly testReport: string;
  readonly notes?: string;
}

/**
 * The worker adapter seam (spec 09 §2, ADR-0002): Claude Code, Codex/Cursor,
 * Hermes, MimoCode, Grok Build, and local models plug in behind this
 * interface as CLI/API adapters. The control plane never cares which.
 */
export interface Worker {
  readonly id: string;
  readonly maxLadderLevel: LadderLevel;
  run(task: HerculesTask, context: ContextPackage): Promise<TaskArtifacts>;
}
