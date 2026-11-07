import { createApp } from './app.js';
import { loadEmbeddedPayments } from './checkout/embedded-payments.js';
import type { EmbeddedPayments } from './checkout/embedded-payments.js';
import { createPaymentClient } from './checkout/payment-client.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';
import { createHoldStrategy } from './holds/strategies.js';
import { createSweeper } from './jobs/sweeper.js';
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

// WP 8.4: on a host where every service is its own and sleeps when idle, the payment mock runs in
// this process instead, and PAYMENTS_URL is ignored.
let embeddedPayments: EmbeddedPayments | undefined;
if (config.PAYMENTS_IN_PROCESS) {
  try {
    const start = await loadEmbeddedPayments();
    embeddedPayments = await start({ connectionString: config.DATABASE_URL, logger });
  } catch (err) {
    logger.fatal({ err }, 'the payment mock failed to start in this process');
    process.exit(1);
  }
}
const payments = createPaymentClient({
  baseUrl: embeddedPayments?.url ?? config.PAYMENTS_URL,
  logger,
});

// The same sweeper as the standalone one, on this process's pool. Correctness never depends on
// it, so a run that fails only logs, and the next one tries again.
const sweeper = config.SWEEPER_IN_PROCESS
  ? createSweeper({ db, logger, intervalMs: config.SWEEP_INTERVAL_SECONDS * 1000 })
  : undefined;
if (sweeper) {
  sweeper.start();
  logger.info(
    { intervalSeconds: config.SWEEP_INTERVAL_SECONDS },
    'sweeper running in this process',
  );
}

const app = createApp({
  config,
  logger,
  routes: createRoutes({ db, config, holdStrategy, payments }),
});

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

// After the server stops taking requests: the sweeper finishes its run, the mock answers the
// charges still in flight, and only then does the pool they share close.
const closers: (() => Promise<void>)[] = [];
if (sweeper) closers.push(() => sweeper.stop());
const mock = embeddedPayments;
if (mock) closers.push(() => mock.close());
closers.push(() => db.close());

const shutdown = createShutdown({ server, logger, closers });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
