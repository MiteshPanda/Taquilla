import type { Database } from '../db.js';
import { AppError } from '../errors.js';
import { hashPassword, verifyPassword } from './password.js';

export interface NewUser {
  id: number;
  email: string;
}

export async function signUp(
  db: Pick<Database, 'pool'>,
  email: string,
  password: string,
): Promise<NewUser> {
  const passwordHash = await hashPassword(password);
  // ON CONFLICT rather than catching the error, so two signups racing for one email are a plain 409.
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, passwordHash],
  );

  const user = rows[0];
  if (user === undefined) {
    throw new AppError(
      409,
      'EMAIL_TAKEN',
      'An account with this email already exists. Log in instead.',
    );
  }
  return { id: user.id, email };
}

// Returns the user's id. A wrong password and an unknown email get the same answer, in about the
// same time, so login can't be used to find out who has an account.
export async function logIn(
  db: Pick<Database, 'pool'>,
  email: string,
  password: string,
): Promise<number> {
  const { rows } = await db.pool.query<{ id: number; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email],
  );

  const user = rows[0];
  const valid = await verifyPassword(password, user?.password_hash);
  if (!valid || user === undefined) {
    throw new AppError(401, 'UNAUTHORIZED', 'The email or password is incorrect.');
  }
  return user.id;
}
