/** Permissions ladder (spec 09 §7). */
export const LADDER = {
  1: 'read_repository',
  2: 'create_plans',
  3: 'modify_code_in_branch',
  4: 'run_tests_builds',
  5: 'open_pr',
  6: 'merge_after_gates',
  7: 'deploy_staging',
  8: 'deploy_production',
} as const;

export type LadderLevel = keyof typeof LADDER;

export class LadderViolationError extends Error {
  constructor(workerId: string, level: LadderLevel, max: LadderLevel) {
    super(`Worker ${workerId} attempted L${level} (${LADDER[level]}) but holds max L${max}`);
    this.name = 'LadderViolationError';
  }
}

export class HumanApprovalRequiredError extends Error {
  constructor(workerId: string) {
    super(
      `L8 (deploy_production) requires a human release approval — worker ${workerId} cannot hold it as standing authority`,
    );
    this.name = 'HumanApprovalRequiredError';
  }
}

/**
 * Enforces the ladder for one action. L8 is NEVER standing autonomous
 * authority (spec 09 §7): regardless of the worker's max level, every
 * production deployment requires an explicit human release approval ref.
 */
export function assertCapability(
  worker: { readonly id: string; readonly maxLadderLevel: LadderLevel },
  level: LadderLevel,
  options?: { readonly releaseApproval?: string },
): void {
  if (level > worker.maxLadderLevel) {
    throw new LadderViolationError(worker.id, level, worker.maxLadderLevel);
  }
  if (level === 8 && (options?.releaseApproval === undefined || options.releaseApproval === '')) {
    throw new HumanApprovalRequiredError(worker.id);
  }
}
