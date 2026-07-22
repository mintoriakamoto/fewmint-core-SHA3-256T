import { execFile } from 'node:child_process';
import type { LadderLevel } from '../ladder.js';
import type { ContextPackage, TaskArtifacts, Worker } from '../workers.js';
import type { HerculesTask } from '../control-plane.js';

export interface ExecResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export type ExecFn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string },
) => Promise<ExecResult>;

const defaultExec: ExecFn = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => {
        const exitCode =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({ stdout: String(stdout), exitCode });
      },
    );
  });

export interface ClaudeCodeWorkerOptions {
  readonly id?: string;
  /** Builders build and test; merging stays above them (spec 09 §7). */
  readonly maxLadderLevel?: LadderLevel;
  readonly cliPath?: string;
  /** Root under which per-task worktrees live (task.worktree wins if set). */
  readonly worktreeRoot?: string;
  /** Injected for tests; defaults to spawning the real CLI. */
  readonly execFn?: ExecFn;
}

/**
 * Worker adapter for the Claude Code CLI (ADR-0002: workers are CLI/API
 * adapters behind one interface). The context package becomes the prompt —
 * including allowed paths and forbidden changes — and the run must return
 * machine-readable artifacts. Anything else is a failed run, never success.
 */
export function claudeCodeWorker(options: ClaudeCodeWorkerOptions = {}): Worker {
  const execFn = options.execFn ?? defaultExec;
  const cliPath = options.cliPath ?? 'claude';
  return {
    id: options.id ?? 'claude_code',
    maxLadderLevel: options.maxLadderLevel ?? 4,
    async run(task: HerculesTask, context: ContextPackage): Promise<TaskArtifacts> {
      const prompt = buildPrompt(task, context);
      const cwd = task.worktree ?? joinPath(options.worktreeRoot, task.task_id);
      const result = await execFn(cliPath, ['-p', prompt, '--output-format', 'json'], {
        ...(cwd !== undefined ? { cwd } : {}),
      });
      if (result.exitCode !== 0) {
        throw new Error(`claude CLI exited ${result.exitCode} for ${task.task_id}`);
      }
      return parseArtifacts(result.stdout, task.task_id);
    },
  };
}

function joinPath(root: string | undefined, taskId: string): string | undefined {
  return root === undefined ? undefined : `${root.replace(/\/$/, '')}/${taskId.toLowerCase()}`;
}

function buildPrompt(task: HerculesTask, context: ContextPackage): string {
  return [
    `Task ${task.task_id}: ${task.title}`,
    '',
    `GOAL: ${context.goal}`,
    '',
    `ALLOWED PATHS (modify nothing outside these): ${context.allowedPaths.join(', ')}`,
    context.forbiddenChanges.length > 0
      ? `FORBIDDEN CHANGES: ${context.forbiddenChanges.join('; ')}`
      : '',
    context.architectureRules.length > 0
      ? `ARCHITECTURE RULES: ${context.architectureRules.join('; ')}`
      : '',
    `ACCEPTANCE CRITERIA: ${context.acceptanceCriteria.join('; ')}`,
    '',
    'Implement the task on the current branch, run the tests, and commit.',
    'When finished, output ONLY a JSON object of the shape',
    '{"commits": ["<sha or message>", ...], "testReport": "<summary of test results>"}.',
    'Report failures honestly — never claim tests passed when they did not.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function parseArtifacts(stdout: string, taskId: string): TaskArtifacts {
  let outer: unknown;
  try {
    outer = JSON.parse(stdout);
  } catch {
    throw new Error(`claude CLI returned non-JSON output for ${taskId}`);
  }
  // --output-format json wraps the agent's final text in { result: string }.
  const text =
    typeof (outer as { result?: unknown }).result === 'string'
      ? ((outer as { result: string }).result as string)
      : stdout;
  let artifacts: unknown;
  try {
    artifacts = JSON.parse(extractJsonObject(text));
  } catch {
    throw new Error(`worker output for ${taskId} is not the required artifacts JSON`);
  }
  const candidate = artifacts as { commits?: unknown; testReport?: unknown };
  if (
    !Array.isArray(candidate.commits) ||
    !candidate.commits.every((c) => typeof c === 'string') ||
    typeof candidate.testReport !== 'string'
  ) {
    throw new Error(`worker artifacts for ${taskId} are malformed (commits/testReport required)`);
  }
  return { commits: candidate.commits, testReport: candidate.testReport };
}

/** Tolerates prose around the JSON object without ever trusting the prose. */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return text.slice(start, end + 1);
}
