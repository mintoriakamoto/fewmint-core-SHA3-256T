import { execFile } from 'node:child_process';

export interface GitResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export type GitExecFn = (
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<GitResult>;

const defaultExec: GitExecFn = (args, options) =>
  new Promise((resolve) => {
    execFile('git', [...args], { cwd: options.cwd }, (error, stdout, stderr) => {
      const exitCode =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? ((error as { code: number }).code ?? 1)
          : error
            ? 1
            : 0;
      resolve({ stdout: `${String(stdout)}${String(stderr)}`, exitCode });
    });
  });

const SAFE_TASK = /^[A-Z][A-Z0-9]*-\d+$/;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

/**
 * Real git worktree isolation (spec 09 §4): one branch + worktree per task,
 * merged to the base branch only after the control plane's gates pass.
 */
export class GitWorktrees {
  constructor(
    private readonly repoRoot: string,
    private readonly worktreeRoot: string,
    private readonly exec: GitExecFn = defaultExec,
  ) {}

  private async git(args: readonly string[], cwd = this.repoRoot): Promise<string> {
    const result = await this.exec(args, { cwd });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stdout.trim()}`);
    }
    return result.stdout;
  }

  worktreePath(taskId: string): string {
    if (!SAFE_TASK.test(taskId)) throw new Error(`Unsafe task id: ${taskId}`);
    return `${this.worktreeRoot.replace(/\/$/, '')}/${taskId.toLowerCase()}`;
  }

  /** Creates the task's branch + worktree off `base` (default HEAD). */
  async create(taskId: string, branch: string, base = 'HEAD'): Promise<string> {
    if (!SAFE_BRANCH.test(branch)) throw new Error(`Unsafe branch name: ${branch}`);
    if (!SAFE_BRANCH.test(base)) throw new Error(`Unsafe base ref: ${base}`);
    const path = this.worktreePath(taskId);
    await this.git(['worktree', 'add', '-b', branch, path, base]);
    return path;
  }

  async remove(taskId: string, branch?: string): Promise<void> {
    const path = this.worktreePath(taskId);
    await this.git(['worktree', 'remove', '--force', path]);
    if (branch !== undefined) {
      if (!SAFE_BRANCH.test(branch)) throw new Error(`Unsafe branch name: ${branch}`);
      await this.git(['branch', '-D', branch]);
    }
  }

  /** Merges the task branch into the CURRENT base-repo branch (post-gates only). */
  async mergeBranch(branch: string, message: string): Promise<void> {
    if (!SAFE_BRANCH.test(branch)) throw new Error(`Unsafe branch name: ${branch}`);
    await this.git(['merge', '--no-ff', '-m', message, branch]);
  }
}
