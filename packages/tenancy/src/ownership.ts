import { getTenantContext } from './context.js';

/** Required ownership columns for every tenant-sensitive record (spec 01 §2). */
export interface OwnershipColumns {
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly location_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export class ImmutableTenantError extends Error {
  constructor() {
    super('tenant_id and organization_id are immutable after creation');
    this.name = 'ImmutableTenantError';
  }
}

/**
 * Stamps ownership columns from the ambient tenant context.
 * tenant_id is never accepted from input — it always comes from the context.
 */
export function stampCreate<T extends object>(record: T): T & OwnershipColumns {
  const ctx = getTenantContext();
  const now = new Date().toISOString();
  return {
    ...record,
    tenant_id: ctx.tenantId,
    organization_id: ctx.organizationId,
    location_id: ctx.locationId ?? null,
    created_by: ctx.actor.id,
    created_at: now,
    updated_at: now,
  };
}

/** Updates `updated_at`; rejects any attempt to move a record across tenants. */
export function stampUpdate<T extends OwnershipColumns>(
  existing: T,
  patch: Partial<Omit<T, keyof OwnershipColumns>> & {
    tenant_id?: string;
    organization_id?: string;
  },
): T {
  const ctx = getTenantContext();
  if (existing.tenant_id !== ctx.tenantId) throw new ImmutableTenantError();
  if (
    (patch.tenant_id !== undefined && patch.tenant_id !== existing.tenant_id) ||
    (patch.organization_id !== undefined && patch.organization_id !== existing.organization_id)
  ) {
    throw new ImmutableTenantError();
  }
  const rest = { ...patch };
  delete rest.tenant_id;
  delete rest.organization_id;
  return {
    ...existing,
    ...rest,
    updated_at: new Date().toISOString(),
  };
}
