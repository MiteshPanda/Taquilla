import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { seedIfEmpty } from '../src/seed.js';
import { schemaConnectionString } from './helpers/database.js';

const SCHEMA = 'seed_probe';
const CONNECTION_STRING = schemaConnectionString(SCHEMA);
const HASH = 'not-a-real-hash';

const logger = createLogger('silent');
const db: Database = createDatabase({ connectionString: CONNECTION_STRING, logger });

async function count(table: string): Promise<number> {
  const { rows } = await db.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return rows[0]?.count ?? -1;
}

async function counts(): Promise<Record<string, number>> {
  return {
    events: await count('events'),
    seats: await count('seats'),
    users: await count('users'),
  };
}

// An empty, migrated schema for every test, as a fresh `docker compose up` finds.
beforeEach(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await runMigrations({ connectionString: CONNECTION_STRING, logger, production: true });
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('seedIfEmpty (WP 8.1)', () => {
  it('seeds an empty database with 1 match, 2,000 seats and 1,000 fans', async () => {
    expect(await seedIfEmpty(db, HASH)).toBe(true);

    expect(await counts()).toEqual({ events: 1, seats: 2_000, users: 1_000 });
    const { rows } = await db.pool.query<{ hashes: string[] }>(
      'SELECT array_agg(DISTINCT password_hash) AS hashes FROM users',
    );
    expect(rows[0]?.hashes).toEqual([HASH]);
  });

  it('leaves a seeded database alone, so it can run on every start', async () => {
    await seedIfEmpty(db, HASH);
    await db.pool.query(`UPDATE seats SET status = 'sold' WHERE id = 42`);

    expect(await seedIfEmpty(db, 'another-hash')).toBe(false);

    expect(await counts()).toEqual({ events: 1, seats: 2_000, users: 1_000 });
    const { rows } = await db.pool.query<{ status: string }>(
      'SELECT status FROM seats WHERE id = 42',
    );
    expect(rows[0]?.status).toBe('sold');
  });

  it('leaves a database with fans but no match alone', async () => {
    await db.pool.query(
      `INSERT INTO users (email, password_hash) VALUES ('someone@example.com', 'their-hash')`,
    );

    expect(await seedIfEmpty(db, HASH)).toBe(false);

    expect(await counts()).toEqual({ events: 0, seats: 0, users: 1 });
  });

  it('leaves a database with a match but no fans alone', async () => {
    await db.pool.query(`INSERT INTO events (name, starts_at) VALUES ('A match', now())`);

    expect(await seedIfEmpty(db, HASH)).toBe(false);

    expect(await counts()).toEqual({ events: 1, seats: 0, users: 0 });
  });

  it('seeds once when two seeders start together', async () => {
    const other = createDatabase({ connectionString: CONNECTION_STRING, logger });
    try {
      const results = await Promise.all([seedIfEmpty(db, HASH), seedIfEmpty(other, HASH)]);

      expect(results.toSorted()).toEqual([false, true]);
      expect(await counts()).toEqual({ events: 1, seats: 2_000, users: 1_000 });
    } finally {
      await other.close();
    }
  });
});
