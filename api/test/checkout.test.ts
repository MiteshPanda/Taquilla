import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'pg';
import request from 'supertest';
import type { Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Faults } from '../../payments-mock/src/faults.js';
import { createTestSchema, startMock } from '../../payments-mock/test/helpers/mock.js';
import type { RunningMock } from '../../payments-mock/test/helpers/mock.js';
import { seedStadium } from '../../scripts/seed.js';
import { createApp } from '../src/app.js';
import { signToken } from '../src/auth/tokens.js';
import { createPaymentClient } from '../src/checkout/payment-client.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import { REPLAYED_HEADER } from '../src/idempotency/middleware.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { createRoutes } from '../src/routes.js';
import { schemaConnectionString } from './helpers/database.js';

// The six checkout acceptance cases of requirements.md §9.1, through the real API, the real
// payment client with its production timeout and retries, and the real payment mock.
const SCHEMA = 'checkout_probe';
const PAYMENTS_SCHEMA = 'checkout_payments';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const JWT_SECRET = 'checkout-acceptance-secret-at-least-32-chars';
const FAN = 1;
const RIVAL = 2;
const SEATS = [41, 42];

let db: Database;
let mockPool: Pool;
let mock: RunningMock;
let app: ReturnType<typeof createApp>;
const logs: { msg: string }[] = [];

// The provider's behaviour, set per case. delay() runs only on a key's first attempt.
const provider = {
  charging: 0,
  gate: undefined as Promise<void> | undefined,
  decline: false,
  loseResponse: false,
};
let openGate: () => void = () => {};
const faults: Faults = {
  async delay() {
    provider.charging += 1;
    if (provider.gate) await provider.gate;
  },
  decline: () => provider.decline,
  loseResponse: () => provider.loseResponse,
};

function pauseProvider(): void {
  provider.gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
}

function tokenFor(userId: number): string {
  return `Bearer ${signToken(userId, JWT_SECRET, 3600)}`;
}

function pay(holdId: string, key: string, body?: object): Promise<Response> {
  const req = request(app)
    .post(`/holds/${holdId}/checkout`)
    .set('Authorization', tokenFor(FAN))
    .set('Idempotency-Key', key);
  return (body === undefined ? req : req.send(body)).then((res) => res);
}

// What a client does with 409 REQUEST_IN_PROGRESS: wait a moment and send the same request with
// the same key, until the first one's answer is saved (FR-WEB-3).
let inProgressAnswers = 0;
async function payUntilSettled(holdId: string, key: string): Promise<Response> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const res = await pay(holdId, key);
    if (res.status !== 409 || codeOf(res.body) !== 'REQUEST_IN_PROGRESS') return res;
    inProgressAnswers += 1;
    await sleep(25);
  }
  throw new Error('The first request never finished.');
}

async function holdSeats(userId = FAN, seatIds = SEATS): Promise<string> {
  const res = await request(app)
    .post('/events/1/holds')
    .set('Authorization', tokenFor(userId))
    .send({ seatIds })
    .expect(201);
  return (res.body as { holdId: string }).holdId;
}

async function chargeStatuses(): Promise<string[]> {
  const { rows } = await mockPool.query<{ status: string }>(
    'SELECT status FROM charges ORDER BY created_at',
  );
  return rows.map((row) => row.status);
}

async function orderOf(holdId: string) {
  const { rows } = await db.pool.query<{ status: string }>(
    'SELECT status FROM orders WHERE hold_id = $1',
    [holdId],
  );
  return rows[0];
}

function codeOf(body: unknown): unknown {
  return (body as { error?: { code?: string } }).error?.code;
}

beforeAll(async () => {
  const silent = createLogger('silent');
  db = createDatabase({ connectionString: CONNECTION_STRING, logger: silent });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger: silent, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));

  mockPool = await createTestSchema(PAYMENTS_SCHEMA);
  mock = await startMock(mockPool, faults);

  const logger = createLogger('info', {
    write: (line: string) => logs.push(JSON.parse(line) as { msg: string }),
  });
  const config = { NODE_ENV: 'test' as const, JWT_SECRET, JWT_EXPIRES_IN: 3600, RACE_DELAY_MS: 0 };
  app = createApp({
    config: { CORS_ORIGINS: [] },
    logger,
    routes: createRoutes({
      db,
      config,
      holdStrategy: createHoldStrategy('lock', { db, holdSeconds: 300, logger: silent }),
      payments: createPaymentClient({ baseUrl: mock.url, logger }),
    }),
  });
});

beforeEach(async () => {
  openGate();
  Object.assign(provider, { charging: 0, gate: undefined, decline: false, loseResponse: false });
  inProgressAnswers = 0;
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

describe('checkout acceptance (requirements.md §9.1)', () => {
  it('case 1: the same key sent twice in parallel makes one charge, and both end with the same answer', async () => {
    const holdId = await holdSeats();
    pauseProvider();

    // Both go out at once. One claims the key and waits on the provider; the other is told
    // 409 REQUEST_IN_PROGRESS and retries with the same key until the answer is saved.
    const both = Promise.all([payUntilSettled(holdId, 'tab-1'), payUntilSettled(holdId, 'tab-1')]);
    await expect.poll(() => provider.charging).toBe(1);
    await expect.poll(() => inProgressAnswers).toBeGreaterThan(0);
    openGate();
    const [first, second] = await both;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const replayed = [first, second].filter(
      (res) => res.headers[REPLAYED_HEADER.toLowerCase()] === 'true',
    );
    expect(replayed).toHaveLength(1);
    expect(await chargeStatuses()).toEqual(['succeeded']);
  });

  it('case 2: the provider loses the response and the client retries: still one charge', async () => {
    const holdId = await holdSeats();
    provider.loseResponse = true;

    const res = await pay(holdId, 'tab-1');

    expect(res.status).toBe(200);
    expect(logs.map((line) => line.msg)).toContain(
      'payment provider call failed, retrying with the same key',
    );
    expect(await chargeStatuses()).toEqual(['succeeded']);
  });

  it('case 3: the same key with a different body, or for another hold, returns 422', async () => {
    const holdId = await holdSeats();
    const otherHold = await holdSeats(FAN, [43]);
    await pay(holdId, 'tab-1').then((res) => expect(res.status).toBe(200));

    const otherBody = await pay(holdId, 'tab-1', { note: 'a different body' });
    const otherPath = await pay(otherHold, 'tab-1');

    for (const res of [otherBody, otherPath]) {
      expect(res.status).toBe(422);
      expect(codeOf(res.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    expect(await chargeStatuses()).toEqual(['succeeded']);
    expect(await orderOf(otherHold)).toBeUndefined();
  });

  it('case 4: two tabs with two keys on one hold: one 200, one 409, one charge', async () => {
    const holdId = await holdSeats();
    pauseProvider();

    const firstTab = pay(holdId, 'tab-1');
    await expect.poll(() => provider.charging).toBe(1);
    const secondTab = await pay(holdId, 'tab-2');
    openGate();

    expect((await firstTab).status).toBe(200);
    expect(secondTab.status).toBe(409);
    expect(codeOf(secondTab.body)).toBe('PAYMENT_IN_PROGRESS');
    expect(await chargeStatuses()).toEqual(['succeeded']);
  });

  it('case 5: a decline returns 402; a retry with a new key can succeed', async () => {
    const holdId = await holdSeats();
    provider.decline = true;

    const declined = await pay(holdId, 'attempt-1');
    provider.decline = false;
    const retry = await pay(holdId, 'attempt-2');

    expect(declined.status).toBe(402);
    expect(codeOf(declined.body)).toBe('PAYMENT_DECLINED');
    expect(retry.status).toBe(200);
    expect((retry.body as { status: string }).status).toBe('paid');
    expect(await chargeStatuses()).toEqual(['declined', 'succeeded']);
  });

  it('case 6: the hold expires and another fan takes the seat: 409, no charge', async () => {
    const holdId = await holdSeats();
    await db.pool.query(
      `UPDATE seats SET held_until = now() - interval '1 second' WHERE id = ANY($1::int[])`,
      [SEATS],
    );
    await holdSeats(RIVAL, [42]);

    const res = await pay(holdId, 'tab-1');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'HOLD_EXPIRED', seatIds: [41, 42] } });
    expect(await chargeStatuses()).toEqual([]);
    expect(await orderOf(holdId)).toBeUndefined();
  });
});
