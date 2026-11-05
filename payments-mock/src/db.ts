import { Pool } from 'pg';
import type { Logger } from 'pino';

// The provider's own schema (FR-MOCK-1). Tests use a scratch schema in its place.
export const PAYMENTS_SCHEMA = 'payments';

// The name is written into SQL, so only a plain lowercase identifier is accepted.
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertSchemaName(schema: string): void {
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(`Bad schema name "${schema}": use lowercase letters, digits and underscores.`);
  }
}

export interface PoolOptions {
  connectionString: string;
  logger: Logger;
  schema?: string;
  max?: number;
}

export function createPool({
  connectionString,
  logger,
  schema = PAYMENTS_SCHEMA,
  max = 10,
}: PoolOptions): Pool {
  assertSchemaName(schema);
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    // Queries name their tables without a schema, so this decides which schema they use.
    options: `-c search_path=${schema}`,
    application_name: 'taquilla-payments-mock',
  });

  // Without a listener, an idle connection dropping would crash the process.
  pool.on('error', (err) => {
    logger.error({ err }, 'idle database connection lost');
  });

  return pool;
}
