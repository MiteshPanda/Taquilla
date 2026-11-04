import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../../scripts/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import type { Config } from '../src/config.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'naive_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'naive-test-secret-at-least-32-characters';
const FAN_ID = 1;
const SEAT_ID = 42;

const logger = createLogger('silent');
const token = `Bearer ${signToken(FAN_ID, JWT_SECRET, 3600)}`;

let db: Database;

// Built the way the server builds it, so the production test checks the real wiring.
function app(overrides: Partial<Pick<Config, 'NODE_ENV' | 'RACE_DELAY_MS'>> = {}) {
  const config = {
    NODE_ENV: 'test' as const,
    JWT_SECRET,
    JWT_EXPIRES_IN: 3600,
    RACE_DELAY_MS: 0,
    ...overrides,
  };
  return createApp({ config: { CORS_ORIGINS: [] }, logger, routes: createRoutes({ db, config }) });
}

function buy(body: object | undefined, overrides = {}) {
  const req = request(app(overrides)).post('/dev/buy-naive').set('Authorization', token);
  return body === undefined ? req : req.send(body);
}

async function naiveTickets(): Promise<{ seat_id: number; user_id: number }[]> {
  const { rows } = await db.pool.query<{ seat_id: number; user_id: number }>(
    'SELECT seat_id, user_id FROM naive_tickets ORDER BY id',
  );
  return rows;
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: false });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
});

beforeEach(async () => {
  await db.pool.query('TRUNCATE naive_tickets');
  await db.pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
      WHERE status <> 'available'`,
  );
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('POST /dev/buy-naive', () => {
  it('sells a free seat: 201, the seat is sold and a naive ticket is recorded', async () => {
    const res = await buy({ seatId: SEAT_ID }).expect(201);

    expect(res.body).toEqual({ ticketId: expect.any(Number) as number, seatId: SEAT_ID });
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM seats WHERE id = $1',
      [SEAT_ID],
    );
    expect(rows[0]?.status).toBe('sold');
    expect(await naiveTickets()).toEqual([{ seat_id: SEAT_ID, user_id: FAN_ID }]);
  });

  it('refuses a seat it has already sold, when the requests come one at a time', async () => {
    await buy({ seatId: SEAT_ID }).expect(201);

    const res = await buy({ seatId: SEAT_ID }).expect(409);

    expect(res.body).toEqual({
      error: {
        code: 'SEAT_TAKEN',
        message: `Seat ${SEAT_ID} was just taken. Pick another seat.`,
        seatIds: [SEAT_ID],
      },
    });
    expect(await naiveTickets()).toHaveLength(1);
  });

  it('waits RACE_DELAY_MS between the check and the write', async () => {
    const startedAt = performance.now();
    await buy({ seatId: SEAT_ID }, { RACE_DELAY_MS: 300 }).expect(201);

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(300);
  });

  it('answers 404 for a seat that does not exist', async () => {
    await buy({ seatId: 99_999 }).expect(404, {
      error: { code: 'NOT_FOUND', message: 'This seat does not exist.' },
    });
  });

  it.each([
    ['no body', undefined],
    ['no seatId', {}],
    ['a seatId as a string', { seatId: '42' }],
    ['seatId 0', { seatId: 0 }],
    ['a fractional seatId', { seatId: 1.5 }],
    ['a seatId above the INT maximum', { seatId: 2_147_483_648 }],
  ])('rejects %s with 400', async (_name, body) => {
    await buy(body).expect(400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Send a JSON body with a seatId, the id of one seat.',
      },
    });
  });

  it('needs a login', async () => {
    await request(app()).post('/dev/buy-naive').send({ seatId: SEAT_ID }).expect(401);
  });

  it('does not exist when NODE_ENV is production, even with a valid login', async () => {
    const production = app({ NODE_ENV: 'production' });

    await request(production)
      .post('/dev/buy-naive')
      .set('Authorization', token)
      .send({ seatId: SEAT_ID })
      .expect(404, { error: { code: 'NOT_FOUND', message: 'This route does not exist.' } });
    expect(await naiveTickets()).toEqual([]);
    // Only the dev route is missing; the rest of the API is still there.
    await request(production).get('/health').expect(200);
    await request(production).get('/events/1/seats').expect(200);
  });
});

describe('the naive_tickets table', () => {
  it('can hold the same seat twice, so an oversell shows up as rows instead of an error', async () => {
    await db.pool.query('INSERT INTO naive_tickets (seat_id, user_id) VALUES ($1, 1), ($1, 2)', [
      SEAT_ID,
    ]);

    expect(await naiveTickets()).toHaveLength(2);
  });

  it('is never created in production', async () => {
    const productionSchema = 'naive_production_probe';
    const connectionString = schemaConnectionString(productionSchema);
    await db.pool.query(`DROP SCHEMA IF EXISTS ${productionSchema} CASCADE`);
    await db.pool.query(`CREATE SCHEMA ${productionSchema}`);
    try {
      await runMigrations({ connectionString, logger, production: true });

      const { rows } = await db.pool.query<{ naive: string | null; seats: string | null }>(
        `SELECT to_regclass($1) AS naive, to_regclass($2) AS seats`,
        [`${productionSchema}.naive_tickets`, `${productionSchema}.seats`],
      );
      expect(rows[0]).toEqual({ naive: null, seats: `${productionSchema}.seats` });
    } finally {
      await db.pool.query(`DROP SCHEMA IF EXISTS ${productionSchema} CASCADE`);
    }
  });
});
