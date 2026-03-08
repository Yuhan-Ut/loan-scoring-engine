import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection';
import { config } from '../config';
import { ApplicationInput, ScoreResult } from '../domain/types';
import { ApplicationStatus } from '../domain/ApplicationStatus';
import { scoreApplication } from '../scoring/scoringEngine';
import { DuplicateApplicationError } from '../domain/errors';
import { assertValidApplicationTransition } from '../domain/applicationStateMachine';

interface ApplicationRecord {
  id: string;
  status: ApplicationStatus;
  score: number | null;
  score_breakdown: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function findRecentDuplicateApplication(
  email: string,
  loanAmount: number,
): Promise<string | null> {
  const db = getDb();
  const windowMinutes = config.duplicateWindowMinutes;
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  return new Promise((resolve, reject) => {
    db.get<
      { id: string } | undefined
    >(
      `
        SELECT id
        FROM applications
        WHERE email = ?
          AND loan_amount = ?
          AND created_at >= ?
        ORDER BY created_at ASC
        LIMIT 1
      `,
      [email, loanAmount, cutoff],
      (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row?.id ?? null);
        }
      },
    );
  });
}

export async function createApplication(
  input: ApplicationInput,
): Promise<ApplicationRecord & { scoreResult: ScoreResult }> {
  const db = getDb();

  const dupId = await findRecentDuplicateApplication(input.email, input.loan_amount);
  if (dupId) {
    throw new DuplicateApplicationError(input.email, input.loan_amount, dupId);
  }

  const id = uuidv4();
  const submittedAt = nowIso();
  const processingAt = nowIso();

  const scoreResult = scoreApplication(input);

  let finalStatus: ApplicationStatus;
  switch (scoreResult.decision) {
    case 'auto_approve':
      finalStatus = 'approved';
      break;
    case 'auto_deny':
      finalStatus = 'denied';
      break;
    case 'manual_review':
    default:
      finalStatus = 'flagged_for_review';
  }

  const finalAt = nowIso();

  await new Promise<void>((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      db.run(
        `
          INSERT INTO applications (
            id,
            applicant_name,
            email,
            loan_amount,
            stated_monthly_income,
            employment_status,
            documented_monthly_income,
            bank_ending_balance,
            bank_has_overdrafts,
            bank_has_consistent_deposits,
            monthly_withdrawals,
            monthly_deposits,
            status,
            score,
            score_breakdown,
            approved_loan_amount,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          input.applicant_name,
          input.email,
          input.loan_amount,
          input.stated_monthly_income,
          input.employment_status,
          input.documented_monthly_income,
          input.bank_ending_balance,
          input.bank_has_overdrafts === null ? null : input.bank_has_overdrafts ? 1 : 0,
          input.bank_has_consistent_deposits === null
            ? null
            : input.bank_has_consistent_deposits
              ? 1
              : 0,
          input.monthly_withdrawals,
          input.monthly_deposits,
          finalStatus,
          scoreResult.totalScore,
          JSON.stringify(scoreResult.factors),
          null,
          submittedAt,
          finalAt,
        ],
        (err) => {
          if (err) {
            db.run('ROLLBACK');
            reject(err);
            return;
          }

          const transitions = [
            {
              from_status: null,
              to_status: 'submitted' as ApplicationStatus,
              at: submittedAt,
            },
            {
              from_status: 'submitted' as ApplicationStatus,
              to_status: 'processing' as ApplicationStatus,
              at: processingAt,
            },
            {
              from_status: 'processing' as ApplicationStatus,
              to_status: finalStatus,
              at: finalAt,
            },
          ];

          for (const t of transitions) {
            if (t.from_status) {
              assertValidApplicationTransition(id, t.from_status, t.to_status);
            }

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
                t.from_status,
                t.to_status,
                null,
                'system',
                null,
                t.at,
              ],
            );
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
    });
  });

  return {
    id,
    status: finalStatus,
    score: scoreResult.totalScore,
    score_breakdown: JSON.stringify(scoreResult.factors),
    scoreResult,
  };
}

