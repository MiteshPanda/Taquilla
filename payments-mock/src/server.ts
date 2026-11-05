import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createFaults } from './faults.js';
import { createLogger } from './logger.js';

const FORCE_EXIT_AFTER_MS = 10_000;

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool({ connectionString: config.DATABASE_URL, logger });
const faultSettings = {
  declineRate: config.DECLINE_RATE,
  lostResponseRate: config.LOST_RESPONSE_RATE,
  latencyMinMs: config.LATENCY_MIN_MS,
  latencyMaxMs: config.LATENCY_MAX_MS,
};
const app = createApp({ db: pool, faults: createFaults(faultSettings), logger });

const server = app.listen(config.PAYMENTS_PORT, (err) => {
  if (err) {
    logger.fatal({ err }, 'payments mock failed to start');
    process.exit(1);
  }
  const { port } = server.address() as AddressInfo;
  logger.info({ port, faults: faultSettings }, 'payments mock listening');
});

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'payments mock stopping');

  const forceExit = setTimeout(() => {
    logger.error({ forceAfterMs: FORCE_EXIT_AFTER_MS }, 'shutdown timed out, forcing exit');
    process.exit(1);
  }, FORCE_EXIT_AFTER_MS);
  forceExit.unref();

  try {
    // Stops accepting connections, then resolves once in-flight charges have been answered.
    await new Promise<void>((resolve, reject) => {
      server.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
    });
    await pool.end();
    logger.info('payments mock stopped');
    process.exit(0);
  } catch (shutdownErr) {
    logger.error({ err: shutdownErr }, 'shutdown failed');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
