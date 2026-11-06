import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import type { Express, Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { REPLAYED_HEADER } from './idempotency/middleware.js';

const REQUEST_ID_HEADER = 'X-Request-Id';
const SAFE_REQUEST_ID = /^[\w-]{1,128}$/;

export interface AppOptions {
  config: Pick<Config, 'CORS_ORIGINS'>;
  logger: Logger;
  routes?: Router;
}

export function createApp({ config, logger, routes }: AppOptions): Express {
  const app = express();

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        // A client's ID ends up in the logs, so anything unusual is replaced.
        const id =
          typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
        res.setHeader(REQUEST_ID_HEADER, id);
        return id;
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.err || res.statusCode >= 500) return 'error';
        // A 409 is the expected answer when fans race for a seat; a 429 may be someone guessing passwords.
        if (res.statusCode === 409) return 'debug';
        return res.statusCode === 429 ? 'warn' : 'info';
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({ origin: config.CORS_ORIGINS, exposedHeaders: [REQUEST_ID_HEADER, REPLAYED_HEADER] }),
  );
  app.use(express.json({ limit: '10kb' }));

  if (routes) app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
