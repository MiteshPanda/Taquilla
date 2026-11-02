import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import type { Logger } from 'pino';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations', import.meta.url));
const FILE_NAME = /^(\d{3})_[a-z0-9_]+\.sql$/;
// A file's own COMMIT would end the runner's transaction, so a later failure couldn't undo it.
const TRANSACTION_CONTROL =
  /^\s*(BEGIN(\s+TRANSACTION)?|START\s+TRANSACTION|COMMIT|ROLLBACK)\s*;/im;
// Any fixed number works: it only has to be the same for every run of the runner.
const ADVISORY_LOCK_ID = 7_402_915;

interface Migration {
  name: string;
  file: string;
}

export interface MigrateOptions {
  connectionString: string;
  logger: Logger;
  production: boolean;
  directory?: string;
}

async function listMigrations(directory: string, prefix = ''): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && /\.sql$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const numbers = new Set<string>();
  return names.map((name) => {
    const number = FILE_NAME.exec(name)?.[1];
    if (number === undefined) {
      throw new Error(`Bad migration name ${prefix}${name}: expected a name like 001_core.sql.`);
    }
    if (numbers.has(number)) {
      throw new Error(`Two migrations in ${prefix || 'the main folder'} share number ${number}.`);
    }
    numbers.add(number);
    return { name: `${prefix}${name}`, file: path.join(directory, name) };
  });
}

async function applyMigration(client: Client, { name, file }: Migration): Promise<void> {
  const sql = await readFile(file, 'utf8');
  if (TRANSACTION_CONTROL.test(sql)) {
    throw new Error(
      `Migration ${name} has its own BEGIN, COMMIT or ROLLBACK. Remove it: each file already runs in a transaction.`,
    );
  }

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
  } catch (err) {
    // If this fails too, the connection is gone or about to be closed, and either one rolls back.
    await client.query('ROLLBACK').catch(() => undefined);
    throw new Error(`Migration ${name} failed`, { cause: err });
  }
}

// Returns the names it applied. Main migrations run first because they can't depend on dev ones.
export async function runMigrations({
  connectionString,
  logger,
  production,
  directory = MIGRATIONS_DIRECTORY,
}: MigrateOptions): Promise<string[]> {
  const migrations = await listMigrations(directory);
  if (!production) {
    migrations.push(...(await listMigrations(path.join(directory, 'dev'), 'dev/')));
  }

  // Not the API's pool: its 5-second statement limit would kill a long migration.
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    application_name: 'taquilla-migrate',
  });
  // Without a listener, a dropped connection would crash the process instead of failing the query.
  client.on('error', (err) => {
    logger.error({ err }, 'database connection lost during migration');
  });
  await client.connect();

  try {
    // Runners starting together take turns, so the later ones find nothing left to do.
    // Postgres releases this lock when the connection closes.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    const pending = migrations.filter((migration) => !applied.has(migration.name));

    for (const migration of pending) {
      await applyMigration(client, migration);
      logger.info({ migration: migration.name }, 'migration applied');
    }
    logger.info({ applied: pending.length }, 'migrations up to date');
    return pending.map((migration) => migration.name);
  } finally {
    await client.end();
  }
}
