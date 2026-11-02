import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createShutdown } from './shutdown.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const app = createApp({ config, logger });

const server = app.listen(config.PORT, (err) => {
  if (err) {
    logger.fatal({ err }, 'server failed to start');
    process.exit(1);
  }
  logger.info({ port: config.PORT }, 'server listening');
});

// WP 0.5 adds the database pool to closers.
const shutdown = createShutdown({ server, logger });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
