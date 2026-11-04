import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTokensConfig } from '../api/src/config.js';
import { createLogger } from '../api/src/logger.js';
import { writeTokens } from './tokens.js';

const config = loadTokensConfig();
const logger = createLogger(config.LOG_LEVEL);

try {
  const { count, outFile } = await writeTokens({
    connectionString: config.DATABASE_URL,
    nodeEnv: config.NODE_ENV,
    jwtSecret: config.JWT_SECRET,
    expiresInSeconds: config.JWT_EXPIRES_IN,
    logger,
  });
  logger.info(
    {
      count,
      file: path.relative(fileURLToPath(new URL('..', import.meta.url)), outFile),
      expiresInSeconds: config.JWT_EXPIRES_IN,
    },
    'tokens written',
  );
} catch (err) {
  logger.fatal({ err }, 'writing tokens failed');
  process.exitCode = 1;
}
