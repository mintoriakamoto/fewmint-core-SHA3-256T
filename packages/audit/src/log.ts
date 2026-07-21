import type { AuditRecord } from './types.js';

/** Append-only audit sink. There is deliberately no update or delete. */
export interface AuditLog {
  append(record: AuditRecord): Promise<void>;
}

export function buildAuditRecord(
  record: Omit<AuditRecord, 'timestamp'> & { timestamp?: string },
): AuditRecord {
  return Object.freeze({ ...record, timestamp: record.timestamp ?? new Date().toISOString() });
}

/** Reference/testing implementation; production sinks write to durable storage. */
export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditRecord[] = [];

  append(record: AuditRecord): Promise<void> {
    this.entries.push(Object.freeze({ ...record }));
    return Promise.resolve();
  }

  /** Read-only snapshot, filtered to one tenant (audit is tenant-scoped). */
  forTenant(tenantId: string): readonly AuditRecord[] {
    return this.entries.filter((e) => e.tenant_id === tenantId);
  }

  get size(): number {
    return this.entries.length;
  }
}
