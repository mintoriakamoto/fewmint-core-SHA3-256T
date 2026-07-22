import { describe, expect, it } from 'vitest';
import { ControlPlane, claudeCodeWorker, type ExecFn } from '@cooklabs/hercules';

function makeTask(id: string) {
  return {
    task_id: id,
    title: 'Tenant cache',
    specification: 'Implement the tenant cache per spec 01',
    owner: 'claude_code',
    branch: `factory/${id.toLowerCase()}`,
    allowed_paths: ['packages/tenancy/**'],
    forbidden_changes: ['packages/auth public API'],
    acceptance_criteria: ['isolation suite passes'],
    context: { architecture_rules: ['spec 01 §3'] },
    status: 'ready',
    artifacts: [],
  };
}

describe('claude code CLI worker adapter (ADR-0002)', () => {
  it('builds a guardrailed prompt and parses artifacts from CLI JSON output', async () => {
    const calls: { command: string; args: readonly string[]; cwd?: string }[] = [];
    const execFn: ExecFn = (command, args, options) => {
      calls.push({ command, args, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({
          result:
            'Done. {"commits": ["abc123: add tenant cache"], "testReport": "137 tests passed"}',
        }),
      });
    };
    const worker = claudeCodeWorker({ execFn, worktreeRoot: '/factory/worktrees' });
    const plane = new ControlPlane();
    plane.addTask(makeTask('ARCH-003'));

    const artifacts = await plane.dispatch('ARCH-003', worker);
    expect(artifacts.commits).toEqual(['abc123: add tenant cache']);
    expect(artifacts.testReport).toBe('137 tests passed');
    expect(plane.get('ARCH-003').status).toBe('in_review'); // never auto-merged

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe('claude');
    expect(call.args[0]).toBe('-p');
    expect(call.cwd).toBe('/factory/worktrees/arch-003');
    const prompt = String(call.args[1]);
    for (const required of [
      'GOAL: Implement the tenant cache per spec 01',
      'ALLOWED PATHS (modify nothing outside these): packages/tenancy/**',
      'FORBIDDEN CHANGES: packages/auth public API',
      'ARCHITECTURE RULES: spec 01 §3',
      'ACCEPTANCE CRITERIA: isolation suite passes',
      'Report failures honestly',
    ]) {
      expect(prompt).toContain(required);
    }
    expect(call.args).toContain('--output-format');
  });

  it('non-zero exit and malformed output are failures — never fake artifacts', async () => {
    const failing = claudeCodeWorker({
      execFn: () => Promise.resolve({ exitCode: 1, stdout: '' }),
    });
    const plane1 = new ControlPlane();
    plane1.addTask(makeTask('DB-9'));
    await expect(plane1.dispatch('DB-9', failing)).rejects.toThrow(/exited 1/);

    const chatty = claudeCodeWorker({
      execFn: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ result: 'I did great work, trust me!' }),
        }),
    });
    const plane2 = new ControlPlane();
    plane2.addTask(makeTask('DB-10'));
    await expect(plane2.dispatch('DB-10', chatty)).rejects.toThrow(/not the required artifacts/);

    const wrongShape = claudeCodeWorker({
      execFn: () =>
        Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({ result: '{"commits": "abc", "testReport": 42}' }),
        }),
    });
    const plane3 = new ControlPlane();
    plane3.addTask(makeTask('DB-11'));
    await expect(plane3.dispatch('DB-11', wrongShape)).rejects.toThrow(/malformed/);
  });
});
