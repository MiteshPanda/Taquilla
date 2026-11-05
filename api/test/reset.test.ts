import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSafeToReset, resetDatabase } from '../../scripts/reset.js';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { TEST_DATABASE_URL } from './helpers/database.js';

// A database of its own, because a reset drops everything in the one it is pointed at.
const PROBE_DATABASE = 'taquilla_reset_probe';
const PROBE_URL = TEST_DATABASE_URL.replace(/taquilla_test$/, PROBE_DATABASE);
const SEED_PASSWORD = 'seed-password-for-tests';

const logger = createLogger('silent');

let db: Database;

async function admin(sql: string): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function reset(nodeEnv = 'test', connectionString = PROBE_URL): Promise<void> {
  return resetDatabase({ connectionString, nodeEnv, seedPassword: SEED_PASSWORD, logger });
}

async function rows<T extends QueryResultRow>(sql: string): Promise<T[]> {
  const result = await db.pool.query<T>(sql);
  return result.rows;
}

async function count(sql: string): Promise<number> {
  const [row] = await rows<{ count: number }>(`SELECT count(*)::int AS count FROM ${sql}`);
  return row?.count ?? -1;
}

describe('assertSafeToReset', () => {
  it.each([
    'postgres://taquilla:taquilla@localhost:5432/taquilla',
    'postgres://taquilla:taquilla@127.0.0.1:5432/taquilla',
    'postgres://taquilla:taquilla@[::1]:5432/taquilla',
    'postgresql://localhost/taquilla',
  ])('allows %s', (connectionString) => {
    expect(() => assertSafeToReset({ connectionString, nodeEnv: 'development' })).not.toThrow();
  });

  it.each([
    ['a hosted database', 'postgres://user:secret@ep-cool.neon.tech/db', 'ep-cool.neon.tech'],
    ['a private address', 'postgres://user:secret@10.0.0.5/db', '10.0.0.5'],
    [
      'a look-alike name',
      'postgres://user:secret@localhost.example.com/db',
      'localhost.example.com',
    ],
    [
      'a ?host= override',
      'postgres://user:secret@localhost/db?host=db.example.com',
      'db.example.com',
    ],
    ['a socket path', 'postgres://user:secret@localhost/db?host=/var/run/postgresql', '/var/run'],
  ])('refuses %s, without showing the password', (_name, connectionString, host) => {
    let message = '';
    try {
      assertSafeToReset({ connectionString, nodeEnv: 'development' });
    } catch (err) {
      message = String(err);
    }

    expect(message).toContain('Refusing to reset');
    expect(message).toContain(host);
    expect(message).not.toContain('secret');
  });

  it('refuses production, even on a local database', () => {
    expect(() => assertSafeToReset({ connectionString: PROBE_URL, nodeEnv: 'production' })).toThrow(
      /NODE_ENV is production/,
    );
  });
});

describe('resetDatabase', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${PROBE_DATABASE}`);
    db = createDatabase({ connectionString: PROBE_URL, logger });
    await reset();
  }, 30_000);

  afterAll(async () => {
    await db.close();
    await admin(`DROP DATABASE IF EXISTS ${PROBE_DATABASE} WITH (FORCE)`);
  });

  it('creates one match with 2,000 available seats and 1,000 fans', async () => {
    expect(await count('events')).toBe(1);
    expect(await count('seats')).toBe(2_000);
    expect(await count(`seats WHERE status = 'available'`)).toBe(2_000);
    expect(await count('users')).toBe(1_000);
  });

  it('lays out four stands of 20 rows and 25 seats, priced in paise', async () => {
    const stands = await rows(
      `SELECT section,
              count(*)::int AS seats,
              count(DISTINCT row_label)::int AS rows,
              min(row_label) AS first_row,
              max(row_label) AS last_row,
              min(seat_no) AS first_seat,
              max(seat_no) AS last_seat,
              min(price_paise) AS price
         FROM seats
        GROUP BY section
        ORDER BY section`,
    );
    const stand = {
      seats: 500,
      rows: 20,
      first_row: 'A',
      last_row: 'T',
      first_seat: 1,
      last_seat: 25,
    };

    expect(stands).toEqual([
      { section: 'Fondo Norte', ...stand, price: 250_000 },
      { section: 'Fondo Sur', ...stand, price: 250_000 },
      { section: 'Lateral Este', ...stand, price: 450_000 },
      { section: 'Lateral Oeste', ...stand, price: 450_000 },
    ]);
  });

  it('gives seats the same ids every time, so seat 42 is always the same seat', async () => {
    const seats = await rows(
      `SELECT id, section, row_label, seat_no FROM seats WHERE id IN (1, 42, 2000) ORDER BY id`,
    );

    expect(seats).toEqual([
      { id: 1, section: 'Lateral Este', row_label: 'A', seat_no: 1 },
      { id: 42, section: 'Lateral Este', row_label: 'B', seat_no: 17 },
      { id: 2000, section: 'Fondo Sur', row_label: 'T', seat_no: 25 },
    ]);
  });

  it('names the fans fan1 to fan1000', async () => {
    expect(await count(`users WHERE email ~ '^fan[1-9][0-9]{0,3}@taquilla\\.test$'`)).toBe(1_000);
    expect(
      await count(`users WHERE email IN ('fan1@taquilla.test', 'fan1000@taquilla.test')`),
    ).toBe(2);
  });

  it('gives every fan one hash of the seed password', async () => {
    const hashes = await rows<{ password_hash: string }>(
      'SELECT DISTINCT password_hash FROM users',
    );

    expect(hashes).toHaveLength(1);
    const hash = hashes[0]?.password_hash ?? '';
    expect(bcrypt.getRounds(hash)).toBe(12);
    expect(await bcrypt.compare(SEED_PASSWORD, hash)).toBe(true);
    expect(await bcrypt.compare('another-password', hash)).toBe(false);
  });

  it("records the migrations it applied, the payment mock's included", async () => {
    expect(await count(`schema_migrations WHERE name = '001_core.sql'`)).toBe(1);
    expect(await count(`payments.schema_migrations WHERE name = '001_charges.sql'`)).toBe(1);
  });

  it('wipes everything and starts ids again on the next reset, within seconds', async () => {
    await db.pool.query('CREATE TABLE stray (id int)');
    await db.pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('extra@taquilla.test', 'hash')`,
    );
    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = 42`);
    await db.pool.query('DELETE FROM seats WHERE id = 1');
    await db.pool.query(
      `INSERT INTO payments.charges (key, order_id, amount_paise, status)
       VALUES ('pay:stale', gen_random_uuid(), 100, 'succeeded')`,
    );

    const startedAt = performance.now();
    await reset();
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(await rows(`SELECT to_regclass('public.stray') AS stray`)).toEqual([{ stray: null }]);
    expect(await count('users')).toBe(1_000);
    expect(await count(`seats WHERE status = 'available'`)).toBe(2_000);
    expect(await count('seats WHERE id = 1')).toBe(1);
    expect(await count('events WHERE id = 1')).toBe(1);
    expect(await count('payments.charges')).toBe(0);
  });

  it('touches nothing when it refuses', async () => {
    await db.pool.query('CREATE TABLE survivor (id int)');

    await expect(reset('production')).rejects.toThrow(/NODE_ENV is production/);

    expect(await count('survivor')).toBe(0);
    await db.pool.query('DROP TABLE survivor');
  });

  it('refuses a remote host before trying to connect', async () => {
    await expect(reset('test', 'postgres://user:secret@db.invalid/db')).rejects.toThrow(
      /db\.invalid is not local/,
    );
  });
});
