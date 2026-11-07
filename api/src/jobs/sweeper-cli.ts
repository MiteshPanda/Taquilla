import { writeFile } from 'node:fs/promises';
import { loadSweeperConfig } from '../config.js';
import { createDatabase } from '../db.js';
import { createLogger } from '../logger.js';
import { createSweeper } from './sweeper.js';

const STOP_TIMEOUT_MS = 10_000;

const config = loadSweeperConfig();
const logger = createLogger(config.LOG_LEVEL);
// One run at a time needs one connection; a second covers the pool replacing a dropped one.
const db = createDatabase({ connectionString: config.DATABASE_URL, logger, max: 2 });
const heartbeatFile = config.SWEEPER_HEARTBEAT_FILE;
const sweeper = createSweeper({
  db,
  logger,
  intervalMs: config.SWEEP_INTERVAL_SECONDS * 1000,
  // The health check reads the file's age (sweeper-health-cli.ts), not what it says.
  onRunSucceeded:
    heartbeatFile === undefined
      ? undefined
      : () => writeFile(heartbeatFile, new Date().toISOString()),
});

sweeper.start();
logger.info({ intervalSeconds: config.SWEEP_INTERVAL_SECONDS }, 'sweeper started');

let stopping = false;

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'sweeper stopping');

  const force = setTimeout(() => {
    logger.error({ timeoutMs: STOP_TIMEOUT_MS }, 'sweeper did not stop in time, forcing exit');
    process.exit(1);
  }, STOP_TIMEOUT_MS);
  force.unref();

  try {
    // Lets a run in progress finish, so no batch is cut off halfway.
    await sweeper.stop();
    await db.close();
    logger.info('sweeper stopped');
  } catch (err) {
    logger.error({ err }, 'sweeper did not stop cleanly');
    process.exitCode = 1;
  }
  // Nothing else keeps the process alive now, so it exits by itself.
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    void stop(signal);
  });
}
