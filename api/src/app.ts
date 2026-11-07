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
// Docker asks for one of these every 10 seconds (WP 8.1), so a passing check is logged at debug.
const HEALTH_CHECKS = new Set(['/health', '/ready']);
const SAFE_REQUEST_ID = /^[\w-]{1,128}$/;

export interface AppOptions {
  config: Pick<Config, 'CORS_ORIGINS'> & Partial<Pick<Config, 'TRUST_PROXY'>>;
  logger: Logger;
  routes?: Router;
}

export function createApp({ config, logger, routes }: AppOptions): Express {
  const app = express();
  // Behind a host's proxies, each one adds the address it got the request from to
  // X-Forwarded-For. Trusting exactly that many makes req.ip the fan's, which a client can't fake.
  const trustedProxies = config.TRUST_PROXY ?? 0;
  if (trustedProxies > 0) app.set('trust proxy', trustedProxies);

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
      customLogLevel: (req, res, err) => {
        if (err || res.err || res.statusCode >= 500) return 'error';
        if (HEALTH_CHECKS.has(req.url ?? '')) return 'debug';
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
