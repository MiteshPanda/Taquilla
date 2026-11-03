import { Client } from 'pg';
import type { Logger } from 'pino';
import { hashPassword } from '../api/src/auth/password.js';
import { createDatabase } from '../api/src/db.js';
import { runMigrations } from '../api/src/migrate.js';
import { seedStadium } from './seed.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface ResetTarget {
  connectionString: string;
  nodeEnv: string;
}

export interface ResetOptions extends ResetTarget {
  seedPassword: string;
  logger: Logger;
}

export function assertSafeToReset({ connectionString, nodeEnv }: ResetTarget): void {
  if (nodeEnv === 'production') {
    throw new Error('Refusing to reset: NODE_ENV is production.');
  }
  // Ask pg rather than parse the URL, because a ?host= setting overrides the URL's host part.
  const { host } = new Client({ connectionString });
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`Refusing to reset: the database host ${host} is not local.`);
  }
}

export async function resetDatabase({
  connectionString,
  nodeEnv,
  seedPassword,
  logger,
}: ResetOptions): Promise<void> {
  assertSafeToReset({ connectionString, nodeEnv });

  const passwordHash = await hashPassword(seedPassword);
  const db = createDatabase({ connectionString, logger, max: 1 });
  try {
    await db.withTransaction(async (client) => {
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
    });
    await runMigrations({ connectionString, logger, production: false });
    await db.withTransaction((client) => seedStadium(client, passwordHash));
  } finally {
    await db.close();
  }
}
