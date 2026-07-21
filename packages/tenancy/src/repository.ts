import { getTenantContext } from './context.js';
import type { OwnershipColumns } from './ownership.js';

export class CrossTenantAccessError extends Error {
  constructor(resource: string) {
    super(`Cross-tenant access denied for ${resource}`);
    this.name = 'CrossTenantAccessError';
  }
}

/**
 * Tenant-scoped repository abstraction (spec 01 §3, 10 §3).
 * Feature code goes through subclasses of this — never raw SQL. Every read
 * re-asserts tenant scope even though the database layer (RLS) also enforces it.
 */
export abstract class TenantScopedRepository<T extends OwnershipColumns> {
  constructor(protected readonly resourceName: string) {}

  /** Storage-level fetch, unscoped; implemented by the concrete adapter. */
  protected abstract fetchById(tenantId: string, id: string): Promise<T | undefined>;

  /** Application-level re-assertion of tenant scope on every returned row. */
  async findById(id: string): Promise<T | undefined> {
    const ctx = getTenantContext();
    const row = await this.fetchById(ctx.tenantId, id);
    if (row === undefined) return undefined;
    if (row.tenant_id !== ctx.tenantId) {
      throw new CrossTenantAccessError(this.resourceName);
    }
    return row;
  }
}
