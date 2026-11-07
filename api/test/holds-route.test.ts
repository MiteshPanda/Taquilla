import { Client, DatabaseError } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { BOOKING_STRATEGIES } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { mapDatabaseError } from '../src/errors.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { MAX_INT } from '../src/validation.js';
import { schemaConnectionString } from './helpers/database.js';
import { NO_PAYMENTS } from './helpers/payments.js';

const SCHEMA = 'holds_route_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'holds-route-secret-at-least-32-chars';
const FAN = 1;
const RIVAL = 2;

const logger = createLogger('silent');
const SEATS_RULE = 'Send a JSON body with seatIds: a list of 1 to 6 seat ids.';
const UNKNOWN_EVENT = { error: { code: 'NOT_FOUND', message: 'This event does not exist.' } };

let db: Database;

function tokenFor(userId: number): string {
  return `Bearer ${signToken(userId, JWT_SECRET, 3600)}`;
}

function databaseError(code: string, fields: Partial<DatabaseError> = {}): DatabaseError {
  return Object.assign(new DatabaseError('from postgres', 0, 'error'), { code, ...fields });
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
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

describe.each(BOOKING_STRATEGIES)('POST /events/:id/holds with the %s strategy', (name) => {
  let app: ReturnType<typeof createApp>;

  function post(
    body: unknown,
    { eventId = '1', userId = FAN }: { eventId?: string; userId?: number | null } = {},
  ) {
    let req = request(app).post(`/events/${eventId}/holds`);
    if (userId !== null) req = req.set('Authorization', tokenFor(userId));
    return body === undefined ? req : req.send(body as object);
  }

  beforeAll(() => {
    const config = {
      NODE_ENV: 'test' as const,
      JWT_SECRET,
      JWT_EXPIRES_IN: 3600,
      RACE_DELAY_MS: 0,
    };
    const holdStrategy = createHoldStrategy(name, { db, holdSeconds: 300, logger });
    app = createApp({
      config: { CORS_ORIGINS: [] },
      logger,
      routes: createRoutes({ db, config, holdStrategy, payments: NO_PAYMENTS }),
    });
  });

  describe('201', () => {
    it('holds the seats and returns the hold', async () => {
      const res = await post({ seatIds: [42, 41] }).expect(201);

      expect(res.body).toEqual({
        holdId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
        seatIds: [41, 42],
        amountPaise: 900_000,
        expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) as string,
      });
      const { rows } = await db.pool.query<{ user_id: number; held_until: Date }>(
        `SELECT h.user_id, s.held_until FROM holds h JOIN seats s ON s.hold_id = h.id
          WHERE h.id = $1`,
        [(res.body as { holdId: string }).holdId],
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]?.user_id).toBe(FAN);
      expect(rows[0]?.held_until.toISOString()).toBe((res.body as { expiresAt: string }).expiresAt);
    });

    it('takes the fan from the token, not from the body', async () => {
      const res = await post({ seatIds: [42], userId: RIVAL }).expect(201);

      const { rows } = await db.pool.query<{ user_id: number }>(
        'SELECT user_id FROM holds WHERE id = $1',
        [(res.body as { holdId: string }).holdId],
      );
      expect(rows[0]?.user_id).toBe(FAN);
    });
  });

  describe('400', () => {
    it.each([
      ['no body', undefined, SEATS_RULE],
      ['no seatIds', {}, SEATS_RULE],
      ['seatIds that is not a list', { seatIds: 42 }, SEATS_RULE],
      ['an empty list', { seatIds: [] }, SEATS_RULE],
      ['seven seats', { seatIds: [41, 42, 43, 44, 45, 46, 47] }, SEATS_RULE],
      ['a seat id as a string', { seatIds: ['42'] }, SEATS_RULE],
      ['a fractional seat id', { seatIds: [4.2] }, SEATS_RULE],
      ['seat id 0', { seatIds: [0] }, SEATS_RULE],
      ['a negative seat id', { seatIds: [-42] }, SEATS_RULE],
      ['a seat id above the INT maximum', { seatIds: [MAX_INT + 1] }, SEATS_RULE],
      ['the same seat twice', { seatIds: [42, 42] }, 'List each seat only once.'],
    ])('rejects %s', async (_case, body, message) => {
      await post(body).expect(400, { error: { code: 'VALIDATION_FAILED', message } });
      expect((await db.pool.query('SELECT 1 FROM holds')).rowCount).toBe(0);
    });

    it('rejects seats that are not part of the event, listing them', async () => {
      await post({ seatIds: [41, 99_999] }).expect(400, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Seat 99999 is not part of this event.',
          seatIds: [99_999],
        },
      });
    });
  });

  describe('401', () => {
    it('needs a login, and checks it before the body', async () => {
      await post({ seatIds: 'nonsense' }, { userId: null }).expect(401, {
        error: { code: 'UNAUTHORIZED', message: 'Log in to continue.' },
      });
    });

    it('rejects a token signed with another secret', async () => {
      await request(app)
        .post('/events/1/holds')
        .set(
          'Authorization',
          `Bearer ${signToken(FAN, 'another-secret-of-at-least-32-chars', 3600)}`,
        )
        .send({ seatIds: [42] })
        .expect(401);
    });
  });

  describe('404', () => {
    it.each(['999', 'abc', '0', '2147483648'])('answers 404 for event %s', async (eventId) => {
      await post({ seatIds: [42] }, { eventId }).expect(404, UNKNOWN_EVENT);
    });
  });

  describe('409', () => {
    it('answers SEAT_TAKEN when another fan holds the seat, listing it', async () => {
      await post({ seatIds: [42] }, { userId: RIVAL }).expect(201);

      await post({ seatIds: [41, 42] }).expect(409, {
        error: {
          code: 'SEAT_TAKEN',
          message: 'Seat 42 was just taken. Pick another seat.',
          seatIds: [42],
        },
      });
    });

    it('answers SEAT_BUSY when the seat stays locked past the lock timeout', async () => {
      const booking = new Client({ connectionString: CONNECTION_STRING });
      await booking.connect();
      try {
        await booking.query('BEGIN');
        await booking.query('SELECT 1 FROM seats WHERE id = 42 FOR UPDATE');

        await post({ seatIds: [42] }).expect(409, {
          error: {
            code: 'SEAT_BUSY',
            message: 'Those seats are busy right now. Try again in a moment.',
          },
        });
      } finally {
        await booking.query('ROLLBACK');
        await booking.end();
      }
    });
  });
});

describe('mapDatabaseError (requirements.md §6.4)', () => {
  it.each([
    ['40001', 'a serialization failure'],
    ['40P01', 'a deadlock'],
    ['55P03', 'a lock timeout'],
  ])('maps %s, %s, to 409 SEAT_BUSY', (code) => {
    expect(mapDatabaseError(databaseError(code))).toMatchObject({ status: 409, code: 'SEAT_BUSY' });
  });

  it('maps a second valid ticket for a seat to 409 SEAT_TAKEN, naming the seat', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES (1, 1, '{42}', 1)
       RETURNING id`,
    );
    const { rows: orders } = await db.pool.query<{ id: string }>(
      `INSERT INTO orders (hold_id, user_id, amount_paise) VALUES ($1, 1, 1) RETURNING id`,
      [rows[0]?.id],
    );
    const insertTicket = () =>
      db.pool.query('INSERT INTO tickets (order_id, seat_id) VALUES ($1, 42)', [orders[0]?.id]);
    await insertTicket();

    // A real error from Postgres, so the test checks its actual wording.
    const err: unknown = await insertTicket().catch((caught: unknown) => caught);

    expect(mapDatabaseError(err)).toMatchObject({
      status: 409,
      code: 'SEAT_TAKEN',
      message: 'Seat 42 was just taken. Pick another seat.',
      details: { seatIds: [42] },
    });
    await db.pool.query('DELETE FROM tickets');
    await db.pool.query('DELETE FROM orders');
  });

  it('maps a duplicate email to 409 EMAIL_TAKEN', () => {
    expect(
      mapDatabaseError(databaseError('23505', { constraint: 'users_email_key' })),
    ).toMatchObject({
      status: 409,
      code: 'EMAIL_TAKEN',
    });
  });

  it.each([
    [
      'a unique violation on another constraint',
      databaseError('23505', { constraint: 'orders_hold_id_key' }),
    ],
    ['a check violation', databaseError('23514')],
    ['an error that is not from Postgres', Object.assign(new Error('refused'), { code: '55P03' })],
  ])('leaves %s alone, so it stays a 500', (_case, err) => {
    expect(mapDatabaseError(err)).toBeUndefined();
  });
});
