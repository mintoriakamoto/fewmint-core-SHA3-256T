import type { OwnershipColumns } from '@cooklabs/tenancy';

/** Module-owned entity (spec 01 §5): vehicles never live in core tables. */
export interface Vehicle extends OwnershipColumns {
  readonly id: string;
  readonly customer_id: string;
  readonly vin: string;
  readonly make: string;
  readonly model: string;
  readonly year: number;
}

/** Doc 13 journey states, in order. */
export type RepairOrderStatus =
  'created' | 'inspecting' | 'estimated' | 'approved' | 'in_progress' | 'completed' | 'invoiced';

export interface RepairOrder extends OwnershipColumns {
  readonly id: string;
  readonly customer_id: string;
  readonly vehicle_id: string;
  readonly appointment_id: string | null;
  readonly complaint: string;
  readonly status: RepairOrderStatus;
  readonly inspection_notes: readonly string[];
  readonly photo_refs: readonly string[];
  readonly technician_id: string | null;
  /** Billing invoice backing the estimate/final invoice. */
  readonly invoice_id: string | null;
  readonly approval_ref: string | null;
}
