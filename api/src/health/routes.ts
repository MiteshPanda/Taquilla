import { Router } from 'express';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';

export function createHealthRouter(db: Pick<Database, 'ping'>): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    try {
      await db.ping();
    } catch (err) {
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is unavailable.', undefined, {
        cause: err,
      });
    }
    res.json({ status: 'ready' });
  });

  return router;
}
