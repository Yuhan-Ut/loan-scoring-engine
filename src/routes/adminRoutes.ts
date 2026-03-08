import { Router } from 'express';
import {
  listApplicationsByStatus,
  getApplicationDetail,
  reviewApplication,
  validateApplicationTransition,
} from '../services/adminService';
import { checkAndFlagTimedOutDisbursements } from '../services/disbursementService';
import { ApplicationStatus } from '../domain/ApplicationStatus';
import { ValidationError } from '../domain/errors';

const router = Router();

function basicAuth(req: any, res: any, next: any): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="admin"');
    res.status(401).send('Authentication required');
    return;
  }

  const encoded = header.slice('Basic '.length);
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const [user, pass] = decoded.split(':');

  const expectedUser = process.env.ADMIN_USER || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD || 'password';

  if (user !== expectedUser || pass !== expectedPass) {
    res.setHeader('WWW-Authenticate', 'Basic realm="admin"');
    res.status(401).send('Invalid credentials');
    return;
  }

  next();
}

router.use(basicAuth);

router.get('/applications', async (req, res, next) => {
  try {
    const status = req.query.status as ApplicationStatus | undefined;
    const apps = await listApplicationsByStatus(status);
    res.json({ applications: apps });
  } catch (err) {
    next(err);
  }
});

router.get('/applications/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    const detail = await getApplicationDetail(id);
    if (!detail) {
      res.status(404).json({ message: 'Application not found' });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.post('/applications/:id/review', async (req, res, next) => {
  try {
    const id = req.params.id;
    const { decision, note, approved_loan_amount, reviewer_id } = req.body ?? {};

    if (!decision || !note) {
      throw new ValidationError('decision and note are required');
    }

    await reviewApplication(id, {
      decision,
      note,
      approved_loan_amount,
      reviewer_id,
    });

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * Demo endpoint: validate a state transition without persisting.
 * Use for Loom to show the state machine rejecting invalid transitions (e.g. denied → processing).
 */
/**
 * Check for disbursements that have been in disbursement_queued longer than
 * webhookTimeoutMs and flag them (and their application) for manual review.
 * Call on a schedule or manually for Loom demo.
 */
router.post('/disbursements/check-timeouts', async (_req, res, next) => {
  try {
    const flagged = await checkAndFlagTimedOutDisbursements();
    res.status(200).json({
      message: 'Timeout check completed.',
      flagged_count: flagged.length,
      flagged: flagged.map((f) => ({ application_id: f.application_id, disbursement_id: f.disbursement_id })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/applications/:id/transition', async (req, res, next) => {
  try {
    const id = req.params.id;
    const { to_status } = req.body ?? {};

    if (!to_status || typeof to_status !== 'string') {
      throw new ValidationError('to_status is required and must be a string');
    }

    const validStatuses: ApplicationStatus[] = [
      'submitted',
      'processing',
      'approved',
      'denied',
      'flagged_for_review',
      'partially_approved',
    ];
    if (!validStatuses.includes(to_status as ApplicationStatus)) {
      throw new ValidationError(
        `to_status must be one of: ${validStatuses.join(', ')}`,
      );
    }

    const result = await validateApplicationTransition(id, to_status as ApplicationStatus);

    res.status(200).json({
      message: 'Transition is valid (demo endpoint: no state change persisted)',
      from_status: result.currentStatus,
      to_status: result.toStatus,
    });
  } catch (err) {
    next(err);
  }
});

export const adminRoutes = router;

