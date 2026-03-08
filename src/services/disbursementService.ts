import { getDb } from '../db/connection';
import { config } from '../config';
import { ApplicationStatus, DisbursementStatus } from '../domain/ApplicationStatus';
import {
  assertValidApplicationTransition,
  assertValidDisbursementTransition,
} from '../domain/applicationStateMachine';
import { WebhookReplayError } from '../domain/errors';

export interface DisbursementWebhookPayload {
  application_id: string;
  status: 'success' | 'failed';
  transaction_id: string;
  timestamp: string;
}

interface DisbursementRecord {
  id: number;
  application_id: string;
  status: DisbursementStatus;
  transaction_id: string | null;
  retry_count: number;
  last_webhook_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function getOrCreateQueuedDisbursement(applicationId: string): Promise<DisbursementRecord> {
  const db = getDb();
  const now = nowIso();

  const existing = await new Promise<DisbursementRecord | undefined>((resolve, reject) => {
    db.get<DisbursementRecord>(
      `
        SELECT id, application_id, status, transaction_id, retry_count, last_webhook_at
        FROM disbursements
        WHERE application_id = ?
        ORDER BY id ASC
        LIMIT 1
      `,
      [applicationId],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      },
    );
  });

  if (existing) {
    return existing;
  }

  const insertedId = await new Promise<number>((resolve, reject) => {
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
      [applicationId, 'disbursement_queued', null, 0, null, now, now],
      function (this: { lastID: number }, err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.lastID);
        }
      },
    );
  });

  return {
    id: insertedId,
    application_id: applicationId,
    status: 'disbursement_queued',
    transaction_id: null,
    retry_count: 0,
    last_webhook_at: null,
  };
}

export async function handleDisbursementWebhook(payload: DisbursementWebhookPayload): Promise<DisbursementRecord> {
  const db = getDb();
  const now = nowIso();

  const disbursement = await getOrCreateQueuedDisbursement(payload.application_id);

  if (
    disbursement.transaction_id === payload.transaction_id &&
    (disbursement.status === 'disbursed' || disbursement.status === 'disbursement_failed' || disbursement.status === 'flagged_for_review')
  ) {
    return disbursement;
  }

  const maxRetries = config.maxDisbursementRetries;
  let nextStatus: DisbursementStatus;
  let nextRetryCount = disbursement.retry_count;
  let escalateToManualReview = false;

  if (payload.status === 'success') {
    nextStatus = 'disbursed';
  } else {
    const nextCount = disbursement.retry_count + 1;
    nextRetryCount = nextCount;
    if (nextCount <= maxRetries) {
      nextStatus = 'disbursement_failed';
    } else {
      nextStatus = 'flagged_for_review';
      escalateToManualReview = true;
    }
  }

  if (disbursement.status !== nextStatus) {
    assertValidDisbursementTransition(payload.application_id, disbursement.status, nextStatus);
  }

  await new Promise<void>((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      db.run(
        `
          UPDATE disbursements
          SET status = ?,
              transaction_id = ?,
              retry_count = ?,
              last_webhook_at = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [
          nextStatus,
          payload.transaction_id,
          nextRetryCount,
          payload.timestamp || now,
          now,
          disbursement.id,
        ],
      );

      db.run(
        `
          INSERT INTO disbursement_audit_events (
            disbursement_id,
            transaction_id,
            event_status,
            retry_sequence,
            raw_payload,
            is_replay,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          disbursement.id,
          payload.transaction_id,
          payload.status,
          nextRetryCount,
          JSON.stringify(payload),
          0,
          now,
        ],
      );

      if (escalateToManualReview) {
        db.get<{ status: ApplicationStatus }>(
          'SELECT status FROM applications WHERE id = ?',
          [payload.application_id],
          (err, appRow) => {
            if (err) {
              db.run('ROLLBACK');
              reject(err);
              return;
            }
            const currentAppStatus = (appRow?.status ?? 'approved') as ApplicationStatus;
            if (currentAppStatus !== 'approved' && currentAppStatus !== 'partially_approved') {
              db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  reject(commitErr);
                } else {
                  resolve();
                }
              });
              return;
            }
            assertValidApplicationTransition(payload.application_id, currentAppStatus, 'flagged_for_review');
            db.run(
              `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`,
              ['flagged_for_review', now, payload.application_id],
              (updateErr) => {
                if (updateErr) {
                  db.run('ROLLBACK');
                  reject(updateErr);
                  return;
                }
                db.run(
                  `
                    INSERT INTO application_state_transitions (
                      application_id, from_status, to_status, reason, actor_type, actor_id, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                  `,
                  [payload.application_id, currentAppStatus, 'flagged_for_review', 'disbursement_retries_exhausted', 'system', null, now],
                  (insertErr) => {
                    if (insertErr) {
                      db.run('ROLLBACK');
                      reject(insertErr);
                      return;
                    }
                    db.run('COMMIT', (commitErr) => {
                      if (commitErr) {
                        reject(commitErr);
                      } else {
                        resolve();
                      }
                    });
                  },
                );
              },
            );
          },
        );
      } else {
        db.run('COMMIT', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });
  });

  return {
    ...disbursement,
    status: nextStatus,
    transaction_id: payload.transaction_id,
    retry_count: nextRetryCount,
    last_webhook_at: payload.timestamp || now,
  };
}

export interface TimedOutDisbursementResult {
  application_id: string;
  disbursement_id: number;
}

/**
 * Finds disbursements in disbursement_queued that have not received a webhook
 * within the configured timeout, and transitions them (and their application)
 * to flagged_for_review. Safe to call on a schedule or from an admin endpoint.
 */
export async function checkAndFlagTimedOutDisbursements(): Promise<TimedOutDisbursementResult[]> {
  const db = getDb();
  const now = nowIso();
  const cutoff = new Date(Date.now() - config.webhookTimeoutMs).toISOString();

  const rows = await new Promise<{ id: number; application_id: string }[]>((resolve, reject) => {
    db.all<{ id: number; application_id: string }>(
      `
        SELECT id, application_id
        FROM disbursements
        WHERE status = ?
          AND created_at < ?
      `,
      ['disbursement_queued', cutoff],
      (err, r) => {
        if (err) {
          reject(err);
        } else {
          resolve(r ?? []);
        }
      },
    );
  });

  const results: TimedOutDisbursementResult[] = [];

  for (const row of rows) {
    const application = await new Promise<{ status: ApplicationStatus } | undefined>((resolve, reject) => {
      db.get<{ status: ApplicationStatus }>(
        'SELECT status FROM applications WHERE id = ?',
        [row.application_id],
        (err, r) => {
          if (err) {
            reject(err);
          } else {
            resolve(r);
          }
        },
      );
    });

    if (!application) {
      continue;
    }

    const appStatus = application.status as ApplicationStatus;
    if (appStatus !== 'approved' && appStatus !== 'partially_approved') {
      continue;
    }

    assertValidDisbursementTransition(row.application_id, 'disbursement_queued', 'flagged_for_review');
    assertValidApplicationTransition(row.application_id, appStatus, 'flagged_for_review');

    await new Promise<void>((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run(
          `UPDATE disbursements SET status = ?, updated_at = ? WHERE id = ?`,
          ['flagged_for_review', now, row.id],
        );
        db.run(
          `UPDATE applications SET status = ?, updated_at = ? WHERE id = ?`,
          ['flagged_for_review', now, row.application_id],
        );
        db.run(
          `
            INSERT INTO application_state_transitions (
              application_id, from_status, to_status, reason, actor_type, actor_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [row.application_id, appStatus, 'flagged_for_review', 'webhook_timeout', 'system', null, now],
        );

        db.run('COMMIT', (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });

    results.push({ application_id: row.application_id, disbursement_id: row.id });
  }

  return results;
}

