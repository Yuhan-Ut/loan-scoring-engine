import { getDb } from './connection';

function run(sql: string): Promise<void> {
  const db = getDb();

  return new Promise((resolve, reject) => {
    db.run(sql, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export async function initDb(): Promise<void> {
  await run('PRAGMA foreign_keys = ON');

  // Applications table: main loan application record
  await run(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      applicant_name TEXT NOT NULL,
      email TEXT NOT NULL,
      loan_amount REAL NOT NULL,
      stated_monthly_income REAL NOT NULL,
      employment_status TEXT NOT NULL,
      documented_monthly_income REAL,
      bank_ending_balance REAL,
      bank_has_overdrafts INTEGER,
      bank_has_consistent_deposits INTEGER,
      monthly_withdrawals REAL,
      monthly_deposits REAL,
      status TEXT NOT NULL,
      score REAL,
      score_breakdown TEXT,
      approved_loan_amount REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_applications_email_loan_created_at
      ON applications (email, loan_amount, created_at)
  `);

  // Application state transition history
  await run(`
    CREATE TABLE IF NOT EXISTS application_state_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (application_id) REFERENCES applications (id)
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_state_transitions_app
      ON application_state_transitions (application_id, created_at)
  `);

  // Disbursements table: one per approved or partially approved application
  await run(`
    CREATE TABLE IF NOT EXISTS disbursements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id TEXT NOT NULL,
      status TEXT NOT NULL,
      transaction_id TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_webhook_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (application_id) REFERENCES applications (id)
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_disbursements_app
      ON disbursements (application_id)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_disbursements_app_txn
      ON disbursements (application_id, transaction_id)
  `);

  // Disbursement audit events: each webhook attempt recorded separately
  await run(`
    CREATE TABLE IF NOT EXISTS disbursement_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      disbursement_id INTEGER NOT NULL,
      transaction_id TEXT NOT NULL,
      event_status TEXT NOT NULL,
      retry_sequence INTEGER NOT NULL,
      raw_payload TEXT NOT NULL,
      is_replay INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (disbursement_id) REFERENCES disbursements (id)
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_disbursement
      ON disbursement_audit_events (disbursement_id)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_audit_events_txn
      ON disbursement_audit_events (transaction_id)
  `);

  // Manual reviews table: admin decisions
  await run(`
    CREATE TABLE IF NOT EXISTS manual_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      note TEXT,
      reviewer_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (application_id) REFERENCES applications (id)
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS idx_manual_reviews_app
      ON manual_reviews (application_id, created_at)
  `);
}

