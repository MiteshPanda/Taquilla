import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createHoldStrategy } from './holds/strategies.js';
import { createLogger } from './logger.js';
import { createRoutes, devRoutesEnabled } from './routes.js';
import { createShutdown } from './shutdown.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDatabase({ connectionString: config.DATABASE_URL, logger });
// Chosen once here, so every hold in this process uses the same strategy (FR-HOLD-5).
const holdStrategy = createHoldStrategy(config.BOOKING_STRATEGY, {
  db,
  holdSeconds: config.HOLD_SECONDS,
  logger,
});
logger.info({ strategy: holdStrategy.name }, 'booking strategy selected');
const app = createApp({ config, logger, routes: createRoutes({ db, config }) });

if (devRoutesEnabled(config.NODE_ENV)) {
  logger.warn(
    { nodeEnv: config.NODE_ENV },
    'dev routes are mounted, including the deliberately unsafe POST /dev/buy-naive',
  );
}

const server = app.listen(config.PORT, (err) => {
  if (err) {
    logger.fatal({ err }, 'server failed to start');
    process.exit(1);
  }
  logger.info({ port: config.PORT }, 'server listening');
});

const shutdown = createShutdown({ server, logger, closers: [() => db.close()] });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
