import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, userIdOf } from '../auth/middleware.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { IDEMPOTENCY_KEY_HEADER, idempotency } from '../idempotency/middleware.js';
import { checkout } from './checkout.js';
import type { CheckoutDeps } from './checkout.js';

export interface CheckoutRouterOptions extends CheckoutDeps {
  config: Pick<Config, 'JWT_SECRET'>;
}

export function createCheckoutRouter({ db, payments, config }: CheckoutRouterOptions): Router {
  const router = Router();

  // A key is required (FR-PAY-1): it is what keeps a double-clicked Pay to one charge.
  router.post(
    '/holds/:id/checkout',
    requireAuth(config.JWT_SECRET),
    idempotency({ db, required: true }),
    async (req, res) => {
      // A malformed id can't name a hold, so it gets the same 404 as an unknown one.
      const holdId = z.uuid().safeParse(req.params.id);
      if (!holdId.success) throw new AppError(404, 'NOT_FOUND', 'This hold does not exist.');
      // The idempotency middleware has already refused a request without a valid key.
      const clientKey = req.get(IDEMPOTENCY_KEY_HEADER) ?? '';

      const paid = await checkout(
        { db, payments },
        {
          holdId: holdId.data,
          userId: userIdOf(req),
          clientKey,
          logger: req.log,
          // app.ts makes every request ID a string; the provider logs the same one.
          requestId: typeof req.id === 'string' ? req.id : undefined,
        },
      );
      res.status(200).json(paid);
    },
  );

  return router;
}
