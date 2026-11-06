import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { parseBody } from '../validation.js';
import { loginSchema, signupSchema } from './rules.js';
import { logIn, signUp } from './service.js';
import { signToken } from './tokens.js';

export interface AuthRouterOptions {
  db: Pick<Database, 'pool'>;
  config: Pick<Config, 'JWT_SECRET' | 'JWT_EXPIRES_IN'>;
}

export function createAuthRouter({ db, config }: AuthRouterOptions): Router {
  const router = Router();

  // Per IP, and held in this process's memory: enough to slow password guessing on one instance.
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, _res, next) => {
        next(
          new AppError(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute, then try again.'),
        );
      },
    }),
  );

  router.post('/signup', async (req, res) => {
    const body = parseBody(signupSchema, req.body);
    const user = await signUp(db, body.email, body.password);
    res.status(201).json(user);
  });

  router.post('/login', async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const userId = await logIn(db, body.email, body.password);
    res.json({ token: signToken(userId, config.JWT_SECRET, config.JWT_EXPIRES_IN) });
  });

  return router;
}
