import { describe, expect, it } from 'vitest';
import {
  Blackboard,
  MessageBus,
  journalToEvents,
  replayBlackboard,
  replayBus,
  type Author,
  type JournalRecord,
} from '@cooklabs/comms';
import { validateEnvelope } from '@cooklabs/events';

const claude: Author = { id: 'claude_code', type: 'worker' };
const codex: Author = { id: 'codex', type: 'worker' };

describe('durable coordination: journal + replay', () => {
  it('a replayed blackboard has identical history, digest, and live claims', () => {
    const journal: JournalRecord[] = [];
    const board = new Blackboard({ journal: (r) => journal.push(r) });

    const first = board.post('TASK-9', claude, 'hypothesis', 'v1');
    board.post('TASK-9', claude, 'hypothesis', 'v2', { supersedes: first.id });
    board.claim('TASK-9', claude, 'packages/crm/src/service.ts');
    board.claim('TASK-9', codex, 'packages/billing/src/service.ts');
    board.releaseClaim('TASK-9', 'codex', 'packages/billing/src/service.ts');

    const rebuilt = replayBlackboard(journal);
    expect(rebuilt.entries('TASK-9')).toEqual(board.entries('TASK-9'));
    expect(rebuilt.digest('TASK-9')).toEqual(board.digest('TASK-9'));

    // Claim state survived replay: claude still holds its file, codex's is free.
    const conflict = rebuilt.claim('TASK-9', codex, 'packages/crm/src/service.ts');
    expect(conflict.granted).toBe(false);
    expect(rebuilt.claim('TASK-9', claude, 'packages/billing/src/service.ts').granted).toBe(true);
  });

  it('replay is idempotent — feeding the journal twice changes nothing', () => {
    const journal: JournalRecord[] = [];
    const board = new Blackboard({ journal: (r) => journal.push(r) });
    board.post('T', claude, 'finding', 'x');
    const rebuilt = replayBlackboard([...journal, ...journal]);
    expect(rebuilt.entries('T')).toHaveLength(1);
  });

  it('a replayed bus keeps idempotency, dead letters, and the human inbox', async () => {
    const journal: JournalRecord[] = [];
    const bus = new MessageBus({ journal: (r) => journal.push(r) });
    bus.register('parts_agent');
    const sent = await bus.send({
      id: 'm-dup',
      from: claude,
      to: 'parts_agent',
      performative: 'inform',
      content: 'built',
    });
    await bus.send({ from: claude, to: 'ghost', performative: 'inform', content: 'lost?' });
    await bus.send({ from: claude, to: 'anyone', performative: 'escalate', content: 'help' });

    const rebuilt = replayBus(journal);
    // Idempotency survives: the original message comes back, no duplicate.
    const again = await rebuilt.send({
      id: 'm-dup',
      from: claude,
      to: 'parts_agent',
      performative: 'inform',
      content: 'built',
    });
    expect(again).toEqual(sent);
    expect(rebuilt.deadLetters().map((m) => m.to)).toEqual(['ghost']);
    expect(rebuilt.humanInbox().map((m) => m.content)).toEqual(['help']);
  });

  it('journal records project into valid platform event envelopes', () => {
    const journal: JournalRecord[] = [];
    const board = new Blackboard({ journal: (r) => journal.push(r) });
    board.post('T', claude, 'finding', 'x');
    const bus = new MessageBus({ journal: (r) => journal.push(r) });
    void bus.send({ from: claude, to: 'ghost', performative: 'inform', content: 'y' });

    const events = journalToEvents(journal, 'org_a');
    expect(events.map((e) => e.event_type)).toEqual(['comms.entry.posted', 'comms.message.sent']);
    for (const event of events) expect(() => validateEnvelope(event)).not.toThrow();
  });
});
