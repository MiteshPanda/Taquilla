import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { parseBody } from '../validation.js';
import { MAX_PASSWORD_BYTES, passwordBytes } from './password.js';
import { logIn, signUp } from './service.js';
import { signToken } from './tokens.js';

const EMAIL_RULE = 'Enter a valid email address.';
const PASSWORD_RULE = `Use a password of at least 8 characters and at most ${MAX_PASSWORD_BYTES} bytes.`;
const BODY_RULE = 'Send a JSON body with an email and a password.';

// Lowercased, so Fan@example.com and fan@example.com can't become two accounts.
const email = z
  .string({ error: EMAIL_RULE })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: EMAIL_RULE }).max(254, { error: EMAIL_RULE }));

const signupSchema = z.object(
  {
    email,
    password: z
      .string({ error: PASSWORD_RULE })
      .min(8, { error: PASSWORD_RULE })
      .refine((password) => passwordBytes(password) <= MAX_PASSWORD_BYTES, {
        error: PASSWORD_RULE,
      }),
  },
  { error: BODY_RULE },
);

// No length rules here: they would tell a guesser something, and verifyPassword handles any length.
const loginSchema = z.object(
  {
    email,
    password: z.string({ error: 'Enter your password.' }).min(1, { error: 'Enter your password.' }),
  },
  { error: BODY_RULE },
);

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
