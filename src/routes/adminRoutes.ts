import { Router } from 'express';
import { listApplicationsByStatus, getApplicationDetail, reviewApplication } from '../services/adminService';
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

export const adminRoutes = router;

