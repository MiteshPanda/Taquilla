import { hashPassword } from './auth/password.js';
import { loadSeedConfig } from './config.js';
import { createDatabase } from './db.js';
import { createLogger } from './logger.js';
import { seedIfEmpty } from './seed.js';

const config = loadSeedConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDatabase({ connectionString: config.DATABASE_URL, logger, max: 1 });

try {
  // Hashed before the seed's transaction, so its lock is held for as short a time as possible.
  const seeded = await seedIfEmpty(db, await hashPassword(config.SEED_PASSWORD));
  if (seeded) {
    logger.info('stadium seeded: 1 match, 2,000 seats, 1,000 fans');
  } else {
    logger.info('the database already has a match or fans, so nothing was seeded');
  }
} catch (err) {
  logger.fatal({ err }, 'seed failed');
  process.exitCode = 1;
} finally {
  await db.close();
}
