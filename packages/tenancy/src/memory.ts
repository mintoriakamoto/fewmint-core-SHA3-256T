import { randomUUID } from 'node:crypto';
import { getTenantContext } from './context.js';
import { stampCreate, stampUpdate, type OwnershipColumns } from './ownership.js';
import { TenantScopedRepository } from './repository.js';

/**
 * Reference tenant-scoped store for domain packages and tests. Production
 * adapters back the same shape with Postgres + RLS (db/migrations); the
 * tenant-scoping behavior here is the contract they must preserve.
 */
export class InMemoryTenantRepository<
  T extends OwnershipColumns & { id: string },
> extends TenantScopedRepository<T> {
  private readonly rows = new Map<string, T>();

  protected fetchById(tenantId: string, id: string): Promise<T | undefined> {
    return Promise.resolve(this.rows.get(`${tenantId}:${id}`));
  }

  insert(data: Omit<T, keyof OwnershipColumns | 'id'> & { id?: string }): T {
    const record = stampCreate({ ...data, id: data.id ?? randomUUID() }) as T;
    this.rows.set(`${record.tenant_id}:${record.id}`, record);
    return record;
  }

  async updateById(id: string, patch: Partial<Omit<T, keyof OwnershipColumns | 'id'>>): Promise<T> {
    const existing = await this.findById(id);
    if (!existing) throw new Error(`${this.resourceName} ${id} not found`);
    const updated = stampUpdate(existing, patch as never);
    this.rows.set(`${updated.tenant_id}:${updated.id}`, updated);
    return updated;
  }

  /** Lists only the current tenant's rows, optionally filtered. */
  list(filter?: (row: T) => boolean): T[] {
    const ctx = getTenantContext();
    const mine = [...this.rows.values()].filter((row) => row.tenant_id === ctx.tenantId);
    return filter ? mine.filter(filter) : mine;
  }
}
