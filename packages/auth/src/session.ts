import type { TenantContext } from '@cooklabs/tenancy';
import type { Identity, Membership } from './identities.js';

/** An already-authenticated principal plus its verified memberships. */
export interface AuthenticatedSession {
  readonly identity: Identity;
  readonly memberships: readonly Membership[];
}

export class NoMembershipError extends Error {
  constructor(identityId: string, organizationId: string) {
    super(`Identity ${identityId} has no membership in organization ${organizationId}`);
    this.name = 'NoMembershipError';
  }
}

/**
 * The single blessed bridge from an authenticated session to a TenantContext
 * (spec 01 §2, 02 §2). The tenant is derived from a verified membership —
 * the requested organizationId is only honored if the session actually
 * belongs to it. Client input can never mint a context for a foreign tenant.
 */
export function establishTenantContext(
  session: AuthenticatedSession,
  requestedOrganizationId: string,
  requestedLocationId?: string,
): { context: TenantContext; membership: Membership } {
  const membership = session.memberships.find((m) => m.organizationId === requestedOrganizationId);
  if (!membership) {
    throw new NoMembershipError(session.identity.id, requestedOrganizationId);
  }
  if (
    requestedLocationId !== undefined &&
    membership.locationIds !== undefined &&
    !membership.locationIds.includes(requestedLocationId)
  ) {
    throw new NoMembershipError(session.identity.id, requestedOrganizationId);
  }
  const context: TenantContext = {
    tenantId: membership.organizationId,
    organizationId: membership.organizationId,
    ...(requestedLocationId !== undefined ? { locationId: requestedLocationId } : {}),
    actor: { id: session.identity.id, type: session.identity.type },
  };
  return { context, membership };
}
