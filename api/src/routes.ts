import { Router } from 'express';
import { createAuthRouter } from './auth/routes.js';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { createDevRouter } from './dev/routes.js';
import { createHealthRouter } from './health/routes.js';
import { createHoldsRouter } from './holds/routes.js';
import type { HoldStrategy } from './holds/strategy.js';
import { createSeatsRouter } from './seats/routes.js';

export interface RoutesOptions {
  db: Pick<Database, 'pool' | 'ping' | 'withTransaction'>;
  config: Pick<Config, 'NODE_ENV' | 'JWT_SECRET' | 'JWT_EXPIRES_IN' | 'RACE_DELAY_MS'>;
  holdStrategy: HoldStrategy;
}

// The naive buy exists to show the bug, so a production server doesn't have the route at all.
export function devRoutesEnabled(nodeEnv: Config['NODE_ENV']): boolean {
  return nodeEnv !== 'production';
}

// Every route the API serves. The server and the tests both build it here, so tests see what runs.
export function createRoutes({ db, config, holdStrategy }: RoutesOptions): Router {
  const routes = Router();
  routes.use(createHealthRouter(db));
  routes.use('/auth', createAuthRouter({ db, config }));
  routes.use(createSeatsRouter({ db }));
  routes.use(createHoldsRouter({ db, holdStrategy, config }));
  if (devRoutesEnabled(config.NODE_ENV)) {
    routes.use('/dev', createDevRouter({ db, config }));
  }
  return routes;
}
