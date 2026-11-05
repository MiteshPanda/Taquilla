import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import type { Logger } from 'pino';
import { assertSchemaName, PAYMENTS_SCHEMA } from './db.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;
// Not the API runner's number, so the two never wait on each other.
const ADVISORY_LOCK_ID = 7_402_916;

export interface MigrateOptions {
  connectionString: string;
  logger: Logger;
  schema?: string;
  directory?: string;
}

async function listMigrations(directory: string): Promise<string[]> {
  const names = (await readdir(directory)).filter((name) => /\.sql$/i.test(name)).sort();
  const numbers = new Set<string>();
  for (const name of names) {
    const number = FILE_NAME.exec(name)?.[1];
    if (number === undefined) {
      throw new Error(`Bad migration name ${name}: expected a name like 001_charges.sql.`);
    }
    if (numbers.has(number)) throw new Error(`Two migrations share number ${number}.`);
    numbers.add(number);
  }
  return names;
}

// Creates the schema if needed, then applies each new file in its own transaction.
// Returns the names it applied. The mock owns its tables, so the API's runner never sees them.
export async function runMigrations({
  connectionString,
  logger,
  schema = PAYMENTS_SCHEMA,
  directory = MIGRATIONS_DIRECTORY,
}: MigrateOptions): Promise<string[]> {
  assertSchemaName(schema);
  const migrations = await listMigrations(directory);

  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    application_name: 'taquilla-payments-migrate',
  });
  // Without a listener, a dropped connection would crash the process instead of failing the query.
  client.on('error', (err) => {
    logger.error({ err }, 'database connection lost during migration');
  });
  await client.connect();

  try {
    // Two instances starting together take turns; Postgres releases the lock when the connection closes.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const pending = migrations.filter((name) => !applied.has(name));

    for (const name of pending) {
      const sql = await readFile(path.join(directory, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        // If this fails too, the connection is gone, and that rolls back as well.
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${name} failed`, { cause: err });
      }
      logger.info({ migration: name, schema }, 'migration applied');
    }
    logger.info({ applied: pending.length, schema }, 'migrations up to date');
    return pending;
  } finally {
    await client.end();
  }
}
