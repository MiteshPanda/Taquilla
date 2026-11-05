import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { logger, TEST_DATABASE_URL } from './helpers/mock.js';

const SCHEMA = 'mock_migrate';

let pool: Pool;

function migrate(options: { directory?: string } = {}) {
  return runMigrations({ connectionString: TEST_DATABASE_URL, logger, schema: SCHEMA, ...options });
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`${SCHEMA}.${name}`],
  );
  return rows[0]?.exists ?? false;
}

function insertCharge(values: {
  key?: string;
  orderId?: string;
  amountPaise?: number;
  status?: string;
  refundedAt?: Date | null;
}) {
  return pool.query(
    `INSERT INTO charges (key, order_id, amount_paise, status, refunded_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      values.key ?? randomUUID(),
      values.orderId ?? randomUUID(),
      values.amountPaise ?? 100,
      values.status ?? 'succeeded',
      values.refundedAt ?? null,
    ],
  );
}

beforeAll(() => {
  pool = createPool({ connectionString: TEST_DATABASE_URL, logger, schema: SCHEMA });
});

beforeEach(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
});

afterAll(async () => {
  await pool.end();
});

describe('runMigrations', () => {
  it('creates its own schema and the charges table in it (FR-MOCK-1)', async () => {
    expect(await migrate()).toEqual(['001_charges.sql']);

    expect(await tableExists('charges')).toBe(true);
    expect(await tableExists('schema_migrations')).toBe(true);
  });

  it('applies nothing the second time', async () => {
    await migrate();

    expect(await migrate()).toEqual([]);
  });

  it('applies each migration once when two runners start together', async () => {
    const results = await Promise.all([migrate(), migrate()]);

    expect(results.flat()).toEqual(['001_charges.sql']);
  });

  it('refuses a schema name that is not a plain identifier, before connecting', async () => {
    await expect(
      runMigrations({ connectionString: TEST_DATABASE_URL, logger, schema: 'payments; DROP' }),
    ).rejects.toThrow('Bad schema name');
  });

  describe('with a directory of its own', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(path.join(tmpdir(), 'taquilla-payments-migrations-'));
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('keeps the files before a failed one, and rolls the failed one back', async () => {
      await writeFile(path.join(directory, '001_good.sql'), 'CREATE TABLE good (id int);');
      await writeFile(
        path.join(directory, '002_bad.sql'),
        'CREATE TABLE half (id int); SELECT nope;',
      );

      await expect(migrate({ directory })).rejects.toThrow('Migration 002_bad.sql failed');

      expect(await tableExists('good')).toBe(true);
      expect(await tableExists('half')).toBe(false);
      const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
      expect(rows.map((row) => row.name)).toEqual(['001_good.sql']);
    });

    it.each([
      ['a name without a number', 'charges.sql'],
      ['a name with capitals', '001_Charges.sql'],
    ])('refuses %s', async (_name, file) => {
      await writeFile(path.join(directory, file), 'SELECT 1;');

      await expect(migrate({ directory })).rejects.toThrow('Bad migration name');
    });

    it('refuses two files with one number', async () => {
      await writeFile(path.join(directory, '001_a.sql'), 'SELECT 1;');
      await writeFile(path.join(directory, '001_b.sql'), 'SELECT 1;');

      await expect(migrate({ directory })).rejects.toThrow('Two migrations share number 001');
    });
  });
});

describe('the charges table (DR-9)', () => {
  beforeEach(async () => {
    await migrate();
  });

  it('is keyed by idempotency key', async () => {
    await insertCharge({ key: 'pay:1' });

    await expect(insertCharge({ key: 'pay:1' })).rejects.toMatchObject({
      code: '23505',
      constraint: 'charges_pkey',
    });
  });

  it('allows two charges for one order: only Taquilla may prevent that (FR-MOCK-3)', async () => {
    const orderId = randomUUID();

    await insertCharge({ orderId });
    await insertCharge({ orderId });

    const { rows } = await pool.query('SELECT 1 FROM charges WHERE order_id = $1', [orderId]);
    expect(rows).toHaveLength(2);
  });

  it.each([
    ['an empty key', { key: '' }, 'charges_key_length'],
    ['a zero amount', { amountPaise: 0 }, 'charges_amount_positive'],
    ['an unknown status', { status: 'pending' }, 'charges_status_check'],
    ['a refund without a refund time', { status: 'refunded' }, 'charges_refund_state'],
    ['a refund time on a live charge', { refundedAt: new Date() }, 'charges_refund_state'],
  ])('rejects %s', async (_name, values, constraint) => {
    await expect(insertCharge(values)).rejects.toMatchObject({ code: '23514', constraint });
  });
});
