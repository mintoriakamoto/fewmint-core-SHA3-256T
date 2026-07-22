import { describe, expect, it } from 'vitest';
import { ControlPlane, type Worker } from '@cooklabs/hercules';
import { Blackboard, EvidenceRequiredError, type Author } from '@cooklabs/comms';

const claude: Author = { id: 'claude_code', type: 'worker' };
const codex: Author = { id: 'codex', type: 'worker' };

function worker(id: string, maxLadderLevel: 4 | 6): Worker {
  return {
    id,
    maxLadderLevel,
    run: (t) =>
      Promise.resolve({
        commits: [`${id}:${t.task_id}:c1`],
        testReport: `${t.task_id}: 41 tests ok`,
      }),
  };
}

describe('cross-model debate on the task blackboard (spec 09 §5 + 14)', () => {
  it('competitive design: evidence decides, and the trail is complete', async () => {
    const board = new Blackboard();
    const plane = new ControlPlane(board);
    plane.addTask({
      task_id: 'ARCH-002',
      title: 'Tenant cache design',
      specification: 'Design the tenant-scoped cache layer',
      owner: 'claude_code',
      branch: 'factory/arch-002',
      allowed_paths: ['packages/tenancy/**'],
      acceptance_criteria: ['isolation preserved', 'p95 < 20ms'],
      status: 'ready',
      artifacts: [],
    });

    // Build phase posts status + artifacts automatically.
    await plane.dispatch('ARCH-002', worker('claude_code', 4));

    // Competitive findings: both systems post solutions WITH evidence.
    const claudeSolution = board.post(
      'ARCH-002',
      claude,
      'finding',
      'Per-tenant LRU keyed on (tenant_id, key); invalidation via events',
    );
    const claudeBench = board.post(
      'ARCH-002',
      claude,
      'artifact',
      'bench: p95 11ms, isolation suite green',
      {
        refs: [claudeSolution.id],
      },
    );
    const codexSolution = board.post(
      'ARCH-002',
      codex,
      'finding',
      'Shared cache with tenant-prefixed keys',
    );
    board.post(
      'ARCH-002',
      codex,
      'artifact',
      'bench: p95 9ms, but isolation probe leaked on eviction',
      {
        refs: [codexSolution.id],
      },
    );

    // Debate: questions get answered on the record.
    const q = board.post('ARCH-002', codex, 'question', 'does LRU eviction leak across tenants?', {
      refs: [claudeSolution.id],
    });
    board.post('ARCH-002', claude, 'answer', 'no — eviction is per-tenant map, probe attached', {
      refs: [q.id],
    });

    // The reviewer cannot decide without evidence…
    expect(() => plane.review('ARCH-002', 'codex_reviewer', 'approve')).toThrow(
      EvidenceRequiredError,
    );
    // …and the accepted decision cites the winning benchmark.
    plane.review('ARCH-002', 'codex_reviewer', 'approve', [claudeBench.id]);
    plane.merge('ARCH-002', worker('hercules', 6));

    const digest = board.digest('ARCH-002');
    const decision = digest.find((e) => e.kind === 'decision');
    expect(decision?.refs).toContain(claudeBench.id);
    expect(digest.at(-1)?.content).toBe('merged');
    // The whole debate is on the record: findings, artifacts, Q&A, decision.
    const kinds = board.entries('ARCH-002').map((e) => e.kind);
    for (const expected of ['status', 'artifact', 'finding', 'question', 'answer', 'decision']) {
      expect(kinds).toContain(expected);
    }
  });
});
