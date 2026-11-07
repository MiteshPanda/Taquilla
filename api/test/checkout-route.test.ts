import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Faults } from '../../payments-mock/src/faults.js';
import { createTestSchema, startMock } from '../../payments-mock/test/helpers/mock.js';
import type { RunningMock } from '../../payments-mock/test/helpers/mock.js';
import { seedStadium } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { createPaymentClient } from '../src/checkout/payment-client.js';
import type { PaymentClient } from '../src/checkout/payment-client.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import type { HoldStrategy } from '../src/holds/strategy.js';
import { REPLAYED_HEADER } from '../src/idempotency/middleware.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'checkout_route_probe';
const PAYMENTS_SCHEMA = 'checkout_route_payments';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'checkout-route-secret-at-least-32-chars';
const FAN = 1;
const RIVAL = 2;
// Lateral Este, 4,500 rupees each.
const SEATS = [41, 42];

const logger = createLogger('silent');

let db: Database;
let mockPool: Pool;
let mock: RunningMock;
let holds: HoldStrategy;
let app: ReturnType<typeof createApp>;

// The provider's behaviour, set per test. delay() runs only on a key's first attempt.
const provider = {
  decline: false,
  charging: 0,
  gate: undefined as Promise<void> | undefined,
  // Stand-ins for an outage, on top of the real client.
  chargesDown: false,
  refundsDown: false,
};
const faults: Faults = {
  async delay() {
    provider.charging += 1;
    if (provider.gate) await provider.gate;
  },
  decline: () => provider.decline,
  loseResponse: () => false,
};

function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function tokenFor(userId: number): string {
  return `Bearer ${signToken(userId, JWT_SECRET, 3600)}`;
}

function pay(holdId: string, key: string | undefined, userId = FAN) {
  let req = request(app).post(`/holds/${holdId}/checkout`).set('Authorization', tokenFor(userId));
  if (key !== undefined) req = req.set('Idempotency-Key', key);
  return req;
}

async function holdSeats(userId = FAN, seatIds = SEATS): Promise<string> {
  return (await holds.hold({ userId, eventId: 1, seatIds })).holdId;
}

async function lapse(seatIds: number[]): Promise<void> {
  await db.pool.query(
    `UPDATE seats SET held_until = now() - interval '1 second' WHERE id = ANY($1::int[])`,
    [seatIds],
  );
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await db.pool.query(sql, params);
  return rows[0] as T | undefined;
}

async function orderOf(holdId: string) {
  return one<{ id: string; status: string; payment_key: string | null }>(
    'SELECT id, status, payment_key FROM orders WHERE hold_id = $1',
    [holdId],
  );
}

async function seatStates(seatIds = SEATS) {
  const { rows } = await db.pool.query<{ id: number; status: string; hold_id: string | null }>(
    'SELECT id, status, hold_id FROM seats WHERE id = ANY($1::int[]) ORDER BY id',
    [seatIds],
  );
  return rows;
}

async function chargesFor(orderId: string | undefined) {
  const { rows } = await mockPool.query<{ key: string; status: string; amount_paise: number }>(
    'SELECT key, status, amount_paise FROM charges WHERE order_id = $1',
    [orderId],
  );
  return rows;
}

async function allCharges(): Promise<number> {
  const { rows } = await mockPool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM charges',
  );
  return rows[0]?.count ?? -1;
}

function errorOf(body: unknown): { code?: string; seatIds?: number[] } {
  return (body as { error: { code?: string; seatIds?: number[] } }).error;
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));

  mockPool = await createTestSchema(PAYMENTS_SCHEMA);
  mock = await startMock(mockPool, faults);
  const real = createPaymentClient({ baseUrl: mock.url, logger, wait: () => Promise.resolve() });
  const payments: PaymentClient = {
    charge: (charge, context) =>
      provider.chargesDown
        ? Promise.resolve({ status: 'unavailable' })
        : real.charge(charge, context),
    refund: (key, context) =>
      provider.refundsDown ? Promise.resolve({ status: 'unavailable' }) : real.refund(key, context),
  };

  holds = createHoldStrategy('lock', { db, holdSeconds: 300, logger });
  const config = { NODE_ENV: 'test' as const, JWT_SECRET, JWT_EXPIRES_IN: 3600, RACE_DELAY_MS: 0 };
  app = createApp({
    config: { CORS_ORIGINS: [] },
    logger,
    routes: createRoutes({ db, config, holdStrategy: holds, payments }),
  });
});

beforeEach(async () => {
  Object.assign(provider, {
    decline: false,
    charging: 0,
    gate: undefined,
    chargesDown: false,
    refundsDown: false,
  });
  await db.pool.query('DELETE FROM idempotency_keys');
  await db.pool.query('DELETE FROM tickets');
  await db.pool.query('DELETE FROM orders');
  await db.pool.query(
    `UPDATE seats SET status = 'available', hold_id = NULL, held_until = NULL
      WHERE status <> 'available'`,
  );
  await db.pool.query('DELETE FROM holds');
  await mockPool.query('TRUNCATE charges');
});

afterAll(async () => {
  await mock.close();
  await mockPool.query(`DROP SCHEMA IF EXISTS ${PAYMENTS_SCHEMA} CASCADE`);
  await mockPool.end();
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('POST /holds/:id/checkout: a successful payment', () => {
  it('charges once, then sells the seats, issues one ticket each, and marks it all paid (FR-PAY-8)', async () => {
    const holdId = await holdSeats();

    const res = await pay(holdId, 'tab-1').expect(200);

    const order = await orderOf(holdId);
    // The same shape as GET /orders/:id, which orders.test.ts checks field by field.
    expect(res.body).toMatchObject({
      orderId: order?.id,
      holdId,
      status: 'paid',
      amountPaise: 900_000,
      tickets: [{ seatId: 41 }, { seatId: 42 }],
    });
    expect(order?.status).toBe('paid');
    expect(await seatStates()).toEqual([
      { id: 41, status: 'sold', hold_id: null },
      { id: 42, status: 'sold', hold_id: null },
    ]);
    expect(await one(`SELECT status FROM holds WHERE id = $1`, [holdId])).toEqual({
      status: 'converted',
    });
    expect(await chargesFor(order?.id)).toEqual([
      { key: `pay:${order?.id}:tab-1`, status: 'succeeded', amount_paise: 900_000 },
    ]);
  });

  it('replays the same answer for the same key, without charging again', async () => {
    const holdId = await holdSeats();
    const first = await pay(holdId, 'tab-1').expect(200);

    const again = await pay(holdId, 'tab-1').expect(200);

    expect(again.body).toEqual(first.body);
    expect(again.headers[REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(await allCharges()).toBe(1);
  });

  it('returns the paid order to a new key, without charging again (FR-PAY-6)', async () => {
    const holdId = await holdSeats();
    const first = await pay(holdId, 'tab-1').expect(200);

    const other = await pay(holdId, 'tab-2').expect(200);

    expect(other.body).toEqual(first.body);
    expect(other.headers[REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(await allCharges()).toBe(1);
  });

  it('holds no lock while the provider is charging (FR-PAY-3)', async () => {
    const holdId = await holdSeats();
    const { opened, open } = gate();
    provider.gate = opened;
    const pending = pay(holdId, 'tab-1').then((res) => res);
    await expect.poll(() => provider.charging).toBe(1);

    // NOWAIT fails at once if any other transaction holds the row, so these prove none does.
    const probe = await db.pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM seats WHERE id = ANY($1::int[]) FOR UPDATE NOWAIT', [SEATS]);
      await probe.query('SELECT 1 FROM holds WHERE id = $1 FOR UPDATE NOWAIT', [holdId]);
      await probe.query('SELECT 1 FROM orders WHERE hold_id = $1 FOR UPDATE NOWAIT', [holdId]);
      await probe.query('ROLLBACK');
    } finally {
      probe.release();
    }
    open();

    expect((await pending).status).toBe(200);
  });

  it('gives 10 tabs paying with 10 keys at once one charge between them', async () => {
    const holdId = await holdSeats();

    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, tab) => pay(holdId, `tab-${tab}`).then((res) => res)),
    );

    expect(await allCharges()).toBe(1);
    const paid = replies.filter((res) => res.status === 200);
    expect(paid.length).toBeGreaterThanOrEqual(1);
    expect(new Set(paid.map((res) => (res.body as { orderId: string }).orderId)).size).toBe(1);
    for (const res of replies.filter((reply) => reply.status !== 200)) {
      expect(res.status).toBe(409);
      expect(errorOf(res.body).code).toBe('PAYMENT_IN_PROGRESS');
    }
    expect(await one('SELECT count(*)::int AS count FROM tickets')).toEqual({ count: 2 });
  });
});

describe('POST /holds/:id/checkout: a declined payment (FR-PAY-10)', () => {
  it('answers 402, sets the order back to pending, and keeps the seats held', async () => {
    const holdId = await holdSeats();
    provider.decline = true;

    const res = await pay(holdId, 'tab-1').expect(402);

    expect(errorOf(res.body).code).toBe('PAYMENT_DECLINED');
    const order = await orderOf(holdId);
    expect(order).toMatchObject({ status: 'pending', payment_key: null });
    expect(await seatStates()).toEqual([
      { id: 41, status: 'held', hold_id: holdId },
      { id: 42, status: 'held', hold_id: holdId },
    ]);
    expect(await chargesFor(order?.id)).toMatchObject([{ status: 'declined' }]);
    expect(await one('SELECT count(*)::int AS count FROM tickets')).toEqual({ count: 0 });
  });

  it('replays the decline for the same key, and pays with a new one', async () => {
    const holdId = await holdSeats();
    provider.decline = true;
    await pay(holdId, 'tab-1').expect(402);
    provider.decline = false;

    await pay(holdId, 'tab-1').expect(402);
    const retry = await pay(holdId, 'tab-1-retry').expect(200);

    expect((retry.body as { status: string }).status).toBe('paid');
    const order = await orderOf(holdId);
    expect((await chargesFor(order?.id)).map((charge) => charge.status).sort()).toEqual([
      'declined',
      'succeeded',
    ]);
  });
});

describe('POST /holds/:id/checkout: seats lost after charging (FR-PAY-9)', () => {
  // Holds the provider mid-charge while seat 42 lapses and a rival takes it.
  async function loseSeatWhileCharging(holdId: string, key: string) {
    const { opened, open } = gate();
    provider.gate = opened;
    const pending = pay(holdId, key).then((res) => res);
    await expect.poll(() => provider.charging).toBe(1);
    await lapse([42]);
    const rivalHold = await holdSeats(RIVAL, [42]);
    open();
    return { res: await pending, rivalHold };
  }

  it('refunds the charge, marks the order refunded, frees the rest and answers 409', async () => {
    const holdId = await holdSeats();

    const { res, rivalHold } = await loseSeatWhileCharging(holdId, 'tab-1');

    expect(res.status).toBe(409);
    expect(errorOf(res.body)).toMatchObject({ code: 'SEAT_LOST_REFUNDED', seatIds: [42] });
    const order = await orderOf(holdId);
    expect(order?.status).toBe('refunded');
    expect(await chargesFor(order?.id)).toMatchObject([{ status: 'refunded' }]);
    expect(await seatStates()).toEqual([
      { id: 41, status: 'available', hold_id: null },
      { id: 42, status: 'held', hold_id: rivalHold },
    ]);
    expect(await one(`SELECT status FROM holds WHERE id = $1`, [holdId])).toEqual({
      status: 'released',
    });
    expect(await one('SELECT count(*)::int AS count FROM tickets')).toEqual({ count: 0 });
  });

  it('answers 409 SEAT_LOST_REFUNDED to a new key later, without charging', async () => {
    const holdId = await holdSeats();
    await loseSeatWhileCharging(holdId, 'tab-1');

    const res = await pay(holdId, 'tab-2').expect(409);

    expect(errorOf(res.body).code).toBe('SEAT_LOST_REFUNDED');
    expect(await allCharges()).toBe(1);
  });

  it('answers 503 if the refund fails, and the same key later finishes the refund', async () => {
    const holdId = await holdSeats();
    provider.refundsDown = true;

    const { res } = await loseSeatWhileCharging(holdId, 'tab-1');

    expect(res.status).toBe(503);
    expect(errorOf(res.body).code).toBe('PAYMENT_UNAVAILABLE');
    expect(await orderOf(holdId)).toMatchObject({ status: 'paying' });

    provider.refundsDown = false;
    const retry = await pay(holdId, 'tab-1').expect(409);

    expect(errorOf(retry.body)).toMatchObject({ code: 'SEAT_LOST_REFUNDED', seatIds: [42] });
    const order = await orderOf(holdId);
    expect(order?.status).toBe('refunded');
    expect(await chargesFor(order?.id)).toMatchObject([{ status: 'refunded' }]);
  });

  it('finishes as refunded when the refund went through but was never recorded', async () => {
    // As if the server refunded the charge, then crashed before marking the order refunded.
    const holdId = await holdSeats();
    provider.refundsDown = true;
    const { rivalHold } = await loseSeatWhileCharging(holdId, 'tab-1');
    const order = await orderOf(holdId);
    await fetch(`${mock.url}/charges/${encodeURIComponent(order?.payment_key ?? '')}/refund`, {
      method: 'POST',
    });
    provider.refundsDown = false;
    // Even if every seat were the fan's again, money that was given back can't pay for them.
    await db.pool.query(
      `UPDATE seats SET hold_id = $1, held_until = now() + interval '5 minutes' WHERE id = 42`,
      [holdId],
    );
    await db.pool.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [rivalHold]);

    const retry = await pay(holdId, 'tab-1').expect(409);

    expect(errorOf(retry.body).code).toBe('SEAT_LOST_REFUNDED');
    expect((await orderOf(holdId))?.status).toBe('refunded');
    expect(await seatStates()).toMatchObject([{ status: 'available' }, { status: 'available' }]);
    expect(await one('SELECT count(*)::int AS count FROM tickets')).toEqual({ count: 0 });
    expect(await allCharges()).toBe(1);
  });

  it('counts a seat that lapsed mid-payment as lost, even if nobody took it', async () => {
    const holdId = await holdSeats();
    const { opened, open } = gate();
    provider.gate = opened;
    const pending = pay(holdId, 'tab-1').then((res) => res);
    await expect.poll(() => provider.charging).toBe(1);
    await lapse([42]);
    open();

    const res = await pending;

    expect(res.status).toBe(409);
    expect(errorOf(res.body)).toMatchObject({ code: 'SEAT_LOST_REFUNDED', seatIds: [42] });
    expect(await seatStates()).toMatchObject([{ status: 'available' }, { status: 'available' }]);
  });
});

describe('POST /holds/:id/checkout: refused before any charge', () => {
  it('answers 409 HOLD_EXPIRED for a hold whose seats were re-taken, and charges nothing (FR-PAY-4)', async () => {
    const holdId = await holdSeats();
    await lapse([42]);
    await holdSeats(RIVAL, [42]);

    const res = await pay(holdId, 'tab-1').expect(409);

    expect(errorOf(res.body)).toMatchObject({ code: 'HOLD_EXPIRED', seatIds: [42] });
    expect(await allCharges()).toBe(0);
    expect(await orderOf(holdId)).toBeUndefined();
  });

  it('answers 503 and leaves the order paying when the provider is unreachable (FR-PAY-12)', async () => {
    const holdId = await holdSeats();
    provider.chargesDown = true;

    const res = await pay(holdId, 'tab-1').expect(503);

    expect(errorOf(res.body).code).toBe('PAYMENT_UNAVAILABLE');
    expect(await orderOf(holdId)).toMatchObject({ status: 'paying' });
  });

  it('answers 400 without an Idempotency-Key (FR-PAY-1)', async () => {
    const holdId = await holdSeats();

    const res = await pay(holdId, undefined).expect(400);

    expect(errorOf(res.body).code).toBe('VALIDATION_FAILED');
    expect(await orderOf(holdId)).toBeUndefined();
  });

  it('answers 404 for another fan’s hold and for a malformed id, and 401 without a login', async () => {
    const holdId = await holdSeats();

    await pay(holdId, 'tab-1', RIVAL).expect(404);
    await pay('not-a-uuid', 'tab-1').expect(404);
    await request(app).post(`/holds/${holdId}/checkout`).set('Idempotency-Key', 'k').expect(401);
    expect(await allCharges()).toBe(0);
  });
});
