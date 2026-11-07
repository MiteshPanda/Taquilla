import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSchema, faultsOf, startMock } from '../../payments-mock/test/helpers/mock.js';
import type { RunningMock } from '../../payments-mock/test/helpers/mock.js';
import { seedStadium } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { createPaymentClient } from '../src/checkout/payment-client.js';
import { reserve } from '../src/checkout/reserve.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import type { HoldStrategy } from '../src/holds/strategy.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'orders_probe';
const PAYMENTS_SCHEMA = 'orders_payments';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'orders-route-secret-at-least-32-chars';
const FAN = 1;
const RIVAL = 2;

const logger = createLogger('silent');
const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'This order does not exist.' } };

let db: Database;
let mockPool: Pool;
let mock: RunningMock;
let holds: HoldStrategy;
let app: ReturnType<typeof createApp>;

function tokenFor(userId: number): string {
  return `Bearer ${signToken(userId, JWT_SECRET, 3600)}`;
}

function getOrder(orderId: string, userId: number | null = FAN) {
  const req = request(app).get(`/orders/${orderId}`);
  return userId === null ? req : req.set('Authorization', tokenFor(userId));
}

async function holdSeats(seatIds = [41, 42]): Promise<string> {
  return (await holds.hold({ userId: FAN, eventId: 1, seatIds })).holdId;
}

// Pays for seats 41 and 42 through the real checkout and returns its answer.
async function buySeats(): Promise<{ orderId: string } & Record<string, unknown>> {
  const holdId = await holdSeats();
  const res = await request(app)
    .post(`/holds/${holdId}/checkout`)
    .set('Authorization', tokenFor(FAN))
    .set('Idempotency-Key', randomUUID())
    .expect(200);
  return res.body as { orderId: string } & Record<string, unknown>;
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));

  mockPool = await createTestSchema(PAYMENTS_SCHEMA);
  mock = await startMock(mockPool, faultsOf({}));
  const payments = createPaymentClient({ baseUrl: mock.url, logger });

  holds = createHoldStrategy('lock', { db, holdSeconds: 300, logger });
  const config = { NODE_ENV: 'test' as const, JWT_SECRET, JWT_EXPIRES_IN: 3600, RACE_DELAY_MS: 0 };
  app = createApp({
    config: { CORS_ORIGINS: [] },
    logger,
    routes: createRoutes({ db, config, holdStrategy: holds, payments }),
  });
});

beforeEach(async () => {
  await db.pool.query('DELETE FROM idempotency_keys');
  await db.pool.query('DELETE FROM tickets');
  await db.pool.query('DELETE FROM orders');
  await db.pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
      WHERE status <> 'available'`,
  );
  await db.pool.query('DELETE FROM holds');
});

afterAll(async () => {
  await mock.close();
  await mockPool.query(`DROP SCHEMA IF EXISTS ${PAYMENTS_SCHEMA} CASCADE`);
  await mockPool.end();
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('GET /orders/:id', () => {
  it('shows the owner their paid order, each ticket with its seat', async () => {
    const paid = await buySeats();

    const res = await getOrder(paid.orderId).expect(200);

    expect(res.body).toEqual({
      orderId: paid.orderId,
      holdId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string,
      status: 'paid',
      amountPaise: 900_000,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) as string,
      tickets: [
        {
          id: expect.any(Number) as number,
          seatId: 41,
          section: 'Lateral Este',
          row: 'B',
          number: 16,
          pricePaise: 450_000,
        },
        {
          id: expect.any(Number) as number,
          seatId: 42,
          section: 'Lateral Este',
          row: 'B',
          number: 17,
          pricePaise: 450_000,
        },
      ],
    });
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('answers with exactly what the checkout answered', async () => {
    const paid = await buySeats();

    const res = await getOrder(paid.orderId).expect(200);

    expect(res.body).toEqual(paid);
  });

  it('lists only valid tickets', async () => {
    const paid = await buySeats();
    await db.pool.query(`UPDATE tickets SET status = 'cancelled' WHERE seat_id = 42`);

    const res = await getOrder(paid.orderId).expect(200);

    expect((res.body as { tickets: { seatId: number }[] }).tickets).toMatchObject([{ seatId: 41 }]);
  });

  it('shows an order that is not paid yet, with no tickets', async () => {
    const holdId = await holdSeats();
    const reserved = await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });

    const res = await getOrder(reserved.order.id).expect(200);

    expect(res.body).toMatchObject({ holdId, status: 'paying', amountPaise: 900_000, tickets: [] });
  });

  it('answers a stranger with the same 404 as an order that does not exist (FR-AUTH-3)', async () => {
    const paid = await buySeats();

    const stranger = await getOrder(paid.orderId, RIVAL).expect(404);
    const unknown = await getOrder(randomUUID()).expect(404);

    expect(stranger.body).toEqual(NOT_FOUND);
    expect(unknown.body).toEqual(NOT_FOUND);
  });

  it('answers 404 for a malformed id', async () => {
    const res = await getOrder('42').expect(404);

    expect(res.body).toEqual(NOT_FOUND);
  });

  it('answers 401 without a login, before looking anything up', async () => {
    const paid = await buySeats();

    const res = await getOrder(paid.orderId, null).expect(401);

    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});
