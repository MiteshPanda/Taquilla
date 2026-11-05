import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, userIdOf } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { databaseId, MAX_INT, parseBody } from '../validation.js';
import { releaseHold } from './release.js';
import type { HoldStrategy } from './strategy.js';

const SEATS_RULE = 'Send a JSON body with seatIds: a list of 1 to 6 seat ids.';

const holdSchema = z.object(
  {
    seatIds: z
      .array(
        z
          .number({ error: SEATS_RULE })
          .int({ error: SEATS_RULE })
          .positive({ error: SEATS_RULE })
          .max(MAX_INT, { error: SEATS_RULE }),
        { error: SEATS_RULE },
      )
      .min(1, { error: SEATS_RULE })
      .max(6, { error: SEATS_RULE })
      .refine((seatIds) => new Set(seatIds).size === seatIds.length, {
        error: 'List each seat only once.',
      }),
  },
  { error: SEATS_RULE },
);

export interface HoldsRouterOptions {
  db: Pick<Database, 'withTransaction'>;
  holdStrategy: HoldStrategy;
  config: Pick<Config, 'JWT_SECRET'>;
}

export function createHoldsRouter({ db, holdStrategy, config }: HoldsRouterOptions): Router {
  const router = Router();

  // Login first, so a request without a token learns nothing about what a valid body looks like.
  router.post('/events/:id/holds', requireAuth(config.JWT_SECRET), async (req, res) => {
    // An id that can't name an event is an unknown event, as on the seat map.
    const eventId = databaseId.safeParse(req.params.id);
    if (!eventId.success) {
      throw new AppError(404, 'NOT_FOUND', 'This event does not exist.');
    }
    const { seatIds } = parseBody(holdSchema, req.body);

    const hold = await holdStrategy.hold({ userId: userIdOf(req), eventId: eventId.data, seatIds });
    res.status(201).json(hold);
  });

  router.delete('/holds/:id', requireAuth(config.JWT_SECRET), async (req, res) => {
    // A malformed id can't name a hold, so it gets the same 404 as an unknown one.
    const holdId = z.uuid().safeParse(req.params.id);
    if (!holdId.success) {
      throw new AppError(404, 'NOT_FOUND', 'This hold does not exist.');
    }

    await releaseHold(db, { holdId: holdId.data, userId: userIdOf(req) });
    res.status(204).end();
  });

  return router;
}
