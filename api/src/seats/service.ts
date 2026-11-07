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

// Only what changes: the ids of the seats that aren't available. A page polls this (FR-SEAT-5)
// after loading the full map once, since names and prices never change.
export interface SeatStates {
  held: number[];
  sold: number[];
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

// The seats the map would show as held or sold, by the same rule: a lapsed hold is available.
// Postgres writes the answer's JSON itself, as one row: near a sellout the API would otherwise
// parse 2,000 rows and serialise them again on every poll, which capped it at about 470 polls a
// second (WP 7.3). No row for an unknown event; empty arrays for an event with nothing taken.
export const SEAT_STATES_QUERY = `
  SELECT json_build_object(
           'held', coalesce(array_to_json(array_agg(s.id ORDER BY s.id)
                                            FILTER (WHERE s.status = 'held')), '[]'),
           'sold', coalesce(array_to_json(array_agg(s.id ORDER BY s.id)
                                            FILTER (WHERE s.status = 'sold')), '[]')
         )::text AS states
    FROM events e
    LEFT JOIN seats s
      ON s.event_id = e.id
     AND (s.status = 'sold' OR (s.status = 'held' AND s.held_until >= now()))
   WHERE e.id = $1
   GROUP BY e.id`;

// The SeatStates JSON, ready to send, or undefined when the event doesn't exist. Like
// getSeatMap, a plain read that takes no lock.
export async function getSeatStatesJson(
  db: Pick<Database, 'pool'>,
  eventId: number,
): Promise<string | undefined> {
  const { rows } = await db.pool.query<{ states: string }>(SEAT_STATES_QUERY, [eventId]);
  return rows[0]?.states;
}
