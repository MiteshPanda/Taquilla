import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../../scripts/seed.js';
import { BOOKING_STRATEGIES } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { AppError } from '../src/errors.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import type { HoldStrategy } from '../src/holds/strategy.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { schemaConnectionString } from './helpers/database.js';

// Every strategy must give the same answers (FR-HOLD-5).
const STRATEGIES = BOOKING_STRATEGIES;

const SCHEMA = 'holds_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const HOLD_SECONDS = 120;
const EVENT_ID = 1;
const FAN = 1;
const RIVAL = 2;
// Seats 41 to 46 are Lateral Este, row B, at 450,000 paise; 1001 is Fondo Norte at 250,000.
const LATERAL_PRICE = 450_000;
const FONDO_SEAT = 1001;
const FONDO_PRICE = 250_000;

const logger = createLogger('silent');
let db: Database;

interface SeatState {
  id: number;
  status: string;
  hold_id: string | null;
  held_until: Date | null;
}

async function seats(ids: number[]): Promise<SeatState[]> {
  const { rows } = await db.pool.query<SeatState>(
    'SELECT id, status, hold_id, held_until FROM seats WHERE id = ANY($1::int[]) ORDER BY id',
    [ids],
  );
  return rows;
}

async function holdCount(): Promise<number> {
  const { rows } = await db.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM holds',
  );
  return rows[0]?.count ?? -1;
}

async function dbNow(): Promise<Date> {
  const { rows } = await db.pool.query<{ now: Date }>('SELECT now()');
  return rows[0]?.now ?? new Date(0);
}

// Puts seats on hold for the rival directly, as an earlier hold would have left them.
async function holdForRival(seatIds: number[], heldFor: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES ($1, $2, $3, 1)
     RETURNING id`,
    [RIVAL, EVENT_ID, seatIds],
  );
  const holdId = rows[0]?.id ?? '';
  await db.pool.query(
    `UPDATE seats SET status = 'held', hold_id = $1, held_until = now() + $2::interval
      WHERE id = ANY($3::int[])`,
    [holdId, heldFor, seatIds],
  );
  return holdId;
}

// The pool opens connections only when asked, one after another. Opening all 20 first makes the
// fans' transactions really overlap, instead of the first finishing before the rest connect.
async function openAllConnections(): Promise<void> {
  await Promise.all(Array.from({ length: 20 }, () => db.pool.query('SELECT pg_sleep(0.05)')));
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
  await db.pool.query(`INSERT INTO events (name, starts_at) VALUES ('Friendly', now())`);
});

beforeEach(async () => {
  await db.pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
      WHERE status <> 'available'`,
  );
  await db.pool.query('DELETE FROM holds');
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe.each(STRATEGIES)('the %s strategy', (name) => {
  let strategy: HoldStrategy;

  function hold(seatIds: number[], userId = FAN, eventId = EVENT_ID) {
    return strategy.hold({ userId, eventId, seatIds });
  }

  beforeAll(() => {
    strategy = createHoldStrategy(name, { db, holdSeconds: HOLD_SECONDS, logger });
  });

  describe('free seats', () => {
    it('holds them and returns the hold, priced in paise', async () => {
      const result = await hold([41, 42]);

      expect(result).toEqual({
        holdId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        seatIds: [41, 42],
        amountPaise: 2 * LATERAL_PRICE,
        expiresAt: expect.any(Date) as Date,
      });
      const { rows } = await db.pool.query(
        'SELECT user_id, event_id, seat_ids, amount_paise, status FROM holds WHERE id = $1',
        [result.holdId],
      );
      expect(rows).toEqual([
        {
          user_id: FAN,
          event_id: EVENT_ID,
          seat_ids: [41, 42],
          amount_paise: 2 * LATERAL_PRICE,
          status: 'active',
        },
      ]);
    });

    it('marks every seat held by the hold, until the expiry it returned', async () => {
      const { holdId, expiresAt } = await hold([42, 41, FONDO_SEAT]);

      expect(await seats([41, 42, FONDO_SEAT])).toEqual(
        [41, 42, FONDO_SEAT].map((id) => ({
          id,
          status: 'held',
          hold_id: holdId,
          held_until: expiresAt,
        })),
      );
    });

    it('returns seat ids in ascending order and adds up mixed prices', async () => {
      const result = await hold([FONDO_SEAT, 42, 41]);

      expect(result.seatIds).toEqual([41, 42, FONDO_SEAT]);
      expect(result.amountPaise).toBe(2 * LATERAL_PRICE + FONDO_PRICE);
    });

    it('takes the expiry from the database clock: now() plus HOLD_SECONDS', async () => {
      const before = await dbNow();
      const { expiresAt } = await hold([42]);
      const after = await dbNow();

      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + HOLD_SECONDS * 1000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after.getTime() + HOLD_SECONDS * 1000);
    });

    it('holds six seats at once', async () => {
      const result = await hold([41, 42, 43, 44, 45, 46]);

      expect(result.amountPaise).toBe(6 * LATERAL_PRICE);
    });
  });

  describe('taken seats', () => {
    it('refuses a seat someone else holds, with 409 SEAT_TAKEN naming it', async () => {
      await holdForRival([42], '5 minutes');

      await expect(hold([42])).rejects.toMatchObject({
        status: 409,
        code: 'SEAT_TAKEN',
        message: 'Seat 42 was just taken. Pick another seat.',
        details: { seatIds: [42] },
      });
    });

    it('refuses a sold seat', async () => {
      await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = 42`);

      await expect(hold([42])).rejects.toMatchObject({
        code: 'SEAT_TAKEN',
        details: { seatIds: [42] },
      });
    });

    it('holds nothing when one of the seats is taken, and lists only the taken ones', async () => {
      await holdForRival([42, 44], '5 minutes');
      const holdsBefore = await holdCount();

      await expect(hold([41, 42, 43, 44])).rejects.toMatchObject({
        message: 'Seats 42 and 44 were just taken. Pick other seats.',
        details: { seatIds: [42, 44] },
      });
      expect((await seats([41, 43])).map((seat) => seat.status)).toEqual([
        'available',
        'available',
      ]);
      expect(await holdCount()).toBe(holdsBefore);
    });

    it('refuses the second of two fans asking one after the other', async () => {
      await hold([42]);

      await expect(hold([42], RIVAL)).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('expired holds', () => {
    it('treats a lapsed hold as free and gives the seat to the new fan, before any sweeper runs', async () => {
      await holdForRival([42], '-1 second');

      const { holdId } = await hold([42]);

      expect(await seats([42])).toMatchObject([{ status: 'held', hold_id: holdId }]);
    });
  });

  describe('unknown seats and events', () => {
    it.each([
      [
        'a seat that does not exist',
        [41, 99_999],
        'Seat 99999 is not part of this event.',
        [99_999],
      ],
      [
        'seats that do not exist',
        [99_998, 41, 99_999],
        'Seats 99998 and 99999 are not part of this event.',
        [99_998, 99_999],
      ],
    ])('rejects %s with 400, holding nothing', async (_case, seatIds, message, missing) => {
      await expect(hold(seatIds)).rejects.toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        message,
        details: { seatIds: missing },
      });
      expect(await holdCount()).toBe(0);
      expect((await seats([41]))[0]?.status).toBe('available');
    });

    it('rejects a seat from another event with 400, even though the seat exists', async () => {
      await expect(hold([42], FAN, 2)).rejects.toMatchObject({
        status: 400,
        details: { seatIds: [42] },
      });
    });

    it('rejects an event that does not exist with 404', async () => {
      await expect(hold([42], FAN, 999)).rejects.toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
        message: 'This event does not exist.',
      });
    });
  });

  describe('contention', () => {
    it('gives the seat to exactly one of 20 fans asking at once', async () => {
      await openAllConnections();
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => hold([42], 100 + i)),
      );

      const won = results.filter((result) => result.status === 'fulfilled');
      const lost = results.filter((result) => result.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(19);
      // serializable may run out of retries and let Postgres's 40001 through, as its contract
      // allows; the holds route answers that with 409 SEAT_BUSY. The others always say SEAT_TAKEN.
      const allowed = name === 'serializable' ? ['SEAT_TAKEN', '40001'] : ['SEAT_TAKEN'];
      for (const { reason } of lost) {
        expect(allowed).toContain((reason as { code?: string }).code);
      }
      expect(await holdCount()).toBe(1);
    });

    it('waits for a booking that has the seat locked, then sees its result', async () => {
      const booking = new Client({ connectionString: CONNECTION_STRING });
      await booking.connect();
      try {
        await booking.query('BEGIN');
        await booking.query('SELECT 1 FROM seats WHERE id = 42 FOR UPDATE');
        const waiting = hold([42]);
        // Give the strategy time to reach the lock and queue behind it.
        await new Promise((resolve) => setTimeout(resolve, 300));
        const { rows } = await booking.query<{ id: string }>(
          `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES ($1, 1, '{42}', 1)
           RETURNING id`,
          [RIVAL],
        );
        await booking.query(
          `UPDATE seats SET status = 'held', hold_id = $1, held_until = now() + interval '5 minutes'
            WHERE id = 42`,
          [rows[0]?.id],
        );
        await booking.query('COMMIT');

        await expect(waiting).rejects.toMatchObject({ code: 'SEAT_TAKEN' });
      } finally {
        await booking.end();
      }
    });

    it('gives up after the 2-second lock_timeout instead of waiting forever', async () => {
      const booking = new Client({ connectionString: CONNECTION_STRING });
      await booking.connect();
      try {
        await booking.query('BEGIN');
        await booking.query('SELECT 1 FROM seats WHERE id = 42 FOR UPDATE');

        // 55P03 is lock_not_available; the holds route maps it to 409 SEAT_BUSY (WP 3.4).
        await expect(hold([42])).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await booking.query('ROLLBACK');
        await booking.end();
      }
    });
  });
});
