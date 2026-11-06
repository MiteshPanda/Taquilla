import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, userIdOf } from '../auth/middleware.js';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { findOrder } from './view.js';

export interface OrdersRouterOptions {
  db: Pick<Database, 'pool'>;
  config: Pick<Config, 'JWT_SECRET'>;
}

export function createOrdersRouter({ db, config }: OrdersRouterOptions): Router {
  const router = Router();

  router.get('/orders/:id', requireAuth(config.JWT_SECRET), async (req, res) => {
    // A malformed id, an unknown order and another fan's order all get the same 404, so ids
    // can't be probed (FR-AUTH-3).
    const orderId = z.uuid().safeParse(req.params.id);
    const order = orderId.success
      ? await findOrder(db, { orderId: orderId.data, userId: userIdOf(req) })
      : undefined;
    if (!order) throw new AppError(404, 'NOT_FOUND', 'This order does not exist.');

    // A fan's order is private and changes as it is paid, so nothing may keep a copy.
    res.set('Cache-Control', 'private, no-store').json(order);
  });

  return router;
}
