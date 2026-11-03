import type { QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'schema_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

const logger = createLogger('silent');

let db: Database;
let fanId: number;
let eventId: number;
let seatId: number;
let holdId: string;

function run<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return db.pool.query<T>(sql, params);
}

async function firstRow<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<T> {
  const { rows } = await run<T>(sql, params);
  if (rows[0] === undefined) {
    throw new Error(`No row returned by: ${sql}`);
  }
  return rows[0];
}

async function expectRejected(
  write: Promise<unknown>,
  code: string,
  constraint: string,
): Promise<void> {
  await expect(write).rejects.toMatchObject({ code, constraint });
}

async function insertHold(): Promise<string> {
  const { id } = await firstRow<{ id: string }>(
    `INSERT INTO holds (user_id, event_id, seat_ids, amount_paise)
     VALUES ($1, $2, $3, 450000) RETURNING id`,
    [fanId, eventId, [seatId]],
  );
  return id;
}

async function insertOrder(forHold = holdId): Promise<string> {
  const { id } = await firstRow<{ id: string }>(
    'INSERT INTO orders (hold_id, user_id, amount_paise) VALUES ($1, $2, 450000) RETURNING id',
    [forHold, fanId],
  );
  return id;
}

function insertTicket(orderId: string, status = 'valid'): Promise<QueryResult> {
  return run('INSERT INTO tickets (order_id, seat_id, status) VALUES ($1, $2, $3)', [
    orderId,
    seatId,
    status,
  ]);
}

beforeAll(async () => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
  await run(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await run(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
});

beforeEach(async () => {
  await run('TRUNCATE users, events CASCADE');
  ({ id: fanId } = await firstRow<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ('fan@taquilla.test', 'hash') RETURNING id`,
    [],
  ));
  ({ id: eventId } = await firstRow<{ id: number }>(
    `INSERT INTO events (name, starts_at) VALUES ('Match', now()) RETURNING id`,
    [],
  ));
  ({ id: seatId } = await firstRow<{ id: number }>(
    `INSERT INTO seats (event_id, section, row_label, seat_no, price_paise)
     VALUES ($1, 'Lateral Este', 'A', 1, 450000) RETURNING id`,
    [eventId],
  ));
  holdId = await insertHold();
});

afterAll(async () => {
  await run(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('seat state (DR-2)', () => {
  function setSeat(status: string, withHold: boolean, withExpiry: boolean): Promise<QueryResult> {
    return run(
      `UPDATE seats
          SET status = $2,
              hold_id = $3::uuid,
              held_until = CASE WHEN $4::boolean THEN now() END
        WHERE id = $1`,
      [seatId, status, withHold ? holdId : null, withExpiry],
    );
  }

  it.each([
    ['held', true, true],
    ['available', false, false],
    ['sold', false, false],
  ])('allows %s with hold_id=%s and held_until=%s', async (status, withHold, withExpiry) => {
    await expect(setSeat(status, withHold, withExpiry)).resolves.toMatchObject({ rowCount: 1 });
  });

  it.each([
    ['held', false, false],
    ['held', false, true],
    ['held', true, false],
    ['available', true, true],
    ['available', true, false],
    ['available', false, true],
    ['sold', true, true],
    ['sold', true, false],
    ['sold', false, true],
  ])('rejects %s with hold_id=%s and held_until=%s', async (status, withHold, withExpiry) => {
    await expectRejected(
      setSeat(status, withHold, withExpiry),
      CHECK_VIOLATION,
      'seats_hold_state',
    );
  });

  it('rejects a hold_id that points at no hold', async () => {
    await expectRejected(
      run(
        `UPDATE seats SET status = 'held', hold_id = gen_random_uuid(), held_until = now()
          WHERE id = $1`,
        [seatId],
      ),
      FOREIGN_KEY_VIOLATION,
      'seats_hold_id_fkey',
    );
  });

  it('rejects the same seat position twice in one event', async () => {
    await expectRejected(
      run(
        `INSERT INTO seats (event_id, section, row_label, seat_no, price_paise)
         VALUES ($1, 'Lateral Este', 'A', 1, 450000)`,
        [eventId],
      ),
      UNIQUE_VIOLATION,
      'seats_event_id_section_row_label_seat_no_key',
    );
  });
});

describe('one valid ticket per seat (DR-3)', () => {
  it('rejects a second valid ticket for a seat', async () => {
    const orderId = await insertOrder();
    await insertTicket(orderId);

    await expectRejected(insertTicket(orderId), UNIQUE_VIOLATION, 'one_valid_ticket_per_seat');
  });

  it('rejects it across different orders too', async () => {
    await insertTicket(await insertOrder());
    const otherOrderId = await insertOrder(await insertHold());

    await expectRejected(insertTicket(otherOrderId), UNIQUE_VIOLATION, 'one_valid_ticket_per_seat');
  });

  it('lets exactly one of many parallel inserts win', async () => {
    const orderId = await insertOrder();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => insertTicket(orderId)),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const { reason } of rejected) {
      expect(reason).toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: 'one_valid_ticket_per_seat',
      });
    }
  });

  it('ignores cancelled tickets, so a seat can be sold again after one', async () => {
    const orderId = await insertOrder();
    await insertTicket(orderId, 'cancelled');
    await insertTicket(orderId, 'cancelled');

    await expect(insertTicket(orderId)).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe('orders (DR-4)', () => {
  it('rejects a second order for one hold', async () => {
    await insertOrder();

    await expectRejected(insertOrder(), UNIQUE_VIOLATION, 'orders_hold_id_key');
  });

  it('rejects a paying order with no payment key', async () => {
    const orderId = await insertOrder();

    await expectRejected(
      run(`UPDATE orders SET status = 'paying' WHERE id = $1`, [orderId]),
      CHECK_VIOLATION,
      'orders_paying_has_key',
    );
  });

  it('allows a paying order with a payment key', async () => {
    const orderId = await insertOrder();

    await expect(
      run(`UPDATE orders SET status = 'paying', payment_key = 'key' WHERE id = $1`, [orderId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe('holds (DR-5)', () => {
  function insertHoldWith(seatIds: number[], amountPaise: number): Promise<QueryResult> {
    return run(
      'INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES ($1, $2, $3, $4)',
      [fanId, eventId, seatIds, amountPaise],
    );
  }

  it.each([
    ['no seats', []],
    ['seven seats', [1, 2, 3, 4, 5, 6, 7]],
  ])('rejects a hold of %s', async (_name, seatIds) => {
    await expectRejected(insertHoldWith(seatIds, 450000), CHECK_VIOLATION, 'holds_seat_count');
  });

  it('allows a hold of six seats', async () => {
    await expect(insertHoldWith([1, 2, 3, 4, 5, 6], 450000)).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it('rejects a hold with no seat_ids or amount', async () => {
    await expect(
      run('INSERT INTO holds (user_id, event_id, amount_paise) VALUES ($1, $2, 1)', [
        fanId,
        eventId,
      ]),
    ).rejects.toMatchObject({ code: '23502', column: 'seat_ids' });
    await expect(
      run('INSERT INTO holds (user_id, event_id, seat_ids) VALUES ($1, $2, $3)', [
        fanId,
        eventId,
        [seatId],
      ]),
    ).rejects.toMatchObject({ code: '23502', column: 'amount_paise' });
  });
});

describe('column types and defaults (DR-6 to DR-8)', () => {
  async function columns(pattern: string): Promise<{ column: string; dataType: string }[]> {
    const { rows } = await run<{ column: string; dataType: string }>(
      `SELECT table_name || '.' || column_name AS column, data_type AS "dataType"
         FROM information_schema.columns
        WHERE table_schema = $1 AND column_name ~ $2`,
      [SCHEMA, pattern],
    );
    return rows;
  }

  it('stores every timestamp as TIMESTAMPTZ', async () => {
    const found = await columns('(_at|_until)$');

    expect(found.map(({ column }) => column)).toEqual(
      expect.arrayContaining([
        'events.starts_at',
        'holds.created_at',
        'seats.held_until',
        'orders.created_at',
        'idempotency_keys.locked_at',
      ]),
    );
    expect(new Set(found.map(({ dataType }) => dataType))).toEqual(
      new Set(['timestamp with time zone']),
    );
  });

  it('stores all money as integer paise', async () => {
    const found = await columns('paise$');

    expect(found.map(({ column }) => column).sort()).toEqual([
      'holds.amount_paise',
      'orders.amount_paise',
      'seats.price_paise',
    ]);
    expect(new Set(found.map(({ dataType }) => dataType))).toEqual(new Set(['integer']));
  });

  it('generates a UUID for holds and orders', async () => {
    const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

    expect(holdId).toMatch(uuid);
    expect(await insertOrder()).toMatch(uuid);
  });

  it.each([
    [
      'a seat with a price of zero',
      () =>
        run(
          `INSERT INTO seats (event_id, section, row_label, seat_no, price_paise)
           VALUES ($1, 'Fondo Sur', 'A', 1, 0)`,
          [eventId],
        ),
      'seats_price_paise_check',
    ],
    [
      'a hold with an amount of zero',
      () =>
        run(
          'INSERT INTO holds (user_id, event_id, seat_ids, amount_paise) VALUES ($1, $2, $3, 0)',
          [fanId, eventId, [seatId]],
        ),
      'holds_amount_positive',
    ],
    [
      'an order with an amount of zero',
      () =>
        run('INSERT INTO orders (hold_id, user_id, amount_paise) VALUES ($1, $2, 0)', [
          holdId,
          fanId,
        ]),
      'orders_amount_positive',
    ],
  ])('rejects %s', async (_name, write, constraint) => {
    await expectRejected(write(), CHECK_VIOLATION, constraint);
  });

  it.each([
    ['seats', `UPDATE seats SET status = 'gone'`, 'seats_status_check'],
    ['holds', `UPDATE holds SET status = 'gone'`, 'holds_status_check'],
  ])('rejects an unknown status on %s', async (_name, sql, constraint) => {
    await expectRejected(run(sql), CHECK_VIOLATION, constraint);
  });

  it('rejects an unknown status on orders and tickets', async () => {
    const orderId = await insertOrder();

    await expectRejected(
      run(`UPDATE orders SET status = 'gone' WHERE id = $1`, [orderId]),
      CHECK_VIOLATION,
      'orders_status_check',
    );
    await expectRejected(insertTicket(orderId, 'gone'), CHECK_VIOLATION, 'tickets_status_check');
  });
});

describe('users', () => {
  it('rejects a second account for one email', async () => {
    await expectRejected(
      run(`INSERT INTO users (email, password_hash) VALUES ('fan@taquilla.test', 'hash')`),
      UNIQUE_VIOLATION,
      'users_email_key',
    );
  });
});

describe('users (lowercase emails)', () => {
  it('rejects an email with capital letters, so the unique index stays case-blind', async () => {
    await expectRejected(
      run(`INSERT INTO users (email, password_hash) VALUES ('Fan2@taquilla.test', 'hash')`),
      CHECK_VIOLATION,
      'users_email_lowercase',
    );
  });
});

describe('idempotency keys', () => {
  function insertKey(userId: number): Promise<QueryResult> {
    return run(
      `INSERT INTO idempotency_keys (user_id, idem_key, request_hash) VALUES ($1, 'key', 'hash')`,
      [userId],
    );
  }

  it('makes a key unique per fan, so two fans can use the same one', async () => {
    const { id: otherFanId } = await firstRow<{ id: number }>(
      `INSERT INTO users (email, password_hash) VALUES ('other@taquilla.test', 'hash') RETURNING id`,
      [],
    );
    await insertKey(fanId);

    await expectRejected(insertKey(fanId), UNIQUE_VIOLATION, 'idempotency_keys_pkey');
    await expect(insertKey(otherFanId)).resolves.toMatchObject({ rowCount: 1 });
  });

  it('rejects a finished key with no saved response', async () => {
    await insertKey(fanId);

    await expectRejected(
      run(`UPDATE idempotency_keys SET status = 'done'`),
      CHECK_VIOLATION,
      'idempotency_done_has_response',
    );
  });

  it('allows a finished key with a saved response', async () => {
    await insertKey(fanId);

    await expect(
      run(
        `UPDATE idempotency_keys
            SET status = 'done', response_code = 201, response_body = '{"holdId":"x"}'`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
