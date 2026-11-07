import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Express } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Queryable } from './charges.js';
import { errorHandler, notFoundHandler } from './errors.js';
import type { Faults } from './faults.js';
import { createChargesRouter } from './routes.js';

const REQUEST_ID_HEADER = 'X-Request-Id';
// Docker asks for this every 10 seconds (WP 8.1), so a passing check is logged at debug.
const HEALTH_CHECK = '/health';
const SAFE_REQUEST_ID = /^[\w-]{1,128}$/;

export interface AppOptions {
  db: Queryable;
  faults: Faults;
  logger: Logger;
}

// Only the API calls this service, so it has no CORS and no browser-facing headers.
export function createApp({ db, faults, logger }: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      // The API can pass its own request ID, so one payment can be followed across both logs.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
      customLogLevel: (req, res, err) => {
        if (err || res.err || res.statusCode >= 500) return 'error';
        return req.url === HEALTH_CHECK ? 'debug' : 'info';
      },
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use(createChargesRouter({ db, faults }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
