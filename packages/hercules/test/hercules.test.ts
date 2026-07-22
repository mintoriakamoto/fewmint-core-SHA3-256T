import { describe, expect, it } from 'vitest';
import {
  ControlPlane,
  DependencyCycleError,
  HumanApprovalRequiredError,
  LadderViolationError,
  MissingEvidenceError,
  ScoreBoard,
  TaskValidationError,
  assertCapability,
  type Worker,
} from '@cooklabs/hercules';

function task(id: string, deps: string[] = [], status = 'ready') {
  return {
    task_id: id,
    epic_id: 'AUTO-SAAS-001',
    title: `Task ${id}`,
    specification: `Do ${id} per spec`,
    owner: 'claude_code',
    branch: `factory/${id.toLowerCase()}`,
    dependencies: deps,
    allowed_paths: ['packages/**'],
    acceptance_criteria: ['tests pass'],
    status,
    artifacts: [],
  };
}

function worker(id: string, maxLadderLevel: 1 | 3 | 4 | 6 | 8): Worker {
  return {
    id,
    maxLadderLevel,
    run: (t) =>
      Promise.resolve({ commits: [`${id}:${t.task_id}:c1`], testReport: `${t.task_id} tests ok` }),
  };
}

describe('control plane: tasks and DAG', () => {
  it('validates tasks against the normative schema', () => {
    const plane = new ControlPlane();
    expect(() => plane.addTask({ task_id: 'bad task id' })).toThrow(TaskValidationError);
    expect(plane.addTask(task('ARCH-001')).task_id).toBe('ARCH-001');
    expect(() => plane.addTask(task('ARCH-001'))).toThrow(/duplicate/);
  });

  it('rejects dependency cycles', () => {
    const plane = new ControlPlane();
    plane.addTask(task('A-1', ['B-1']));
    expect(() => plane.addTask(task('B-1', ['A-1']))).toThrow(DependencyCycleError);
  });

  it('readyTasks requires every dependency to be merged', () => {
    const plane = new ControlPlane();
    plane.addTask(task('DB-1'));
    plane.addTask(task('API-1', ['DB-1']));
    expect(plane.readyTasks().map((t) => t.task_id)).toEqual(['DB-1']);
    plane.markStatus('DB-1', 'merged');
    expect(plane.readyTasks().map((t) => t.task_id)).toEqual(['API-1']);
  });
});

describe('permissions ladder (spec 09 §7)', () => {
  it('caps workers at their max level', () => {
    expect(() => assertCapability({ id: 'reader', maxLadderLevel: 1 }, 3)).toThrow(
      LadderViolationError,
    );
    expect(() => assertCapability({ id: 'coder', maxLadderLevel: 6 }, 6)).not.toThrow();
  });

  it('L8 always requires a human release approval — even at max level 8', () => {
    const deployer = { id: 'deployer', maxLadderLevel: 8 as const };
    expect(() => assertCapability(deployer, 8)).toThrow(HumanApprovalRequiredError);
    expect(() => assertCapability(deployer, 8, { releaseApproval: '' })).toThrow(
      HumanApprovalRequiredError,
    );
    expect(() => assertCapability(deployer, 8, { releaseApproval: 'rel_2026_07_x' })).not.toThrow();
  });
});

describe('dispatch protocol (spec 09 §4–§5)', () => {
  it('drives a task through build → review → gates → merge', async () => {
    const plane = new ControlPlane();
    plane.addTask(task('DB-1'));
    const builder = worker('codex', 4);
    const merger = worker('hercules', 6);

    const artifacts = await plane.dispatch('DB-1', builder);
    expect(artifacts.commits).toHaveLength(1);
    expect(plane.get('DB-1').status).toBe('in_review');
    expect(plane.get('DB-1').artifacts).toContain('DB-1 tests ok');

    // A worker saying "done" is not done: review by a DIFFERENT actor.
    expect(() => plane.review('DB-1', 'claude_code', 'approve')).toThrow(/differ from owner/);
    plane.review('DB-1', 'codex_reviewer', 'approve');
    expect(plane.get('DB-1').status).toBe('gates');

    // Merging needs L5+L6; the builder (max L4) cannot merge its own work.
    expect(() => plane.merge('DB-1', builder)).toThrow(LadderViolationError);
    plane.merge('DB-1', merger);
    expect(plane.get('DB-1').status).toBe('merged');
  });

  it('refuses dispatch with unmet dependencies or an under-privileged worker', async () => {
    const plane = new ControlPlane();
    plane.addTask(task('DB-1'));
    plane.addTask(task('API-1', ['DB-1']));
    await expect(plane.dispatch('API-1', worker('codex', 4))).rejects.toThrow(/unmet dependencies/);
    await expect(plane.dispatch('DB-1', worker('reader', 1))).rejects.toThrow(LadderViolationError);
  });

  it('a rejected review sends the task back with evidence, not to merge', async () => {
    const plane = new ControlPlane();
    plane.addTask(task('UI-1'));
    await plane.dispatch('UI-1', worker('grok_build', 4));
    plane.review('UI-1', 'claude_reviewer', 'reject');
    expect(plane.get('UI-1').status).toBe('rejected');
    expect(() => plane.merge('UI-1', worker('hercules', 6))).toThrow(/not passed/);
  });
});

describe('evidence-based routing (spec 09 §6)', () => {
  it('routing flips to the measurably better worker per category', () => {
    const board = new ScoreBoard();
    // Codex: strong on backend bugs. Grok: fast but wrong more often.
    for (let i = 0; i < 10; i++) {
      board.recordOutcome('codex', 'backend_bug', {
        correct: i !== 0, // 90%
        costUsd: 0.4,
        durationMs: 60_000,
      });
      board.recordOutcome('grok_build', 'backend_bug', {
        correct: i % 2 === 0, // 50%
        costUsd: 0.2,
        durationMs: 20_000,
      });
    }
    expect(board.selectWorker(['codex', 'grok_build'], 'backend_bug')).toBe('codex');
    // With cost/speed prioritized over correctness, the tradeoff flips.
    expect(
      board.selectWorker(['codex', 'grok_build'], 'backend_bug', {
        correctness: 0.1,
        cost: 0.45,
        speed: 0.45,
      }),
    ).toBe('grok_build');
    // Unknown categories fall back to the exploration prior, not a crash.
    expect(['codex', 'grok_build']).toContain(
      board.selectWorker(['codex', 'grok_build'], 'ui_prototype'),
    );
  });

  it('lessons demand provenance; forbidden lessons demand a replacement', () => {
    const board = new ScoreBoard();
    expect(() =>
      board.addLesson({ pattern: 'X leaks tenants', evidence: '', status: 'observed' }),
    ).toThrow(MissingEvidenceError);
    expect(() =>
      board.addLesson({
        pattern: 'X leaks tenants',
        evidence: 'SEC-184',
        status: 'forbidden',
      }),
    ).toThrow(MissingEvidenceError);
    const lesson = board.addLesson({
      pattern: 'X leaks tenants',
      evidence: 'Security test SEC-184',
      status: 'forbidden',
      replacement: 'Tenant-scoped repository abstraction',
    });
    expect(board.allLessons()).toContainEqual(lesson);
  });
});
