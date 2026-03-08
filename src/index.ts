import express from 'express';
import { config } from './config';
import { initDb } from './db/migrations';
import { applicationRoutes } from './routes/applicationRoutes';
import { webhookRoutes } from './routes/webhookRoutes';
import { adminRoutes } from './routes/adminRoutes';
import { ValidationError } from './domain/errors';

async function bootstrap(): Promise<void> {
  await initDb();

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/applications', applicationRoutes);
  app.use('/webhook', webhookRoutes);
  app.use('/admin', adminRoutes);

  // Error handler
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error_type: err.name, message: err.message });
      return;
    }

    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error_type: 'InternalServerError', message: 'Unexpected server error' });
  });

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on port ${config.port}`);
  });
}

void bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start application', err);
  process.exit(1);
});

