import type { Database } from '../db.js';

export type SeatState = 'available' | 'held' | 'sold';

export interface Seat {
  id: number;
  section: string;
  row: string;
  number: number;
  pricePaise: number;
  state: SeatState;
}

export interface SeatMap {
  event: { id: number; name: string; startsAt: Date };
  seats: Seat[];
}

// Every seat of an event in section, row and seat order: the order of the unique index on
// (event_id, section, row_label, seat_no), which serves it without a sort (WP 6.4).
export const SEAT_MAP_QUERY = `
  SELECT id, section, row_label AS "row", seat_no AS "number", price_paise AS "pricePaise",
         CASE WHEN status = 'held' AND held_until < now() THEN 'available' ELSE status END AS state
    FROM seats
   WHERE event_id = $1
   ORDER BY section, row_label, seat_no`;

// Returns undefined when the event doesn't exist.
export async function getSeatMap(
  db: Pick<Database, 'pool'>,
  eventId: number,
): Promise<SeatMap | undefined> {
  const { rows: events } = await db.pool.query<SeatMap['event']>(
    'SELECT id, name, starts_at AS "startsAt" FROM events WHERE id = $1',
    [eventId],
  );
  const event = events[0];
  if (event === undefined) return undefined;

  // A plain read with no FOR UPDATE, so it never waits for a booking or holds one up.
  // A lapsed hold reads as available at once, without waiting for the sweeper (lazy expiry).
  const { rows: seats } = await db.pool.query<Seat>(SEAT_MAP_QUERY, [eventId]);
  return { event, seats };
}
