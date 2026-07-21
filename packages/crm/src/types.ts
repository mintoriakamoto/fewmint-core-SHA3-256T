import type { OwnershipColumns } from '@cooklabs/tenancy';

export interface Customer extends OwnershipColumns {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
}

export type LeadStatus = 'new' | 'qualified' | 'nurture' | 'converted' | 'lost';

export interface Lead extends OwnershipColumns {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly source: string;
  readonly status: LeadStatus;
  readonly score: number | null;
  readonly customer_id: string | null;
}
