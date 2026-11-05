import { loadMigrateConfig } from './config.js';
import { createLogger } from './logger.js';
import { runMigrations } from './migrate.js';

const config = loadMigrateConfig();
const logger = createLogger(config.LOG_LEVEL);

try {
  await runMigrations({ connectionString: config.DATABASE_URL, logger });
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
}
