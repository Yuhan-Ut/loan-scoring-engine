import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT) || 3000,
  databaseFile: process.env.DATABASE_FILE || 'loan_scoring.sqlite',
  duplicateWindowMinutes: Number(process.env.DUPLICATE_WINDOW_MINUTES) || 1,
  webhookTimeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS) || 5 * 60 * 1000,
  maxDisbursementRetries: Number(process.env.MAX_DISBURSEMENT_RETRIES) || 3,
};

