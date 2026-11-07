// The payment mock inside another process (WP 8.4). On a free host each service sleeps when idle,
// and a sleeping provider would time out the API's charges, so the hosted demo runs the mock in
// the API's own process, on a private port only that process uses. It's the same mock: the API
// still reaches it over HTTP, with the same keys, faults and table.
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import { parseConfig } from './config.js';
import { createPool } from './db.js';
import { createFaults } from './faults.js';
import { runMigrations } from './migrate.js';

export interface EmbeddedPaymentsOptions {
  connectionString: string;
  logger: Logger;
  // The fault settings, read the way the standalone mock reads them (DECLINE_RATE and so on).
  env?: NodeJS.ProcessEnv;
  // A scratch schema for tests, in place of payments.
  schema?: string;
}

export interface EmbeddedPayments {
  // Where the mock listens: an address on this machine only.
  url: string;
  // Stops taking charges, waits for those in flight, then closes its connections.
  close(): Promise<void>;
}

export async function startEmbeddedPayments({
  connectionString,
  logger,
  env = process.env,
  schema,
}: EmbeddedPaymentsOptions): Promise<EmbeddedPayments> {
  const config = parseConfig(env);
  const log = logger.child({ service: 'payments-mock' });
  await runMigrations({ connectionString, logger: log, schema });

  const pool = createPool({ connectionString, logger: log, schema });
  const faultSettings = {
    declineRate: config.DECLINE_RATE,
    lostResponseRate: config.LOST_RESPONSE_RATE,
    latencyMinMs: config.LATENCY_MIN_MS,
    latencyMaxMs: config.LATENCY_MAX_MS,
  };
  const app = createApp({ db: pool, faults: createFaults(faultSettings), logger: log });

  // Port 0 takes any free port, and 127.0.0.1 keeps it off the network.
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  log.info({ port, faults: faultSettings }, 'payments mock running in this process');

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await pool.end();
    },
  };
}
