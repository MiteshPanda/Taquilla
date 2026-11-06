import { createSecretKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AppError } from '../errors.js';

const ALGORITHM = 'HS256';

const claimsSchema = z.object({
  sub: z.string().regex(/^[1-9]\d*$/),
  // Rejects a token that never expires, even one signed with the right secret.
  exp: z.number(),
});

// jsonwebtoken, given the secret as a string, first tries to read it as a public key, which
// throws, and only then makes a secret key from it: on every request. That was the API's largest
// single cost under load (WP 6.4), so each secret becomes a key object once.
const secretKeys = new Map<string, KeyObject>();

function keyFor(secret: string): KeyObject {
  let key = secretKeys.get(secret);
  if (key === undefined) {
    key = createSecretKey(Buffer.from(secret, 'utf8'));
    secretKeys.set(secret, key);
  }
  return key;
}

function invalidToken(cause?: unknown): AppError {
  return new AppError(
    401,
    'UNAUTHORIZED',
    'Your session is invalid or has expired. Log in again.',
    undefined,
    {
      cause,
    },
  );
}

export function signToken(userId: number, secret: string, expiresInSeconds: number): string {
  return jwt.sign({}, keyFor(secret), {
    algorithm: ALGORITHM,
    subject: String(userId),
    expiresIn: expiresInSeconds,
  });
}

// Returns the token's user id, or throws a 401. Pinning the algorithm stops a token from
// choosing its own, such as "none".
export function verifyToken(token: string, secret: string): number {
  let claims: unknown;
  try {
    claims = jwt.verify(token, keyFor(secret), { algorithms: [ALGORITHM] });
  } catch (err) {
    throw invalidToken(err);
  }

  const parsed = claimsSchema.safeParse(claims);
  if (!parsed.success) throw invalidToken();
  return Number(parsed.data.sub);
}
