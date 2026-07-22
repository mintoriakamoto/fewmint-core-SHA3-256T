import { createEvent, type EventEnvelope } from '@cooklabs/events';
import { Blackboard, type BlackboardEntry } from './blackboard.js';
import { MessageBus, type AgentMessage } from './bus.js';

/**
 * Durable coordination (spec 14): every posting/message can be journaled and
 * the coordination state rebuilt by replay. The journal is the source of
 * truth for durability; in-memory structures are a cache of it.
 */
export type MessageDisposition = 'delivered' | 'dead_letter' | 'human_inbox' | 'broadcast';

export type JournalRecord =
  | { readonly kind: 'entry'; readonly entry: BlackboardEntry }
  | {
      readonly kind: 'message';
      readonly message: AgentMessage;
      readonly disposition: MessageDisposition;
    };

export type JournalSink = (record: JournalRecord) => void;

/** Rebuilds a blackboard (entries, digest, live claims) from journal records. */
export function replayBlackboard(records: readonly JournalRecord[]): Blackboard {
  const board = new Blackboard();
  for (const record of records) {
    if (record.kind === 'entry') board.restore(record.entry);
  }
  return board;
}

/**
 * Rebuilds a bus's durable state: the idempotency set, dead letters, and the
 * human inbox. Per-agent live queues are deliberately transient — agents
 * re-request on restart rather than trusting stale deliveries.
 */
export function replayBus(records: readonly JournalRecord[]): MessageBus {
  const bus = new MessageBus();
  for (const record of records) {
    if (record.kind === 'message') bus.restore(record.message, record.disposition);
  }
  return bus;
}

/**
 * Projects journal records into standard event envelopes (spec 05) for the
 * platform event log. Tenant-scoped boards pass their tenant id; factory
 * boards use the reserved 'system' scope.
 */
export function journalToEvents(
  records: readonly JournalRecord[],
  tenantId: string,
): EventEnvelope[] {
  return records.map((record) =>
    record.kind === 'entry'
      ? createEvent({
          event_type: 'comms.entry.posted',
          tenant_id: tenantId,
          entity_id: record.entry.id,
          payload: { board: record.entry.board, kind: record.entry.kind },
        })
      : createEvent({
          event_type: 'comms.message.sent',
          tenant_id: tenantId,
          entity_id: record.message.id,
          payload: {
            performative: record.message.performative,
            conversation_id: record.message.conversation_id,
          },
        }),
  );
}
