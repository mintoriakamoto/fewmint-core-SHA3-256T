import { randomUUID } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import envelopeSchema from './event-envelope.schema.json' with { type: 'json' };

/** Standard event envelope (spec 05 §2). The JSON Schema is normative. */
export interface EventEnvelope<P extends object = Record<string, unknown>> {
  readonly event_id: string;
  readonly event_type: string;
  readonly tenant_id: string;
  readonly entity_id: string;
  readonly occurred_at: string;
  readonly schema_version: number;
  readonly correlation_id?: string;
  readonly ordering_key?: string;
  readonly payload: P;
}

const addFormats =
  (addFormatsModule as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validator = ajv.compile(envelopeSchema);

export class EnvelopeValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid event envelope: ${errors.join('; ')}`);
    this.name = 'EnvelopeValidationError';
  }
}

export function validateEnvelope(candidate: unknown): EventEnvelope {
  if (!validator(candidate)) {
    const errors = (validator.errors ?? []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
    );
    throw new EnvelopeValidationError(errors);
  }
  return candidate as unknown as EventEnvelope;
}

interface CreateEventInput<P extends object> {
  readonly event_type: string;
  readonly tenant_id: string;
  readonly entity_id: string;
  readonly payload: P;
  readonly schema_version?: number;
  readonly correlation_id?: string;
  readonly ordering_key?: string;
  /** When the business fact happened; defaults to now. */
  readonly occurred_at?: string;
}

export function createEvent<P extends object>(input: CreateEventInput<P>): EventEnvelope<P> {
  const envelope: EventEnvelope<P> = {
    event_id: randomUUID(),
    event_type: input.event_type,
    tenant_id: input.tenant_id,
    entity_id: input.entity_id,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    schema_version: input.schema_version ?? 1,
    ...(input.correlation_id !== undefined ? { correlation_id: input.correlation_id } : {}),
    ...(input.ordering_key !== undefined ? { ordering_key: input.ordering_key } : {}),
    payload: input.payload,
  };
  validateEnvelope(envelope);
  return Object.freeze(envelope);
}
