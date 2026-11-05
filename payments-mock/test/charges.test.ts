import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Charge } from '../src/charges.js';
import { createPool } from '../src/db.js';
import {
  countCharges,
  createTestSchema,
  DOWN_DATABASE_URL,
  faultsOf,
  logger,
  postCharge,
  postRefund,
  startMock,
} from './helpers/mock.js';
import type { RunningMock } from './helpers/mock.js';

// Every fault is off here, so each answer is exact (the plan's "faults switched off").
const SCHEMA = 'mock_charges';

let pool: Pool;
let mock: RunningMock;

// The key shape Taquilla's checkout will send (FR-PAY-7): pay:{orderId}:{clientKey}.
function paymentKey(orderId = randomUUID()): string {
  return `pay:${orderId}:${randomUUID()}`;
}

function newCharge(orderId = randomUUID(), amountPaise = 150_000) {
  return { orderId, amountPaise };
}

function errorCode(body: unknown): unknown {
  return (body as { error: { code: string } }).error.code;
}

beforeAll(async () => {
  pool = await createTestSchema(SCHEMA);
  mock = await startMock(pool, faultsOf({}));
});

beforeEach(async () => {
  await pool.query('TRUNCATE charges');
});

afterAll(async () => {
  await mock.close();
  await pool.end();
});

describe('GET /health', () => {
  it('answers 200 and echoes a safe request ID', async () => {
    const response = await fetch(`${mock.url}/health`, { headers: { 'X-Request-Id': 'api-42' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('X-Request-Id')).toBe('api-42');
  });

  it('answers an unknown route with a JSON 404', async () => {
    const response = await fetch(`${mock.url}/nowhere`);

    expect(response.status).toBe(404);
    expect(errorCode(await response.json())).toBe('NOT_FOUND');
  });
});

describe('POST /charges', () => {
  it('records a new charge and answers 201 with it', async () => {
    const key = paymentKey();
    const body = newCharge();

    const reply = await postCharge(mock, key, body);

    expect(reply.status).toBe(201);
    expect(reply.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      key,
      orderId: body.orderId,
      amountPaise: 150_000,
      status: 'succeeded',
      createdAt: expect.any(String) as unknown,
      refundedAt: null,
    });
    expect(await countCharges(pool)).toBe(1);
  });

  it('returns the original charge for a repeated key, without charging again (FR-MOCK-2)', async () => {
    const key = paymentKey();
    const body = newCharge();
    const first = await postCharge(mock, key, body);

    const second = await postCharge(mock, key, body);
    const third = await postCharge(mock, key, body);

    expect(second).toEqual({ status: 200, body: first.body });
    expect(third).toEqual({ status: 200, body: first.body });
    expect(await countCharges(pool)).toBe(1);
  });

  it('gives 20 simultaneous first attempts with one key one charge between them', async () => {
    // Each attempt waits 200 ms before it records anything, so they all see a new key and
    // reach the INSERT together instead of the later ones finding the first one's charge.
    const waits: number[] = [];
    const slow = await startMock(
      pool,
      faultsOf(
        { latencyMinMs: 200, latencyMaxMs: 200 },
        {
          sleep: (ms) => {
            waits.push(ms);
            return wait(ms);
          },
        },
      ),
    );
    const key = paymentKey();
    const body = newCharge();

    try {
      const replies = await Promise.all(
        Array.from({ length: 20 }, () => postCharge(slow, key, body)),
      );

      expect(waits.length).toBeGreaterThan(1);
      expect(replies.filter((reply) => reply.status === 201)).toHaveLength(1);
      expect(replies.filter((reply) => reply.status === 200)).toHaveLength(19);
      expect(new Set(replies.map((reply) => (reply.body as Charge).id)).size).toBe(1);
      expect(await countCharges(pool)).toBe(1);
    } finally {
      await slow.close();
    }
  });

  it('charges one order twice when given two keys: it never deduplicates by order (FR-MOCK-3)', async () => {
    const orderId = randomUUID();

    const first = await postCharge(mock, paymentKey(orderId), newCharge(orderId));
    const second = await postCharge(mock, paymentKey(orderId), newCharge(orderId));

    expect([first.status, second.status]).toEqual([201, 201]);
    expect((first.body as Charge).id).not.toBe((second.body as Charge).id);
    expect(await countCharges(pool, 'order_id = $1 AND status = $2', [orderId, 'succeeded'])).toBe(
      2,
    );
  });

  it.each([
    ['a different amount', { amountPaise: 99_000 }],
    ['a different order', { orderId: randomUUID() }],
  ])('refuses a repeated key with %s (422)', async (_name, change) => {
    const key = paymentKey();
    const body = newCharge();
    const original = await postCharge(mock, key, body);

    const reply = await postCharge(mock, key, { ...body, ...change });

    expect(reply.status).toBe(422);
    expect(errorCode(reply.body)).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await postCharge(mock, key, body)).toEqual({ status: 200, body: original.body });
    expect(await countCharges(pool)).toBe(1);
  });

  it('accepts a key of 255 visible characters', async () => {
    const reply = await postCharge(mock, '~'.repeat(255), newCharge());

    expect(reply.status).toBe(201);
  });

  it.each([
    ['is missing', undefined],
    ['is too long', 'k'.repeat(256)],
    ['has a space', 'pay: 1'],
  ])('answers 400 when the Idempotency-Key header %s', async (_name, key) => {
    const reply = await postCharge(mock, key, newCharge());

    expect(reply.status).toBe(400);
    expect(errorCode(reply.body)).toBe('VALIDATION_FAILED');
    expect(await countCharges(pool)).toBe(0);
  });

  it.each([
    ['no orderId', { amountPaise: 100 }],
    ['an orderId that is not a UUID', { orderId: '42', amountPaise: 100 }],
    ['no amount', { orderId: randomUUID() }],
    ['a zero amount', { orderId: randomUUID(), amountPaise: 0 }],
    ['a fractional amount', { orderId: randomUUID(), amountPaise: 1.5 }],
    ['an amount as a string', { orderId: randomUUID(), amountPaise: '100' }],
    ['an amount too large for the column', { orderId: randomUUID(), amountPaise: 2 ** 31 }],
    ['an extra field', { orderId: randomUUID(), amountPaise: 100, currency: 'INR' }],
    ['a body that is not an object', [1, 2]],
    ['a body that is not JSON', '{"orderId":'],
  ])('answers 400 for %s', async (_name, body) => {
    const reply = await postCharge(mock, paymentKey(), body);

    expect(reply.status).toBe(400);
    expect(errorCode(reply.body)).toBe('VALIDATION_FAILED');
    expect(await countCharges(pool)).toBe(0);
  });

  it('answers 500 when the database is down, so the client retries', async () => {
    const downPool = createPool({ connectionString: DOWN_DATABASE_URL, logger });
    const down = await startMock(downPool, faultsOf({}));

    try {
      const reply = await postCharge(down, paymentKey(), newCharge());

      expect(reply.status).toBe(500);
      expect(errorCode(reply.body)).toBe('INTERNAL_ERROR');
    } finally {
      await down.close();
      await downPool.end();
    }
  });
});

describe('POST /charges/:key/refund', () => {
  async function chargeFor(key: string): Promise<Charge> {
    return (await postCharge(mock, key, newCharge())).body as Charge;
  }

  it('marks a succeeded charge refunded', async () => {
    const key = paymentKey();
    const charge = await chargeFor(key);

    const reply = await postRefund(mock, key);

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      ...charge,
      status: 'refunded',
      refundedAt: expect.any(String) as unknown,
    });
    expect(await countCharges(pool, `key = $1 AND status = 'refunded'`, [key])).toBe(1);
  });

  it('is safe to call twice: the second call returns the same refund (FR-MOCK-4)', async () => {
    const key = paymentKey();
    await chargeFor(key);
    const first = await postRefund(mock, key);

    const second = await postRefund(mock, key);

    expect(second).toEqual(first);
  });

  it('gives 10 simultaneous refunds of one charge one refund time between them', async () => {
    const key = paymentKey();
    await chargeFor(key);

    const replies = await Promise.all(Array.from({ length: 10 }, () => postRefund(mock, key)));

    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(new Set(replies.map((reply) => (reply.body as Charge).refundedAt)).size).toBe(1);
  });

  it('returns a refunded charge, not a new one, when its key is charged again', async () => {
    const key = paymentKey();
    const body = newCharge();
    await postCharge(mock, key, body);
    const refund = await postRefund(mock, key);

    const reply = await postCharge(mock, key, body);

    expect(reply).toEqual({ status: 200, body: refund.body });
    expect(await countCharges(pool)).toBe(1);
  });

  it('answers 409 for a declined charge, which has nothing to refund', async () => {
    const key = paymentKey();
    await pool.query(
      `INSERT INTO charges (key, order_id, amount_paise, status) VALUES ($1, $2, 100, 'declined')`,
      [key, randomUUID()],
    );

    const reply = await postRefund(mock, key);

    expect(reply.status).toBe(409);
    expect(errorCode(reply.body)).toBe('CHARGE_DECLINED');
    expect(await countCharges(pool, `status = 'declined'`)).toBe(1);
  });

  it.each([
    ['a key with no charge', 'pay:nothing-here'],
    ['a key no charge could have', 'k'.repeat(256)],
  ])('answers 404 for %s', async (_name, key) => {
    const reply = await postRefund(mock, key);

    expect(reply.status).toBe(404);
    expect(errorCode(reply.body)).toBe('NOT_FOUND');
  });
});
