import { getDb } from '../db/connection';
import { ApplicationStatus } from '../domain/ApplicationStatus';
import { ValidationError } from '../domain/errors';
import { assertValidApplicationTransition } from '../domain/applicationStateMachine';

export interface AdminReviewInput {
  decision: 'approved' | 'denied' | 'partially_approved';
  note: string;
  approved_loan_amount?: number;
  reviewer_id?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function listApplicationsByStatus(status?: ApplicationStatus): Promise<unknown[]> {
  const db = getDb();

  return new Promise((resolve, reject) => {
    const sql =
      status != null
        ? 'SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC'
        : 'SELECT * FROM applications ORDER BY created_at DESC';
    const params = status != null ? [status] : [];

    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

export async function getApplicationDetail(id: string): Promise<unknown | null> {
  const db = getDb();

  const application = await new Promise<any | undefined>((resolve, reject) => {
    db.get('SELECT * FROM applications WHERE id = ?', [id], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });

  if (!application) {
    return null;
  }

  const transitions = await new Promise<unknown[]>((resolve, reject) => {
    db.all(
      'SELECT * FROM application_state_transitions WHERE application_id = ? ORDER BY created_at ASC',
      [id],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      },
    );
  });

  const disbursements = await new Promise<unknown[]>((resolve, reject) => {
    db.all(
      'SELECT * FROM disbursements WHERE application_id = ? ORDER BY created_at ASC',
      [id],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      },
    );
  });

  return {
    application,
    transitions,
    disbursements,
  };
}

/**
 * Validates that a state transition is allowed by the state machine.
 * Used by the demo endpoint POST /admin/applications/:id/transition (no DB update).
 */
export async function validateApplicationTransition(
  id: string,
  toStatus: ApplicationStatus,
): Promise<{ currentStatus: ApplicationStatus; toStatus: ApplicationStatus }> {
  const db = getDb();

  const current = await new Promise<{ status: ApplicationStatus } | undefined>((resolve, reject) => {
    db.get<{ status: ApplicationStatus }>(
      'SELECT status FROM applications WHERE id = ?',
      [id],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      },
    );
  });

  if (!current) {
    throw new ValidationError('Application not found');
  }

  assertValidApplicationTransition(id, current.status, toStatus);

  return { currentStatus: current.status, toStatus };
}

export async function reviewApplication(
  id: string,
  input: AdminReviewInput,
): Promise<void> {
  const db = getDb();

  const current = await new Promise<{ status: ApplicationStatus } | undefined>((resolve, reject) => {
    db.get<{ status: ApplicationStatus }>(
      'SELECT status FROM applications WHERE id = ?',
      [id],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      },
    );
  });

  if (!current) {
    throw new ValidationError('Application not found');
  }

  if (current.status !== 'flagged_for_review') {
    throw new ValidationError('Application must be in flagged_for_review status for manual review');
  }

  const nextStatus = input.decision as ApplicationStatus;

  if (nextStatus === 'partially_approved') {
    if (
      input.approved_loan_amount == null ||
      typeof input.approved_loan_amount !== 'number' ||
      input.approved_loan_amount <= 0
    ) {
      throw new ValidationError('approved_loan_amount must be a positive number for partially_approved');
    }
  }

  assertValidApplicationTransition(id, current.status, nextStatus);

  const hasDisbursement = await new Promise<boolean>((resolve, reject) => {
    db.get<{ id: number }>(
      'SELECT id FROM disbursements WHERE application_id = ? LIMIT 1',
      [id],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row != null);
        }
      },
    );
  });

  const now = nowIso();
  const shouldCreateDisbursement =
    (nextStatus === 'approved' || nextStatus === 'partially_approved') && !hasDisbursement;

  await new Promise<void>((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      db.run(
        `
          UPDATE applications
          SET status = ?,
              approved_loan_amount = COALESCE(?, approved_loan_amount),
              updated_at = ?
          WHERE id = ?
        `,
        [nextStatus, input.approved_loan_amount ?? null, now, id],
      );

      db.run(
        `
          INSERT INTO application_state_transitions (
            application_id,
            from_status,
            to_status,
            reason,
            actor_type,
            actor_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          current.status,
          nextStatus,
          input.note,
          'admin',
          input.reviewer_id ?? null,
          now,
        ],
      );

      db.run(
        `
          INSERT INTO manual_reviews (
            application_id,
            decision,
            note,
            reviewer_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
        [id, input.decision, input.note, input.reviewer_id ?? null, now],
      );

      if (shouldCreateDisbursement) {
        db.run(
          `
            INSERT INTO disbursements (
              application_id,
              status,
              transaction_id,
              retry_count,
              last_webhook_at,
              created_at,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [id, 'disbursement_queued', null, 0, null, now, now],
        );
      }

      db.run('COMMIT', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
}

