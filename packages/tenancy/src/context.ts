import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'user' | 'agent' | 'system';

export interface Actor {
  readonly id: string;
  readonly type: ActorType;
}

/**
 * Per-request tenant context (spec 01 §3). Derived from the authenticated
 * session server-side — never from client input.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly locationId?: string;
  readonly actor: Actor;
}

/** Thrown when tenant-scoped code runs outside a tenant context (fail closed). */
export class MissingTenantContextError extends Error {
  constructor() {
    super('No tenant context established; refusing tenant-scoped operation (fail closed)');
    this.name = 'MissingTenantContextError';
  }
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(context: TenantContext, fn: () => T): T {
  if (!context.tenantId || !context.organizationId || !context.actor?.id) {
    throw new Error('TenantContext requires tenantId, organizationId, and actor');
  }
  return storage.run(Object.freeze({ ...context }), fn);
}

/** Returns the current tenant context or throws — queries outside a tenant context MUST fail. */
export function getTenantContext(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx;
}

/** Non-throwing variant for infrastructure code (logging, metrics). */
export function tryGetTenantContext(): TenantContext | undefined {
  return storage.getStore();
}
