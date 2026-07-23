import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitWorktrees, createFactory } from '@cooklabs/factory';
import type { Worker } from '@cooklabs/hercules';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): { repoRoot: string; worktreeRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'cooklabs-factory-'));
  const repoRoot = join(base, 'repo');
  const worktreeRoot = join(base, 'worktrees');
  execFileSync('git', ['init', '-b', 'main', repoRoot]);
  git(repoRoot, 'config', 'user.email', 'factory@test.local');
  git(repoRoot, 'config', 'user.name', 'Factory Test');
  writeFileSync(join(repoRoot, 'README.md'), 'seed\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'seed');
  return { repoRoot, worktreeRoot };
}

function makeTask(id: string, title = 'Add module') {
  return {
    task_id: id,
    title,
    specification: `Implement ${id}`,
    owner: 'builder_a',
    branch: `factory/${id.toLowerCase()}`,
    allowed_paths: ['src/**'],
    acceptance_criteria: ['tests pass'],
    status: 'ready',
    artifacts: [],
  };
}

/** A worker that REALLY works: writes a file in its worktree and commits. */
function realWorker(id: string, fileName: string): Worker {
  return {
    id,
    maxLadderLevel: 4,
    run: (task) => {
      const cwd = task.worktree!;
      writeFileSync(join(cwd, fileName), `built by ${id} for ${task.task_id}\n`);
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-m', `${task.task_id}: add ${fileName}`);
      const sha = git(cwd, 'rev-parse', 'HEAD').trim();
      return Promise.resolve({ commits: [sha], testReport: `${task.task_id}: 5 tests ok` });
    },
  };
}

const merger: Worker = {
  id: 'hercules',
  maxLadderLevel: 6,
  run: () => Promise.reject(new Error('merger does not build')),
};

describe('git worktree isolation', () => {
  let repoRoot: string;
  let worktreeRoot: string;
  beforeEach(() => {
    ({ repoRoot, worktreeRoot } = makeRepo());
  });

  it('creates a real checkout on the task branch and removes it cleanly', async () => {
    const worktrees = new GitWorktrees(repoRoot, worktreeRoot);
    const path = await worktrees.create('DB-1', 'factory/db-1');
    expect(existsSync(join(path, 'README.md'))).toBe(true);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('factory/db-1');

    await worktrees.remove('DB-1', 'factory/db-1');
    expect(existsSync(path)).toBe(false);
    expect(git(repoRoot, 'branch', '--list', 'factory/db-1').trim()).toBe('');
  });

  it('rejects unsafe identifiers before any git runs', async () => {
    const worktrees = new GitWorktrees(repoRoot, worktreeRoot);
    await expect(worktrees.create('DB-1', 'evil; rm -rf')).rejects.toThrow(/Unsafe branch/);
    expect(() => worktrees.worktreePath('../escape')).toThrow(/Unsafe task id/);
  });
});

describe('factory runner end to end', () => {
  it('task → real build in a worktree → evidence-cited review → git merge to main', async () => {
    const { repoRoot, worktreeRoot } = makeRepo();
    const factory = createFactory({
      repoRoot,
      worktreeRoot,
      workers: [realWorker('builder_a', 'feature.txt')],
    });
    factory.submit(makeTask('FEAT-1', 'Feature file'));

    const results = await factory.runReadyTasks();
    expect(results).toEqual([
      expect.objectContaining({ taskId: 'FEAT-1', workerId: 'builder_a', outcome: 'built' }),
    ]);
    expect(factory.plane.get('FEAT-1').status).toBe('in_review');
    // The commit is real and on the task branch, not on main yet.
    expect(existsSync(join(repoRoot, 'feature.txt'))).toBe(false);

    // Review must cite evidence from the board.
    const evidence = factory.board
      .digest('FEAT-1')
      .filter((e) => e.kind === 'artifact')
      .map((e) => e.id);
    expect(evidence.length).toBeGreaterThan(0);
    expect(() => factory.review('FEAT-1', 'reviewer_b', 'approve', [])).toThrow();
    factory.review('FEAT-1', 'reviewer_b', 'approve', evidence.slice(0, 1));

    const merged = await factory.merge('FEAT-1', merger);
    expect(merged.status).toBe('merged');
    // The work is really on main now, and the worktree is gone.
    expect(readFileSync(join(repoRoot, 'feature.txt'), 'utf8')).toContain('built by builder_a');
    expect(git(repoRoot, 'log', '--oneline', '-2')).toContain('Merge FEAT-1');
    expect(existsSync(join(worktreeRoot, 'feat-1'))).toBe(false);

    // The whole run is journaled and replayable.
    const kinds = factory.journal().map((r) => (r.kind === 'entry' ? r.entry.kind : 'message'));
    expect(kinds).toContain('status');
    expect(kinds).toContain('artifact');
    expect(kinds).toContain('decision');
  });

  it('selects the measurably better worker, and selection flips with weights', async () => {
    const { repoRoot, worktreeRoot } = makeRepo();
    const factory = createFactory({
      repoRoot,
      worktreeRoot,
      workers: [realWorker('builder_a', 'a.txt'), realWorker('builder_b', 'b.txt')],
    });
    // Seed evidence: builder_b is far more correct in this category.
    for (let i = 0; i < 5; i++) {
      factory.scores.recordOutcome('builder_a', 'backend', {
        correct: i === 0,
        costUsd: 0.1,
        durationMs: 1000,
      });
      factory.scores.recordOutcome('builder_b', 'backend', {
        correct: true,
        costUsd: 0.5,
        durationMs: 5000,
      });
    }
    factory.submit(makeTask('SEL-1'));
    const [first] = await factory.runReadyTasks('backend');
    expect(first?.workerId).toBe('builder_b');

    factory.submit(makeTask('SEL-2'));
    const [second] = await factory.runReadyTasks('backend', {
      correctness: 0.05,
      cost: 0.5,
      speed: 0.45,
    });
    expect(second?.workerId).toBe('builder_a');
  });

  it('a failing worker is recorded honestly and nothing merges', async () => {
    const { repoRoot, worktreeRoot } = makeRepo();
    const broken: Worker = {
      id: 'builder_broken',
      maxLadderLevel: 4,
      run: () => Promise.reject(new Error('build exploded')),
    };
    const factory = createFactory({ repoRoot, worktreeRoot, workers: [broken] });
    factory.submit(makeTask('BAD-1'));

    const [result] = await factory.runReadyTasks('backend');
    expect(result?.outcome).toBe('failed');
    expect(result?.error).toContain('build exploded');
    expect(factory.scores.score('builder_broken', 'backend').correctness).toBe(0);
    const statuses = factory.board.digest('BAD-1').map((e) => e.content);
    expect(statuses.some((s) => s.includes('build failed'))).toBe(true);
    await expect(factory.merge('BAD-1', merger)).rejects.toThrow();
    expect(existsSync(join(repoRoot, 'feature.txt'))).toBe(false);
  });
});
