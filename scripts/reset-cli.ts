import { loadResetConfig } from '../api/src/config.js';
import { createLogger } from '../api/src/logger.js';
import { resetDatabase } from './reset.js';

const config = loadResetConfig();
const logger = createLogger(config.LOG_LEVEL);
const startedAt = performance.now();

try {
  await resetDatabase({
    connectionString: config.DATABASE_URL,
    nodeEnv: config.NODE_ENV,
    seedPassword: config.SEED_PASSWORD,
    logger,
  });
  logger.info(
    { durationMs: Math.round(performance.now() - startedAt) },
    'stadium reset: 1 match, 2,000 seats, 1,000 fans',
  );
} catch (err) {
  logger.fatal({ err }, 'reset failed');
  process.exitCode = 1;
}
