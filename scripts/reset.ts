import type { Logger } from 'pino';
import { hashPassword } from '../api/src/auth/password.js';
import { createDatabase } from '../api/src/db.js';
import { runMigrations } from '../api/src/migrate.js';
import { PAYMENTS_SCHEMA } from '../payments-mock/src/db.js';
import { runMigrations as runPaymentsMigrations } from '../payments-mock/src/migrate.js';
import { assertLocalDevelopment } from './local-only.js';
import type { LocalTarget } from './local-only.js';
import { seedStadium } from '../api/src/seed.js';

export interface ResetOptions extends LocalTarget {
  seedPassword: string;
  logger: Logger;
}

export function assertSafeToReset(target: LocalTarget): void {
  assertLocalDevelopment(target, 'reset');
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
      // The payment mock's charges belong to orders that are about to vanish, so they go too.
      // Left behind, they would count as money taken for orders that don't exist (INV-3).
      await client.query(`DROP SCHEMA IF EXISTS ${PAYMENTS_SCHEMA} CASCADE`);
    });
    await runMigrations({ connectionString, logger, production: false });
    await runPaymentsMigrations({ connectionString, logger });
    await db.withTransaction((client) => seedStadium(client, passwordHash));
  } finally {
    await db.close();
  }
}
