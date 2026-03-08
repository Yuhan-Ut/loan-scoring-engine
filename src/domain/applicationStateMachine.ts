import { ApplicationStatus, DisbursementStatus } from './ApplicationStatus';
import { InvalidStateTransitionError } from './errors';

const applicationTransitions: Record<ApplicationStatus, ApplicationStatus[]> = {
  submitted: ['processing'],
  processing: ['approved', 'denied', 'flagged_for_review'],
  approved: ['flagged_for_review'],
  denied: [],
  flagged_for_review: ['approved', 'denied', 'partially_approved'],
  partially_approved: ['flagged_for_review'],
};

const disbursementTransitions: Record<DisbursementStatus, DisbursementStatus[]> = {
  disbursement_queued: ['disbursed', 'disbursement_failed', 'flagged_for_review'],
  disbursed: [],
  flagged_for_review: [],
  disbursement_failed: ['disbursement_queued', 'flagged_for_review'],
};

export function assertValidApplicationTransition(
  applicationId: string,
  fromStatus: ApplicationStatus,
  toStatus: ApplicationStatus,
): void {
  const allowed = applicationTransitions[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new InvalidStateTransitionError(applicationId, fromStatus, toStatus);
  }
}

export function assertValidDisbursementTransition(
  applicationId: string,
  fromStatus: DisbursementStatus,
  toStatus: DisbursementStatus,
): void {
  const allowed = disbursementTransitions[fromStatus] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new InvalidStateTransitionError(applicationId, fromStatus, toStatus);
  }
}

