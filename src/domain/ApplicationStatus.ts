export type ApplicationStatus =
  | 'submitted'
  | 'processing'
  | 'approved'
  | 'denied'
  | 'flagged_for_review'
  | 'partially_approved';

export type DisbursementStatus =
  | 'disbursement_queued'
  | 'disbursed'
  | 'disbursement_failed'
  | 'flagged_for_review';

