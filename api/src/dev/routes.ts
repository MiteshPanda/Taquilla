import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, userIdOf } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { MAX_INT, parseBody } from '../validation.js';
import { buyNaive } from './naive.js';

const SEAT_RULE = 'Send a JSON body with a seatId, the id of one seat.';

const buySchema = z.object(
  {
    seatId: z
      .number({ error: SEAT_RULE })
      .int({ error: SEAT_RULE })
      .positive({ error: SEAT_RULE })
      .max(MAX_INT, { error: SEAT_RULE }),
  },
  { error: SEAT_RULE },
);

export interface DevRouterOptions {
  db: Pick<Database, 'pool'>;
  config: Pick<Config, 'JWT_SECRET' | 'RACE_DELAY_MS'>;
}

export function createDevRouter({ db, config }: DevRouterOptions): Router {
  const router = Router();

  router.post('/buy-naive', requireAuth(config.JWT_SECRET), async (req, res) => {
    const { seatId } = parseBody(buySchema, req.body);
    const ticketId = await buyNaive(db, userIdOf(req), seatId, config.RACE_DELAY_MS);
    res.status(201).json({ ticketId, seatId });
  });

  return router;
}
