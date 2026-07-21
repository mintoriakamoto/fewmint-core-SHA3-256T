import type { EventEnvelope } from './envelope.js';

/**
 * Consumers are idempotent on event_id under at-least-once delivery (spec 05 §3).
 * Production stores are durable; the in-memory store is for tests and local dev.
 */
export interface ProcessedEventStore {
  wasProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
}

export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly seen = new Set<string>();

  wasProcessed(eventId: string): Promise<boolean> {
    return Promise.resolve(this.seen.has(eventId));
  }

  markProcessed(eventId: string): Promise<void> {
    this.seen.add(eventId);
    return Promise.resolve();
  }
}

/**
 * Runs the handler exactly once per event_id. The event is marked processed
 * only after the handler succeeds, so a failed handler retries on redelivery.
 */
export async function handleOnce<P extends object>(
  store: ProcessedEventStore,
  event: EventEnvelope<P>,
  handler: (event: EventEnvelope<P>) => Promise<void>,
): Promise<'processed' | 'duplicate'> {
  if (await store.wasProcessed(event.event_id)) return 'duplicate';
  await handler(event);
  await store.markProcessed(event.event_id);
  return 'processed';
}
