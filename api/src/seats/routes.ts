import { Router } from 'express';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { databaseId } from '../validation.js';
import { getSeatMap } from './service.js';

export function createSeatsRouter({ db }: { db: Pick<Database, 'pool'> }): Router {
  const router = Router();

  router.get('/events/:id/seats', async (req, res) => {
    // An id that can't name an event is an unknown event, so it gets the same 404.
    const eventId = databaseId.safeParse(req.params.id);
    const seatMap = eventId.success ? await getSeatMap(db, eventId.data) : undefined;
    if (seatMap === undefined) {
      throw new AppError(404, 'NOT_FOUND', 'This event does not exist.');
    }

    // Seat states change by the second, so no browser or proxy may answer from a stored copy.
    res.set('Cache-Control', 'no-store').json(seatMap);
  });

  return router;
}
