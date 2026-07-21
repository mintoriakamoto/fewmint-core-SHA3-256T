/**
 * Identity types (spec 02 §2). Agent identities are separate from human
 * identities — an agent never acts "as" a user.
 */

export interface UserIdentity {
  readonly type: 'user';
  readonly id: string;
  readonly email: string;
  readonly mfaVerified: boolean;
}

export interface AgentIdentity {
  readonly type: 'agent';
  readonly id: string;
  /** Agent definition name + version this identity executes as. */
  readonly agentName: string;
  readonly agentVersion: number;
}

export interface ServiceIdentity {
  readonly type: 'system';
  readonly id: string;
  readonly service: string;
}

export type Identity = UserIdentity | AgentIdentity | ServiceIdentity;

/** User ↔ organization link carrying the user's roles within that org. */
export interface Membership {
  readonly identityId: string;
  readonly organizationId: string;
  readonly roles: readonly string[];
  readonly locationIds?: readonly string[];
}
