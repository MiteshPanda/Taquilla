import { Router } from 'express';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { databaseId } from '../validation.js';
import { getSeatMap, getSeatStatesJson } from './service.js';

// An id that can't name an event is an unknown event, so it gets the same 404.
async function forEvent<T>(
  id: string,
  load: (eventId: number) => Promise<T | undefined>,
): Promise<T> {
  const eventId = databaseId.safeParse(id);
  const found = eventId.success ? await load(eventId.data) : undefined;
  if (found === undefined) {
    throw new AppError(404, 'NOT_FOUND', 'This event does not exist.');
  }
  return found;
}

export function createSeatsRouter({ db }: { db: Pick<Database, 'pool'> }): Router {
  const router = Router();

  // Seat states change by the second, so no browser or proxy may answer from a stored copy.
  router.get('/events/:id/seats', async (req, res) => {
    const seatMap = await forEvent(req.params.id, (eventId) => getSeatMap(db, eventId));
    res.set('Cache-Control', 'no-store').json(seatMap);
  });

  // Under 10 KB even when every seat is sold, against the full map's 200 KB, and already JSON,
  // so 1,000 polling fans cost the API little (WP 7.3).
  router.get('/events/:id/seats/states', async (req, res) => {
    const states = await forEvent(req.params.id, (eventId) => getSeatStatesJson(db, eventId));
    res.set('Cache-Control', 'no-store').type('json').send(states);
  });

  return router;
}
