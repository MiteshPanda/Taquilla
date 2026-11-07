import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedStadium } from '../src/seed.js';
import { paymentKey } from '../src/checkout/payment-client.js';
import { reserve, RESERVE_MINUTES } from '../src/checkout/reserve.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createHoldStrategy } from '../src/holds/strategies.js';
import type { HoldStrategy } from '../src/holds/strategy.js';
import { releaseHold } from '../src/holds/release.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'reserve_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const FAN = 1;
const RIVAL = 2;
// Lateral Este, 4,500 rupees each.
const SEATS = [41, 42];

const logger = createLogger('silent');

let db: Database;
let holds: HoldStrategy;

interface OrderRow {
  id: string;
  status: string;
  payment_key: string | null;
  amount_paise: number;
  user_id: number;
}

async function holdSeats(userId = FAN, seatIds = SEATS): Promise<string> {
  const { holdId } = await holds.hold({ userId, eventId: 1, seatIds });
  return holdId;
}

async function ordersFor(holdId: string): Promise<OrderRow[]> {
  const { rows } = await db.pool.query<OrderRow>(
    'SELECT id, status, payment_key, amount_paise, user_id FROM orders WHERE hold_id = $1',
    [holdId],
  );
  return rows;
}

// Seconds from now until each seat's hold runs out, by the database clock.
async function secondsLeft(seatIds = SEATS): Promise<number[]> {
  const { rows } = await db.pool.query<{ left: number }>(
    `SELECT extract(epoch FROM held_until - now())::float AS left
       FROM seats WHERE id = ANY($1::int[]) ORDER BY id`,
    [seatIds],
  );
  return rows.map((row) => row.left);
}

async function lapse(seatIds: number[]): Promise<void> {
  await db.pool.query(
    `UPDATE seats SET held_until = now() - interval '1 second' WHERE id = ANY($1::int[])`,
    [seatIds],
  );
}

async function setOrder(holdId: string, status: string, key: string | null): Promise<void> {
  await db.pool.query('UPDATE orders SET status = $2, payment_key = $3 WHERE hold_id = $1', [
    holdId,
    status,
    key,
  ]);
}

function expectError(code: string, extra: object = {}) {
  return expect.objectContaining({ code, ...extra }) as unknown;
}

// A pool of 20 connections opens lazily; opening them all first makes parallel calls overlap.
async function openAllConnections(): Promise<void> {
  await Promise.all(Array.from({ length: 20 }, () => db.pool.query('SELECT pg_sleep(0.05)')));
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
  await db.withTransaction((client) => seedStadium(client, 'not-a-real-hash'));
  holds = createHoldStrategy('lock', { db, holdSeconds: 300, logger });
});

beforeEach(async () => {
  await db.pool.query('DELETE FROM tickets');
  await db.pool.query('DELETE FROM orders');
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

describe('reserve: a valid hold', () => {
  it('creates the order and sets it paying under pay:{orderId}:{clientKey} (FR-PAY-2)', async () => {
    const holdId = await holdSeats();

    const outcome = await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });

    const [order] = await ordersFor(holdId);
    expect(order).toMatchObject({ status: 'paying', amount_paise: 900_000, user_id: FAN });
    expect(order?.payment_key).toBe(paymentKey(order?.id ?? '', 'tab-1'));
    expect(outcome).toMatchObject({
      kind: 'charge',
      resumed: false,
      paymentKey: order?.payment_key,
      order: { id: order?.id, holdId, status: 'paying', amountPaise: 900_000 },
    });
  });

  it(`extends its seats to ${RESERVE_MINUTES} minutes from now before any charge (FR-PAY-5)`, async () => {
    const holdId = await holdSeats();

    await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });

    for (const left of await secondsLeft()) {
      expect(left).toBeGreaterThan(RESERVE_MINUTES * 60 - 5);
      expect(left).toBeLessThanOrEqual(RESERVE_MINUTES * 60);
    }
  });

  it('never shortens a hold that has longer left', async () => {
    const holdId = await holdSeats();
    await db.pool.query(
      `UPDATE seats SET held_until = now() + interval '20 minutes' WHERE id = ANY($1::int[])`,
      [SEATS],
    );

    await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });

    for (const left of await secondsLeft()) expect(left).toBeGreaterThan(19 * 60);
  });

  it('answers 404 for another fan’s hold and for one that doesn’t exist', async () => {
    const holdId = await holdSeats();

    await expect(reserve(db, { holdId, userId: RIVAL, clientKey: 'k' })).rejects.toEqual(
      expectError('NOT_FOUND', { status: 404 }),
    );
    await expect(
      reserve(db, { holdId: randomUUID(), userId: FAN, clientKey: 'k' }),
    ).rejects.toEqual(expectError('NOT_FOUND'));
    expect(await ordersFor(holdId)).toEqual([]);
  });
});

describe('reserve: a hold that is no longer whole (FR-PAY-4)', () => {
  it('answers 409 HOLD_EXPIRED naming a seat another fan re-took, and writes nothing', async () => {
    const holdId = await holdSeats();
    await lapse([42]);
    const rivalHold = await holdSeats(RIVAL, [42]);
    const before = await secondsLeft([41]);

    await expect(reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' })).rejects.toEqual(
      expectError('HOLD_EXPIRED', { status: 409, details: { seatIds: [42] } }),
    );

    expect(await ordersFor(holdId)).toEqual([]);
    expect((await secondsLeft([41]))[0]).toBeLessThanOrEqual(before[0] ?? 0);
    const { rows } = await db.pool.query<{ hold_id: string }>(
      'SELECT hold_id FROM seats WHERE id = 42',
    );
    expect(rows[0]?.hold_id).toBe(rivalHold);
  });

  it('answers HOLD_EXPIRED for a lapsed hold, even before anyone takes its seats', async () => {
    const holdId = await holdSeats();
    await lapse(SEATS);

    await expect(reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' })).rejects.toEqual(
      expectError('HOLD_EXPIRED', { details: { seatIds: SEATS } }),
    );
    for (const left of await secondsLeft()) expect(left).toBeLessThan(0);
  });

  it('answers HOLD_EXPIRED for a hold the fan released', async () => {
    const holdId = await holdSeats();
    await releaseHold(db, { holdId, userId: FAN });

    await expect(reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' })).rejects.toEqual(
      expectError('HOLD_EXPIRED'),
    );
    expect(await ordersFor(holdId)).toEqual([]);
  });
});

describe('reserve: an order that already exists (FR-PAY-6)', () => {
  it('returns a paid order without charging or changing anything', async () => {
    const holdId = await holdSeats();
    await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });
    await setOrder(holdId, 'paid', 'pay:done');
    await db.pool.query(
      `UPDATE seats SET status = 'sold', hold_id = NULL, held_until = NULL WHERE id = ANY($1::int[])`,
      [SEATS],
    );
    await db.pool.query(`UPDATE holds SET status = 'converted' WHERE id = $1`, [holdId]);

    const outcome = await reserve(db, { holdId, userId: FAN, clientKey: 'tab-2' });

    expect(outcome).toMatchObject({
      kind: 'paid',
      order: { status: 'paid', paymentKey: 'pay:done' },
    });
    expect(await ordersFor(holdId)).toMatchObject([{ status: 'paid', payment_key: 'pay:done' }]);
  });

  it('answers 409 PAYMENT_IN_PROGRESS while another key is paying, and leaves it alone', async () => {
    const holdId = await holdSeats();
    const first = await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });

    await expect(reserve(db, { holdId, userId: FAN, clientKey: 'tab-2' })).rejects.toEqual(
      expectError('PAYMENT_IN_PROGRESS', { status: 409 }),
    );
    expect(await ordersFor(holdId)).toMatchObject([
      { status: 'paying', payment_key: first.kind === 'charge' ? first.paymentKey : '' },
    ]);
  });

  it('resumes at the Charge step for the same key while paying (FR-PAY-11)', async () => {
    const holdId = await holdSeats();
    const first = await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });

    const again = await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });

    expect(again).toMatchObject({ kind: 'charge', resumed: true });
    expect(again.kind === 'charge' && first.kind === 'charge' && again.paymentKey).toBe(
      first.kind === 'charge' && first.paymentKey,
    );
    expect(await ordersFor(holdId)).toHaveLength(1);
  });

  it('resumes even if seats were lost mid-payment, so the charge can be settled and refunded', async () => {
    const holdId = await holdSeats();
    await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });
    await lapse([42]);
    const rivalHold = await holdSeats(RIVAL, [42]);

    const again = await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });

    expect(again).toMatchObject({ kind: 'charge', resumed: true });
    const { rows } = await db.pool.query<{ hold_id: string }>(
      'SELECT hold_id FROM seats WHERE id = 42',
    );
    expect(rows[0]?.hold_id).toBe(rivalHold);
  });

  it('pays under a new key once a declined attempt has set the order back to pending', async () => {
    const holdId = await holdSeats();
    await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });
    await setOrder(holdId, 'pending', null);

    const retry = await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1-retry' });

    const [order] = await ordersFor(holdId);
    expect(retry).toMatchObject({ kind: 'charge', resumed: false });
    expect(order).toMatchObject({
      status: 'paying',
      payment_key: paymentKey(order?.id ?? '', 'tab-1-retry'),
    });
  });

  it('answers 409 SEAT_LOST_REFUNDED for an order that was refunded', async () => {
    const holdId = await holdSeats();
    await reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });
    await setOrder(holdId, 'refunded', 'pay:refunded');

    await expect(reserve(db, { holdId, userId: FAN, clientKey: 'tab-2' })).rejects.toEqual(
      expectError('SEAT_LOST_REFUNDED', { status: 409 }),
    );
  });
});

describe('reserve: at the same time', () => {
  it('gives 20 tabs paying with 20 keys at once one order, and lets one of them charge', async () => {
    const holdId = await holdSeats();
    await openAllConnections();

    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, (_, tab) =>
        reserve(db, { holdId, userId: FAN, clientKey: `tab-${tab}` }),
      ),
    );

    const charging = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(charging).toHaveLength(1);
    expect(charging[0]?.value).toMatchObject({ kind: 'charge', resumed: false });
    for (const outcome of refused) {
      expect(outcome.reason).toEqual(expectError('PAYMENT_IN_PROGRESS'));
    }
    expect(await ordersFor(holdId)).toHaveLength(1);
  });

  it('waits for a rival that has a seat locked, then sees it was taken', async () => {
    // The moment a hold lapses, a rival can lock its seat and take it. Reserve must wait for that
    // lock and judge the seat as the rival left it, never as it looked before.
    const holdId = await holdSeats();
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise)
       VALUES ($1, 1, '{42}', 450000) RETURNING id`,
      [RIVAL],
    );
    const rival = await db.pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query('SELECT 1 FROM seats WHERE id = 42 FOR UPDATE');

      let settled = false;
      const pending = reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' }).finally(() => {
        settled = true;
      });
      pending.catch(() => undefined);
      await sleep(300);
      expect(settled).toBe(false);

      await rival.query(
        `UPDATE seats SET hold_id = $1, held_until = now() + interval '5 minutes' WHERE id = 42`,
        [rows[0]?.id],
      );
      await rival.query('COMMIT');

      await expect(pending).rejects.toEqual(
        expectError('HOLD_EXPIRED', { details: { seatIds: [42] } }),
      );
      expect(await ordersFor(holdId)).toEqual([]);
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined);
      rival.release();
    }
  });

  it('locks seats in ascending order, holding none while it waits for the first (ADR 3)', async () => {
    const holdId = await holdSeats();
    const rival = await db.pool.connect();
    try {
      await rival.query('BEGIN');
      await rival.query(`SET LOCAL lock_timeout = '500ms'`);
      await rival.query('SELECT 1 FROM seats WHERE id = 41 FOR UPDATE');

      const pending = reserve(db, { holdId, userId: FAN, clientKey: 'tab-1' });
      pending.catch(() => undefined);
      await sleep(300);
      // Reserve is now queued for seat 41. Had it locked seat 42 first, this would wait for
      // Reserve while Reserve waits for this transaction: a deadlock, cut short by lock_timeout.
      await rival.query('SELECT 1 FROM seats WHERE id = 42 FOR UPDATE');
      await rival.query('COMMIT');

      await expect(pending).resolves.toMatchObject({ kind: 'charge' });
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined);
      rival.release();
    }
  });
});
