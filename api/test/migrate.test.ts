import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db.js';
import type { Database } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrate.js';
import { DOWN_DATABASE_URL, TEST_DATABASE_URL } from './helpers/database.js';

// A schema of its own, so these tests can start empty without touching the real tables.
const SCHEMA = 'migrate_probe';
const CONNECTION_STRING = `${TEST_DATABASE_URL}?options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

const logger = createLogger('silent');

let db: Database;
let directory: string;

function write(name: string, sql: string): Promise<void> {
  return writeFile(path.join(directory, name), sql);
}

function migrate(options: { production?: boolean; connectionString?: string } = {}) {
  return runMigrations({
    connectionString: CONNECTION_STRING,
    logger,
    production: false,
    directory,
    ...options,
  });
}

async function appliedNames(): Promise<string[]> {
  const { rows } = await db.pool.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY applied_at, name',
  );
  return rows.map((row) => row.name);
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`${SCHEMA}.${name}`],
  );
  return rows[0]?.exists ?? false;
}

beforeAll(() => {
  db = createDatabase({ connectionString: CONNECTION_STRING, logger });
});

beforeEach(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.pool.query(`CREATE SCHEMA ${SCHEMA}`);
  directory = await mkdtemp(path.join(tmpdir(), 'taquilla-migrations-'));
  await mkdir(path.join(directory, 'dev'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await db.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.close();
});

describe('runMigrations', () => {
  it('applies each file once, in number order, and nothing the second time', async () => {
    // Written out of order, and each one needs the one before it.
    await write('010_third.sql', 'ALTER TABLE a ADD COLUMN third int;');
    await write('001_first.sql', 'CREATE TABLE a (id int);');
    await write('002_second.sql', 'ALTER TABLE a ADD COLUMN second int;');

    const first = await migrate();
    expect(first).toEqual(['001_first.sql', '002_second.sql', '010_third.sql']);

    const { rows: before } = await db.pool.query('SELECT * FROM schema_migrations ORDER BY name');
    expect(await migrate()).toEqual([]);
    const { rows: after } = await db.pool.query('SELECT * FROM schema_migrations ORDER BY name');
    expect(after).toEqual(before);
  });

  it('applies only the files added since the last run', async () => {
    await write('001_first.sql', 'CREATE TABLE a (id int);');
    await migrate();

    await write('002_second.sql', 'CREATE TABLE b (id int);');
    expect(await migrate()).toEqual(['002_second.sql']);
    expect(await tableExists('b')).toBe(true);
  });

  it('runs every statement in a file', async () => {
    await write('001_many.sql', 'CREATE TABLE a (id int);\nCREATE TABLE b (id int);\n');

    await migrate();

    expect(await tableExists('a')).toBe(true);
    expect(await tableExists('b')).toBe(true);
  });

  it('rolls back only the failing file, stops there, and can retry once it is fixed', async () => {
    await write('001_good.sql', 'CREATE TABLE a (id int);');
    await write('002_bad.sql', 'CREATE TABLE b (id int);\nSELECT 1 / 0;');
    await write('003_later.sql', 'CREATE TABLE c (id int);');

    await expect(migrate()).rejects.toMatchObject({
      message: 'Migration 002_bad.sql failed',
      cause: { message: 'division by zero' },
    });

    expect(await appliedNames()).toEqual(['001_good.sql']);
    expect(await tableExists('a')).toBe(true);
    expect(await tableExists('b')).toBe(false);
    expect(await tableExists('c')).toBe(false);

    await write('002_bad.sql', 'CREATE TABLE b (id int);');
    expect(await migrate()).toEqual(['002_bad.sql', '003_later.sql']);
  });

  it('applies the dev folder after the main one when not in production', async () => {
    await write('dev/001_dev.sql', 'ALTER TABLE a ADD COLUMN dev_only int;');
    await write('001_main.sql', 'CREATE TABLE a (id int);');

    expect(await migrate()).toEqual(['001_main.sql', 'dev/001_dev.sql']);
  });

  it('skips the dev folder in production, even if it is missing or broken', async () => {
    await write('001_main.sql', 'CREATE TABLE a (id int);');
    await write('dev/001_dev.sql', 'CREATE TABLE dev_only (id int);');
    await write('dev/bad name.sql', 'SELECT 1;');

    expect(await migrate({ production: true })).toEqual(['001_main.sql']);
    expect(await tableExists('dev_only')).toBe(false);

    await rm(path.join(directory, 'dev'), { recursive: true });
    expect(await migrate({ production: true })).toEqual([]);
  });

  it('applies dev files on a later run outside production', async () => {
    await write('001_main.sql', 'CREATE TABLE a (id int);');
    await write('dev/001_dev.sql', 'CREATE TABLE dev_only (id int);');
    await migrate({ production: true });

    expect(await migrate()).toEqual(['dev/001_dev.sql']);
  });

  it('ignores files that are not SQL', async () => {
    await write('.gitkeep', '');
    await write('notes.txt', 'not a migration');
    await write('001_main.sql', 'CREATE TABLE a (id int);');

    expect(await migrate()).toEqual(['001_main.sql']);
  });

  it.each(['1_core.sql', '001-core.sql', '001_Core.sql', 'core.sql', '001_CORE.SQL'])(
    'refuses the badly named file %s and applies nothing',
    async (name) => {
      await write('000_first.sql', 'CREATE TABLE a (id int);');
      await write(name, 'SELECT 1;');

      await expect(migrate()).rejects.toThrow(/Bad migration name/);
      expect(await tableExists('schema_migrations')).toBe(false);
      expect(await tableExists('a')).toBe(false);
    },
  );

  it('refuses two files with one number and applies nothing', async () => {
    await write('001_one.sql', 'CREATE TABLE a (id int);');
    await write('001_two.sql', 'CREATE TABLE b (id int);');

    await expect(migrate()).rejects.toThrow(/share number 001/);
    expect(await tableExists('a')).toBe(false);
  });

  it.each(['BEGIN;', 'begin transaction;', 'START TRANSACTION;', 'COMMIT;', '  ROLLBACK ;'])(
    'refuses a file containing %s and runs none of it',
    async (statement) => {
      await write(
        '001_own.sql',
        `CREATE TABLE a (id int);\n${statement}\nCREATE TABLE b (id int);`,
      );

      await expect(migrate()).rejects.toThrow(/001_own\.sql has its own/);
      expect(await tableExists('a')).toBe(false);
      expect(await appliedNames()).toEqual([]);
    },
  );

  it('allows the BEGIN and END of a function body', async () => {
    await write(
      '001_function.sql',
      `CREATE FUNCTION one() RETURNS int AS $$
BEGIN
  RETURN 1;
END;
$$ LANGUAGE plpgsql;`,
    );

    expect(await migrate()).toEqual(['001_function.sql']);
  });

  it('applies a file once when several runners start together', async () => {
    // Applying this twice would fail, and the sleep keeps the runners overlapping.
    await write('001_slow.sql', 'SELECT pg_sleep(0.2);\nCREATE TABLE a (id int);');

    const results = await Promise.all(Array.from({ length: 5 }, () => migrate()));

    expect(results.flat()).toEqual(['001_slow.sql']);
    expect(await appliedNames()).toEqual(['001_slow.sql']);
  });

  it('fails without recording anything when the connection drops mid-file', async () => {
    await write('001_dies.sql', 'SELECT pg_terminate_backend(pg_backend_pid());');

    await expect(migrate()).rejects.toThrow(/001_dies\.sql failed/);
    expect(await appliedNames()).toEqual([]);
  });

  it('rejects when the database is down', async () => {
    await expect(migrate({ connectionString: DOWN_DATABASE_URL })).rejects.toThrow();
  });

  it("applies the repo's own migrations to an empty schema, and nothing the second time", async () => {
    const options = { connectionString: CONNECTION_STRING, logger, production: false };

    await runMigrations(options);

    expect(await runMigrations(options)).toEqual([]);
  });
});
