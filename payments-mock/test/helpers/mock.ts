import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/charges.js';
import { createPool } from '../../src/db.js';
import { createFaults, NO_FAULTS } from '../../src/faults.js';
import type { FaultSettings, FaultSources, Faults } from '../../src/faults.js';
import { createLogger } from '../../src/logger.js';
import { runMigrations } from '../../src/migrate.js';

// The taquilla_test database from docker-compose.yml. Start it with: docker compose up -d postgres
export const TEST_DATABASE_URL = 'postgres://taquilla:taquilla@localhost:5432/taquilla_test';

// Nothing listens on this port, so a connection is refused at once, as when the database is down.
export const DOWN_DATABASE_URL = 'postgres://taquilla:taquilla@127.0.0.1:1/taquilla_test';

export const logger = createLogger('silent');

// A fresh, migrated schema of the test file's own, so its charges never meet another file's.
export async function createTestSchema(schema: string): Promise<Pool> {
  const pool = createPool({ connectionString: TEST_DATABASE_URL, logger, schema });
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await runMigrations({ connectionString: TEST_DATABASE_URL, logger, schema });
  return pool;
}

export interface RunningMock {
  url: string;
  close(): Promise<void>;
}

// Serves the mock on a free port, so tests call it over real HTTP as the API's client will.
export async function startMock(db: Queryable, faults: Faults): Promise<RunningMock> {
  const server = createApp({ db, faults, logger }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function faultsOf(settings: Partial<FaultSettings>, sources?: FaultSources): Faults {
  return createFaults({ ...NO_FAULTS, ...settings }, sources);
}

export interface Reply {
  status: number;
  body: unknown;
}

export async function postCharge(
  mock: RunningMock,
  key: string | undefined,
  body: unknown,
): Promise<Reply> {
  const response = await fetch(`${mock.url}/charges`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function postRefund(mock: RunningMock, key: string): Promise<Reply> {
  const response = await fetch(`${mock.url}/charges/${encodeURIComponent(key)}/refund`, {
    method: 'POST',
  });
  return { status: response.status, body: await response.json() };
}

export async function countCharges(pool: Pool, where = 'TRUE', params: unknown[] = []) {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM charges WHERE ${where}`,
    params,
  );
  return rows[0]?.count ?? 0;
}
