import { Router } from 'express';
import { createApp } from './app.js';
import { createAuthRouter } from './auth/routes.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createHealthRouter } from './health/routes.js';
import { createLogger } from './logger.js';
import { createShutdown } from './shutdown.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createDatabase({ connectionString: config.DATABASE_URL, logger });
const routes = Router();
routes.use(createHealthRouter(db));
routes.use('/auth', createAuthRouter({ db, config }));
const app = createApp({ config, logger, routes });

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
