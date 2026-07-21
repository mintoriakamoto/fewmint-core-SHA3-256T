import type { Grant, Role } from '@cooklabs/permissions';

export class UnknownRoleError extends Error {
  constructor(roleName: string) {
    super(`Unknown role: ${roleName}`);
    this.name = 'UnknownRoleError';
  }
}

/** Registry of role definitions (seeded per Industry Pack, tenant-extensible). */
export class RoleRegistry {
  private readonly roles = new Map<string, Role>();

  register(role: Role): void {
    this.roles.set(role.name, role);
  }

  get(name: string): Role {
    const role = this.roles.get(name);
    if (!role) throw new UnknownRoleError(name);
    return role;
  }
}

/**
 * Resolves a membership's role names into the flat grant list consumed by
 * @cooklabs/permissions.authorize. Unknown roles throw (fail closed) rather
 * than silently granting nothing while appearing configured.
 */
export function resolveGrants(
  roleNames: readonly string[],
  registry: RoleRegistry,
): readonly Grant[] {
  return roleNames.flatMap((name) => registry.get(name).grants);
}
