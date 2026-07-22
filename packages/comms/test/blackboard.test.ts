import { describe, expect, it } from 'vitest';
import { Blackboard, EvidenceRequiredError, UnknownRefError, type Author } from '@cooklabs/comms';

const claude: Author = { id: 'claude_code', type: 'worker' };
const codex: Author = { id: 'codex', type: 'worker' };
const hercules: Author = { id: 'hercules', type: 'system' };

describe('blackboard', () => {
  it('entries are append-only, frozen, and tagged untrusted for agent/worker authors', () => {
    const board = new Blackboard();
    const finding = board.post('TASK-1', claude, 'finding', 'RLS policy missing on events table');
    expect(Object.isFrozen(finding)).toBe(true);
    expect(finding.untrusted).toBe(true);
    const note = board.post('TASK-1', hercules, 'status', 'triaged');
    expect(note.untrusted).toBe(false);
    expect(board.entries('TASK-1')).toHaveLength(2);
  });

  it('corrections supersede; digest returns only the live working state', () => {
    const board = new Blackboard();
    const first = board.post('TASK-1', claude, 'hypothesis', 'bug is in the router');
    const revised = board.post('TASK-1', claude, 'hypothesis', 'bug is in the GUC binding', {
      supersedes: first.id,
    });
    const digest = board.digest('TASK-1');
    expect(digest.map((e) => e.id)).toEqual([revised.id]);
    expect(board.entries('TASK-1')).toHaveLength(2); // history is never lost
  });

  it('refs must point at real entries on the same board', () => {
    const board = new Blackboard();
    expect(() => board.post('TASK-1', claude, 'answer', 'x', { refs: ['ghost'] })).toThrow(
      UnknownRefError,
    );
  });

  it('decisions demand evidence refs (finding or artifact)', () => {
    const board = new Blackboard();
    const question = board.post('TASK-1', codex, 'question', 'why this index?');
    expect(() => board.post('TASK-1', hercules, 'decision', 'ship it')).toThrow(
      EvidenceRequiredError,
    );
    expect(() =>
      board.post('TASK-1', hercules, 'decision', 'ship it', { refs: [question.id] }),
    ).toThrow(EvidenceRequiredError); // a question is not evidence
    const bench = board.post('TASK-1', codex, 'artifact', 'benchmark: p95 12ms');
    const decision = board.post('TASK-1', hercules, 'decision', 'ship it', { refs: [bench.id] });
    expect(decision.refs).toContain(bench.id);
  });

  it('claims detect conflicts and release cleanly', () => {
    const board = new Blackboard();
    const mine = board.claim('TASK-1', claude, 'packages/tenancy/src/pg.ts');
    expect(mine.granted).toBe(true);
    const theirs = board.claim('TASK-1', codex, 'packages/tenancy/src/pg.ts');
    expect(theirs.granted).toBe(false);
    if (!theirs.granted) expect(theirs.conflict.author.id).toBe('claude_code');

    expect(() => board.releaseClaim('TASK-1', 'codex', 'packages/tenancy/src/pg.ts')).toThrow(
      /held by claude_code/,
    );
    board.releaseClaim('TASK-1', 'claude_code', 'packages/tenancy/src/pg.ts');
    const retry = board.claim('TASK-1', codex, 'packages/tenancy/src/pg.ts');
    expect(retry.granted).toBe(true);
  });

  it('subscribers see new entries; unsubscribe stops delivery', () => {
    const board = new Blackboard();
    const seen: string[] = [];
    const unsubscribe = board.subscribe('TASK-1', (e) => seen.push(e.kind));
    board.post('TASK-1', claude, 'finding', 'a');
    unsubscribe();
    board.post('TASK-1', claude, 'finding', 'b');
    expect(seen).toEqual(['finding']);
  });
});
