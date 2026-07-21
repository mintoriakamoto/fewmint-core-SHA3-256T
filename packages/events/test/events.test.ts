import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EnvelopeValidationError,
  InMemoryProcessedEventStore,
  createEvent,
  handleOnce,
  validateEnvelope,
} from '@cooklabs/events';
import packagedSchema from '../src/event-envelope.schema.json' with { type: 'json' };

describe('event envelope', () => {
  it('creates a valid envelope with defaults', () => {
    const event = createEvent({
      event_type: 'invoice.overdue',
      tenant_id: 'org_a',
      entity_id: 'inv_1',
      payload: { amount: 120 },
    });
    expect(event.event_id).toBeTruthy();
    expect(event.schema_version).toBe(1);
    expect(() => validateEnvelope(event)).not.toThrow();
  });

  it('rejects malformed event types and missing fields', () => {
    expect(() =>
      createEvent({
        event_type: 'InvoiceOverdue',
        tenant_id: 'org_a',
        entity_id: 'x',
        payload: {},
      }),
    ).toThrow(EnvelopeValidationError);
    expect(() => validateEnvelope({ event_type: 'a.b' })).toThrow(EnvelopeValidationError);
  });

  it('packaged schema is identical to the normative docs schema', () => {
    const docsSchema = JSON.parse(
      readFileSync(join(__dirname, '../../../docs/schemas/event-envelope.schema.json'), 'utf8'),
    );
    expect(packagedSchema).toEqual(docsSchema);
  });
});

describe('idempotent consumption', () => {
  it('processes an event exactly once across redeliveries', async () => {
    const store = new InMemoryProcessedEventStore();
    const event = createEvent({
      event_type: 'lead.created',
      tenant_id: 'org_a',
      entity_id: 'lead_1',
      payload: {},
    });
    let calls = 0;
    const handler = async () => {
      calls += 1;
    };
    expect(await handleOnce(store, event, handler)).toBe('processed');
    expect(await handleOnce(store, event, handler)).toBe('duplicate');
    expect(calls).toBe(1);
  });

  it('retries when the handler fails (marked only after success)', async () => {
    const store = new InMemoryProcessedEventStore();
    const event = createEvent({
      event_type: 'payment.received',
      tenant_id: 'org_a',
      entity_id: 'pay_1',
      payload: {},
    });
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
    };
    await expect(handleOnce(store, event, flaky)).rejects.toThrow('transient');
    expect(await handleOnce(store, event, flaky)).toBe('processed');
    expect(attempts).toBe(2);
  });
});
