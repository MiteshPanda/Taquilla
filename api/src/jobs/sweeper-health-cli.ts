// The sweeper container's health check (WP 8.1): exit code 0 while the last successful run ended
// recently enough, 1 otherwise. A sweeper that is stuck, or can't reach the database, goes
// unhealthy, which a check of the process alone would miss.
import { stat } from 'node:fs/promises';
import { loadSweeperConfig } from '../config.js';
import { heartbeatIsFresh } from './sweeper.js';

const config = loadSweeperConfig();
const file = config.SWEEPER_HEARTBEAT_FILE;
const intervalMs = config.SWEEP_INTERVAL_SECONDS * 1000;

if (file === undefined) {
  console.error('SWEEPER_HEARTBEAT_FILE is not set, so the sweeper keeps no heartbeat to check.');
  process.exit(1);
}

try {
  const { mtimeMs } = await stat(file);
  if (!heartbeatIsFresh(mtimeMs, Date.now(), intervalMs)) {
    console.error(`The sweeper's last successful run ended at ${new Date(mtimeMs).toISOString()}.`);
    process.exitCode = 1;
  }
} catch {
  console.error('The sweeper has not finished a run yet.');
  process.exitCode = 1;
}
