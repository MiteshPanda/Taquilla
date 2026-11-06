import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Faults } from '../../payments-mock/src/faults.js';
import { createTestSchema, startMock } from '../../payments-mock/test/helpers/mock.js';
import type { RunningMock } from '../../payments-mock/test/helpers/mock.js';
import { seedStadium } from '../../scripts/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { createPaymentClient } from '../src/checkout/payment-client.js';
import type { PaymentClient } from '../src/checkout/payment-client.js';
import { reserve } from '../src/checkout/reserve.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import type { HoldStrategy } from '../src/holds/strategy.js';
import { hashRequest } from '../src/idempotency/hash.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';

// NFR-6: a timeout, an outage or a crash mid-payment never charges twice, and a retry with the
// same key completes the order (FR-PAY-11, FR-PAY-12).
const SCHEMA = 'checkout_recovery_probe';
const PAYMENTS_SCHEMA = 'checkout_recovery_payments';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'checkout-recovery-secret-at-least-32-chars';
const FAN = 1;
const RIVAL = 2;
const SEATS = [41, 42];

let db: Database;
let mockPool: Pool;
let mock: RunningMock;
let holds: HoldStrategy;
let app: ReturnType<typeof createApp>;
const logs: { msg: string }[] = [];

// The provider's behaviour, set per test. delay() runs only on a key's first attempt.
const provider = {
  charging: 0,
  gate: undefined as Promise<void> | undefined,
  decline: false,
  loseResponse: false,
};
const faults: Faults = {
  async delay() {
    provider.charging += 1;
    if (provider.gate) await provider.gate;
  },
  decline: () => provider.decline,
  loseResponse: () => provider.loseResponse,
};
let openGate: () => void = () => {};

function pauseProvider(): void {
  provider.gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
}

// The client checkout uses, swapped per test. Each attempt gets 200 ms instead of 3 s, and
// retries don't wait, so a whole outage takes under a second.
const clients: Record<'normal' | 'noRetries' | 'unreachable', PaymentClient> = {} as never;
let client: PaymentClient;

function tokenFor(userId: number): string {
  return `Bearer ${signToken(userId, JWT_SECRET, 3600)}`;
}

function pay(holdId: string, key: string) {
  return request(app)
    .post(`/holds/${holdId}/checkout`)
    .set('Authorization', tokenFor(FAN))
    .set('Idempotency-Key', key);
}

async function holdSeats(userId = FAN, seatIds = SEATS): Promise<string> {
  return (await holds.hold({ userId, eventId: 1, seatIds })).holdId;
}

async function orderOf(holdId: string) {
  const { rows } = await db.pool.query<{ id: string; status: string; payment_key: string }>(
    'SELECT id, status, payment_key FROM orders WHERE hold_id = $1',
    [holdId],
  );
  return rows[0];
}

async function charges() {
  const { rows } = await mockPool.query<{ key: string; status: string }>(
    'SELECT key, status FROM charges',
  );
  return rows;
}

async function ticketCount(): Promise<number> {
  const { rows } = await db.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM tickets',
  );
  return rows[0]?.count ?? -1;
}

function codeOf(body: unknown): unknown {
  return (body as { error?: { code?: string } }).error?.code;
}

// Every attempt of the first request times out while the provider is paused; once it resumes,
// those attempts still record the one charge they were sent for. The fan has seen a 503.
async function chargeTheFanNeverHeardAbout(holdId: string, key: string) {
  pauseProvider();
  const first = await pay(holdId, key);
  expect(first.status).toBe(503);
  expect(codeOf(first.body)).toBe('PAYMENT_UNAVAILABLE');
  expect(await orderOf(holdId)).toMatchObject({ status: 'paying' });
  openGate();
  await expect.poll(async () => (await charges()).length).toBe(1);
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger: createLogger('silent') });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({
    connectionString: CONNECTION_STRING,
    logger: createLogger('silent'),
    production: true,
  });
  await db.withTransaction((pg) => seedStadium(pg, 'not-a-real-hash'));

  mockPool = await createTestSchema(PAYMENTS_SCHEMA);
  mock = await startMock(mockPool, faults);
  const silent = createLogger('silent');
  const fast = { logger: silent, timeoutMs: 200, wait: () => Promise.resolve() };
  clients.normal = createPaymentClient({ baseUrl: mock.url, ...fast });
  clients.noRetries = createPaymentClient({ baseUrl: mock.url, ...fast, retries: 0 });
  clients.unreachable = createPaymentClient({ baseUrl: 'http://127.0.0.1:1', ...fast });
  const payments: PaymentClient = {
    charge: (charge, context) => client.charge(charge, context),
    refund: (key, context) => client.refund(key, context),
  };

  const logger = createLogger('info', {
    write: (line: string) => logs.push(JSON.parse(line) as { msg: string }),
  });
  holds = createHoldStrategy('lock', { db, holdSeconds: 300, logger: silent });
  const config = { NODE_ENV: 'test' as const, JWT_SECRET, JWT_EXPIRES_IN: 3600, RACE_DELAY_MS: 0 };
  app = createApp({
    config: { CORS_ORIGINS: [] },
    logger,
    routes: createRoutes({ db, config, holdStrategy: holds, payments }),
  });
});

beforeEach(async () => {
  openGate();
  Object.assign(provider, { charging: 0, gate: undefined, decline: false, loseResponse: false });
  client = clients.normal;
  logs.length = 0;
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
  openGate();
  await mock.close();
  await mockPool.query(`DROP SCHEMA IF EXISTS ${PAYMENTS_SCHEMA} CASCADE`);
  await mockPool.end();
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('a lost answer from the provider', () => {
  it('is retried inside the request with the same provider key: 200 and one charge', async () => {
    const holdId = await holdSeats();
    provider.loseResponse = true;

    await pay(holdId, 'tab-1').expect(200);

    expect(await charges()).toMatchObject([{ status: 'succeeded' }]);
    expect(await ticketCount()).toBe(2);
  });

  it('ends in 503 when no retry is left, and the same key then completes the order with that charge', async () => {
    // The plan's "done when": the provider charges, its answer is lost, the fan retries.
    const holdId = await holdSeats();
    client = clients.noRetries;
    provider.loseResponse = true;

    const first = await pay(holdId, 'tab-1').expect(503);
    expect(codeOf(first.body)).toBe('PAYMENT_UNAVAILABLE');
    expect(await orderOf(holdId)).toMatchObject({ status: 'paying' });
    expect(await charges()).toHaveLength(1);

    const retry = await pay(holdId, 'tab-1').expect(200);

    const order = await orderOf(holdId);
    expect(retry.body).toMatchObject({ orderId: order?.id, status: 'paid' });
    expect(order?.status).toBe('paid');
    expect(await charges()).toEqual([{ key: order?.payment_key, status: 'succeeded' }]);
    expect(await ticketCount()).toBe(2);
    expect(logs.map((line) => line.msg)).toContain('resuming a payment with the same key');
  });
});

describe('a provider slower than every attempt', () => {
  it('ends in 503 while it still charges, and the same key then gets that one charge back', async () => {
    const holdId = await holdSeats();

    await chargeTheFanNeverHeardAbout(holdId, 'tab-1');
    await pay(holdId, 'tab-1').expect(200);

    expect(await charges()).toMatchObject([{ status: 'succeeded' }]);
    expect((await orderOf(holdId))?.status).toBe('paid');
  });

  it('answers a decline the fan never heard about with 402 on the retry', async () => {
    const holdId = await holdSeats();
    provider.decline = true;

    await chargeTheFanNeverHeardAbout(holdId, 'tab-1');
    const retry = await pay(holdId, 'tab-1').expect(402);

    expect(codeOf(retry.body)).toBe('PAYMENT_DECLINED');
    expect(await orderOf(holdId)).toMatchObject({ status: 'pending', payment_key: null });
    expect(await charges()).toMatchObject([{ status: 'declined' }]);
  });

  it('refunds the charge if the seats were lost before the retry (FR-PAY-11)', async () => {
    const holdId = await holdSeats();
    await chargeTheFanNeverHeardAbout(holdId, 'tab-1');
    await db.pool.query(
      `UPDATE seats SET held_until = now() - interval '1 second' WHERE id = ANY($1::int[])`,
      [SEATS],
    );
    await holdSeats(RIVAL, [42]);

    const retry = await pay(holdId, 'tab-1').expect(409);

    expect(codeOf(retry.body)).toBe('SEAT_LOST_REFUNDED');
    expect((await orderOf(holdId))?.status).toBe('refunded');
    expect(await charges()).toMatchObject([{ status: 'refunded' }]);
  });
});

describe('a provider that is down (FR-PAY-12)', () => {
  it('answers 503 and leaves the order paying; once it is back, the same key pays once', async () => {
    const holdId = await holdSeats();
    client = clients.unreachable;

    const first = await pay(holdId, 'tab-1').expect(503);

    expect(codeOf(first.body)).toBe('PAYMENT_UNAVAILABLE');
    expect(await orderOf(holdId)).toMatchObject({ status: 'paying' });
    expect(await charges()).toEqual([]);

    client = clients.normal;
    await pay(holdId, 'tab-1').expect(200);
    expect(await charges()).toMatchObject([{ status: 'succeeded' }]);
  });

  it('refuses another key while the order is paying, without charging (FR-PAY-6)', async () => {
    const holdId = await holdSeats();
    client = clients.unreachable;
    await pay(holdId, 'tab-1').expect(503);
    client = clients.normal;

    const other = await pay(holdId, 'tab-2').expect(409);

    expect(codeOf(other.body)).toBe('PAYMENT_IN_PROGRESS');
    expect(await charges()).toEqual([]);
  });
});

describe('a retry while the first request is still running', () => {
  it('answers 409 REQUEST_IN_PROGRESS, and the first one finishes with the only charge', async () => {
    const holdId = await holdSeats();
    pauseProvider();
    // Long enough for the paused provider, so the first request is still waiting on it.
    client = createPaymentClient({
      baseUrl: mock.url,
      logger: createLogger('silent'),
      timeoutMs: 5_000,
    });
    const first = pay(holdId, 'tab-1').then((res) => res);
    await expect.poll(() => provider.charging).toBe(1);

    const meanwhile = await pay(holdId, 'tab-1').expect(409);
    openGate();

    expect(codeOf(meanwhile.body)).toBe('REQUEST_IN_PROGRESS');
    expect((await first).status).toBe(200);
    expect(await charges()).toHaveLength(1);
  });
});

describe('a server that crashed mid-payment', () => {
  // What a crash leaves behind: the key claimed, the order paying, and maybe a charge.
  async function crashAfterCharging(holdId: string, key: string, secondsAgo: number) {
    const reserved = await reserve(db, { holdId, userId: FAN, clientKey: key });
    if (reserved.kind !== 'charge') throw new Error('expected to charge');
    await fetch(`${mock.url}/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': reserved.paymentKey },
      body: JSON.stringify({ orderId: reserved.order.id, amountPaise: reserved.order.amountPaise }),
    });
    await db.pool.query(
      `INSERT INTO idempotency_keys (user_id, idem_key, request_hash, locked_at)
       VALUES ($1, $2, $3, now() - make_interval(secs => $4))`,
      [FAN, key, hashRequest('POST', `/holds/${holdId}/checkout`, undefined), secondsAgo],
    );
  }

  it('answers 409 until the key is a minute old, then completes the order with the one charge', async () => {
    const holdId = await holdSeats();
    await crashAfterCharging(holdId, 'tab-1', 59);

    await pay(holdId, 'tab-1').expect(409);
    await db.pool.query(`UPDATE idempotency_keys SET locked_at = now() - interval '61 seconds'`);
    const retry = await pay(holdId, 'tab-1').expect(200);

    expect(retry.body).toMatchObject({ status: 'paid' });
    expect(await charges()).toMatchObject([{ status: 'succeeded' }]);
    expect(await ticketCount()).toBe(2);
  });

  it('returns the paid order if it crashed after Confirm but before saving the answer', async () => {
    const holdId = await holdSeats();
    const paid = await pay(holdId, 'tab-1').expect(200);
    await db.pool.query(
      `UPDATE idempotency_keys
          SET status = 'in_progress', response_code = NULL, response_body = NULL,
              locked_at = now() - interval '61 seconds'`,
    );

    const retry = await pay(holdId, 'tab-1').expect(200);

    expect(retry.body).toEqual(paid.body);
    expect(await charges()).toHaveLength(1);
    expect(await ticketCount()).toBe(2);
  });
});
