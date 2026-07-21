export type AuditActorType = 'user' | 'agent' | 'system';
export type AuditResult = 'success' | 'denied' | 'failed';

/** The mandatory audit record for every action (spec 02 §5). */
export interface AuditRecord {
  readonly actor: { readonly id: string; readonly type: AuditActorType };
  readonly tenant_id: string;
  readonly location_id?: string;
  readonly action: string;
  readonly resource: { readonly type: string; readonly id?: string };
  /** The grant that authorized the action (or the denied permission). */
  readonly permission: string;
  readonly reason: string;
  readonly timestamp: string;
  readonly result: AuditResult;
  /** Approval record reference, if the action was approval-gated. */
  readonly approval?: string;
  /** Model and/or tool used, for AI-performed actions. */
  readonly model_tool?: string;
}
