import { Router } from 'express';
import { handleDisbursementWebhook } from '../services/disbursementService';
import { ValidationError, WebhookReplayError } from '../domain/errors';

const router = Router();

router.post('/disbursement', async (req, res, next) => {
  try {
    const { application_id, status, transaction_id, timestamp } = req.body ?? {};

    if (!application_id || !status || !transaction_id) {
      throw new ValidationError('application_id, status, and transaction_id are required');
    }

    if (status !== 'success' && status !== 'failed') {
      throw new ValidationError('status must be "success" or "failed"');
    }

    const result = await handleDisbursementWebhook({
      application_id,
      status,
      transaction_id,
      timestamp: timestamp || new Date().toISOString(),
    });

    res.json({
      disbursement_id: result.id,
      application_id: result.application_id,
      status: result.status,
      transaction_id: result.transaction_id,
      retry_count: result.retry_count,
      last_webhook_at: result.last_webhook_at,
    });
  } catch (err) {
    if (err instanceof WebhookReplayError) {
      res.status(200).json({
        error_type: err.name,
        message: err.message,
        replay: true,
      });
      return;
    }
    next(err);
  }
});

export const webhookRoutes = router;

