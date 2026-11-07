import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { startEmbeddedPayments } from '../src/embedded.js';
import type { EmbeddedPayments } from '../src/embedded.js';
import { logger, TEST_DATABASE_URL } from './helpers/mock.js';

const SCHEMA = 'embedded_payments_probe';
// No faults, so every first attempt is charged at once.
const ENV = {
  DECLINE_RATE: '0',
  LOST_RESPONSE_RATE: '0',
  LATENCY_MIN_MS: '0',
  LATENCY_MAX_MS: '0',
};

let pool: Pool;
let mock: EmbeddedPayments;

function charge(key: string, orderId: string) {
  return fetch(`${mock.url}/charges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ orderId, amountPaise: 450_000 }),
  });
}

beforeAll(async () => {
  pool = createPool({ connectionString: TEST_DATABASE_URL, logger });
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  mock = await startEmbeddedPayments({
    connectionString: TEST_DATABASE_URL,
    logger,
    env: ENV,
    schema: SCHEMA,
  });
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await pool.end();
});

describe('the payment mock in another process (WP 8.4)', () => {
  it('creates its schema, then listens on this machine only', async () => {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM ${SCHEMA}.schema_migrations`,
    );

    expect(rows.map((row) => row.name)).toEqual(['001_charges.sql']);
    expect(mock.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${mock.url}/health`)).status).toBe(200);
  });

  it('charges once per key, as the standalone mock does', async () => {
    const orderId = '11111111-2222-4333-8444-555555555555';
    const first = await charge('embedded-key-1', orderId);
    const again = await charge('embedded-key-1', orderId);

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${SCHEMA}.charges WHERE order_id = $1`,
      [orderId],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('refuses a bad fault setting, naming it', async () => {
    await expect(
      startEmbeddedPayments({
        connectionString: TEST_DATABASE_URL,
        logger,
        env: { DECLINE_RATE: '2' },
        schema: SCHEMA,
      }),
    ).rejects.toThrow(/DECLINE_RATE/);
  });

  it('stops listening once closed', async () => {
    await mock.close();

    await expect(fetch(`${mock.url}/health`)).rejects.toThrow();
  });
});
