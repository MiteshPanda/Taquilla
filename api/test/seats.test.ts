import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../../scripts/seed.js';
import { createApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createSeatsRouter } from '../src/seats/routes.js';
import { SEAT_MAP_QUERY } from '../src/seats/service.js';
import type { Seat, SeatMap, SeatStates } from '../src/seats/service.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'seats_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const SEAT_42 = 42;

const logger = createLogger('silent');
const UNKNOWN_EVENT = { error: { code: 'NOT_FOUND', message: 'This event does not exist.' } };

let db: Database;
let holdId: string;
const app = () =>
  createApp({ config: { CORS_ORIGINS: [] }, logger, routes: createSeatsRouter({ db }) });

async function seatMap(eventId: number | string = 1): Promise<SeatMap> {
  const res = await request(app()).get(`/events/${eventId}/seats`).expect(200);
  return res.body as SeatMap;
}

async function seatStates(eventId: number | string = 1): Promise<SeatStates> {
  const res = await request(app()).get(`/events/${eventId}/seats/states`).expect(200);
  return res.body as SeatStates;
}

async function stateOf(seatId: number): Promise<Seat['state'] | undefined> {
  const { seats } = await seatMap();
  return seats.find((seat) => seat.id === seatId)?.state;
}

function holdSeat(seatId: number, heldUntil: string): Promise<unknown> {
  return db.pool.query(
    `UPDATE seats SET status = 'held', hold_id = $2, held_until = now() + $3::interval WHERE id = $1`,
    [seatId, holdId, heldUntil],
  );
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise)
     VALUES (1, 1, $1, 450000) RETURNING id`,
    [[SEAT_42]],
  );
  holdId = rows[0]?.id ?? '';
});

beforeEach(async () => {
  await db.pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
      WHERE status <> 'available'`,
  );
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('GET /events/:id/seats', () => {
  it('returns the event and its 2,000 seats in section, row and seat order', async () => {
    const { event, seats } = await seatMap();

    expect(event).toEqual({
      id: 1,
      name: 'Chamartín FC vs Castellana United',
      startsAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
    });
    expect(seats).toHaveLength(2_000);
    const sorted = [...seats].sort(
      (a, b) =>
        a.section.localeCompare(b.section) || a.row.localeCompare(b.row) || a.number - b.number,
    );
    expect(seats).toEqual(sorted);
    expect(seats[0]).toMatchObject({ section: 'Fondo Norte', row: 'A', number: 1 });
    expect(seats.at(-1)).toMatchObject({ section: 'Lateral Oeste', row: 'T', number: 25 });
  });

  it('shows every seat as available on a fresh stadium', async () => {
    const { seats } = await seatMap();

    expect(seats.every((seat) => seat.state === 'available')).toBe(true);
  });

  it('gives each seat its id, place, price in paise and state, and nothing about who holds it', async () => {
    await holdSeat(SEAT_42, '5 minutes');

    const { seats } = await seatMap();

    expect(seats.find((seat) => seat.id === SEAT_42)).toStrictEqual({
      id: SEAT_42,
      section: 'Lateral Este',
      row: 'B',
      number: 17,
      pricePaise: 450_000,
      state: 'held',
    });
  });

  it('reports a seat whose hold has lapsed as available, before any sweeper runs', async () => {
    await holdSeat(SEAT_42, '-1 second');

    expect(await stateOf(SEAT_42)).toBe('available');
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM seats WHERE id = $1',
      [SEAT_42],
    );
    expect(rows[0]?.status).toBe('held');
  });

  it('reports a sold seat as sold', async () => {
    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [SEAT_42]);

    expect(await stateOf(SEAT_42)).toBe('sold');
  });

  it('tells browsers and proxies not to store it', async () => {
    const res = await request(app()).get('/events/1/seats').expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers without waiting while a booking has the seat locked', async () => {
    const booking = new Client({ connectionString: CONNECTION_STRING });
    await booking.connect();
    try {
      await booking.query('BEGIN');
      await booking.query('SELECT 1 FROM seats WHERE id = $1 FOR UPDATE', [SEAT_42]);
      await booking.query(
        `UPDATE seats SET status = 'held', hold_id = $2, held_until = now() + interval '5 minutes'
          WHERE id = $1`,
        [SEAT_42, holdId],
      );

      const startedAt = performance.now();
      const state = await stateOf(SEAT_42);

      // A read that waited on the lock would hang here until the booking finished.
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      // The booking hasn't committed, so the map still shows the seat as it was.
      expect(state).toBe('available');
    } finally {
      await booking.query('ROLLBACK');
      await booking.end();
    }
  });

  it('reads the seats in order straight from the unique index, with no sort (WP 6.4)', async () => {
    // Holds and sales rewrite rows, so on disk the seats drift out of index order, as after a
    // sellout. A freshly seeded table would hide the planner's choice.
    await db.pool.query('UPDATE seats SET price_paise = price_paise WHERE id % 2 = 0');
    await db.pool.query('ANALYZE seats');

    const { rows } = await db.pool.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${SEAT_MAP_QUERY}`,
      [1],
    );

    const plan = JSON.stringify(rows[0]?.['QUERY PLAN']);
    expect(plan).toContain('"Node Type":"Index Scan"');
    expect(plan).toContain('"Index Name":"seats_event_id_section_row_label_seat_no_key"');
    expect(plan).not.toContain('"Node Type":"Sort"');
  });

  it('returns only the seats of the event asked for', async () => {
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO events (name, starts_at) VALUES ('Friendly', now()) RETURNING id`,
    );
    const otherEventId = rows[0]?.id ?? 0;

    const other = await seatMap(otherEventId);

    expect(other.event).toMatchObject({ id: otherEventId, name: 'Friendly' });
    expect(other.seats).toEqual([]);
    expect((await seatMap()).seats).toHaveLength(2_000);
    await db.pool.query('DELETE FROM events WHERE id = $1', [otherEventId]);
  });

  it.each(['999', '2147483647'])('answers 404 for event %s, which does not exist', async (id) => {
    await request(app()).get(`/events/${id}/seats`).expect(404, UNKNOWN_EVENT);
  });

  it.each(['abc', '0', '-1', '1.5', '01', '2147483648', '99999999999999999999'])(
    'answers 404 for the id %s, which no event can have',
    async (id) => {
      await request(app()).get(`/events/${id}/seats`).expect(404, UNKNOWN_EVENT);
    },
  );
});

describe('GET /events/:id/seats/states', () => {
  it('lists nothing on a fresh stadium, and tells browsers and proxies not to store it', async () => {
    const res = await request(app()).get('/events/1/seats/states').expect(200);

    expect(res.body).toEqual({ held: [], sold: [] });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('lists live holds and sales by seat id, in order, and leaves out a lapsed hold', async () => {
    await holdSeat(SEAT_42, '5 minutes');
    await holdSeat(7, '5 minutes');
    await holdSeat(100, '-1 second');
    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = ANY($1)`, [[1500, 3]]);

    expect(await seatStates()).toEqual({ held: [7, SEAT_42], sold: [3, 1500] });
  });

  it('lists ids in id order, however the rows are stored or indexed', async () => {
    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = ANY($1)`, [[1500, 3]]);
    await holdSeat(1600, '5 minutes');
    await holdSeat(5, '5 minutes');
    // Rewrite the table in (section, row, seat) order, the order of that index too. The Fondo
    // stands' seats 1001 to 2000 then come before Lateral Este's 1 to 500, both on disk and in
    // the index, so only the query's own ORDER BY id lists seat 3 before 1500, and 5 before 1600.
    await db.pool.query('CLUSTER seats USING seats_event_id_section_row_label_seat_no_key');

    expect(await seatStates()).toEqual({ held: [5, 1600], sold: [3, 1500] });
  });

  it('agrees with the full map on every seat', async () => {
    // A mix across all four stands: live holds, lapsed holds and sales.
    await db.pool.query(
      `UPDATE seats SET status = 'held', hold_id = $1,
              held_until = now() + CASE WHEN id % 2 = 0 THEN interval '5 minutes'
                                        ELSE interval '-1 second' END
        WHERE id % 7 = 0`,
      [holdId],
    );
    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id % 11 = 0 AND id % 7 <> 0`);

    const { seats } = await seatMap();
    const idsIn = (state: Seat['state']) =>
      seats
        .filter((seat) => seat.state === state)
        .map((seat) => seat.id)
        .sort((a, b) => a - b);
    const states = await seatStates();

    expect(states).toEqual({ held: idsIn('held'), sold: idsIn('sold') });
    expect(states.held.length).toBeGreaterThan(100);
    expect(states.sold.length).toBeGreaterThan(100);
  });

  it('stays under 10 KB even when every seat is sold, against the full map’s 200 KB', async () => {
    await db.pool.query(`UPDATE seats SET status = 'sold'`);

    const states = await request(app()).get('/events/1/seats/states').expect(200);
    const map = await request(app()).get('/events/1/seats').expect(200);

    expect((states.body as SeatStates).sold).toHaveLength(2_000);
    expect(states.text.length).toBeLessThan(10_000);
    expect(map.text.length).toBeGreaterThan(150_000);
  });

  it('answers without waiting while a booking has a seat locked', async () => {
    const booking = new Client({ connectionString: CONNECTION_STRING });
    await booking.connect();
    try {
      await booking.query('BEGIN');
      await booking.query('SELECT 1 FROM seats WHERE id = $1 FOR UPDATE', [SEAT_42]);
      await booking.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [SEAT_42]);

      const startedAt = performance.now();
      const states = await seatStates();

      expect(performance.now() - startedAt).toBeLessThan(1_000);
      // The booking hasn't committed, so the seat is still available.
      expect(states).toEqual({ held: [], sold: [] });
    } finally {
      await booking.query('ROLLBACK');
      await booking.end();
    }
  });

  it('lists only the seats of the event asked for', async () => {
    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = $1`, [SEAT_42]);
    const { rows } = await db.pool.query<{ id: number }>(
      `INSERT INTO events (name, starts_at) VALUES ('Friendly', now()) RETURNING id`,
    );
    const otherEventId = rows[0]?.id ?? 0;

    expect(await seatStates(otherEventId)).toEqual({ held: [], sold: [] });
    expect(await seatStates()).toEqual({ held: [], sold: [SEAT_42] });
    await db.pool.query('DELETE FROM events WHERE id = $1', [otherEventId]);
  });

  it.each(['999', '2147483647', 'abc', '0', '-1', '1.5', '01', '2147483648'])(
    'answers 404 for the event id %s',
    async (id) => {
      await request(app()).get(`/events/${id}/seats/states`).expect(404, UNKNOWN_EVENT);
    },
  );
});
