import { getDb } from '../db/connection';
import { config } from '../config';
import { DisbursementStatus } from '../domain/ApplicationStatus';
import { assertValidDisbursementTransition } from '../domain/applicationStateMachine';
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

  if (payload.status === 'success') {
    nextStatus = 'disbursed';
  } else {
    const nextCount = disbursement.retry_count + 1;
    if (nextCount <= maxRetries) {
      nextStatus = 'disbursement_failed';
      nextRetryCount = nextCount;
    } else {
      nextStatus = 'disbursement_failed';
      nextRetryCount = nextCount;
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

      db.run('COMMIT', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
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

