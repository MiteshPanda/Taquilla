import { z } from 'zod';

// The sign-up and login rules. The web page's forms import this very file (WP 7.2), so a form
// refuses exactly what the API would, with the same words. The page bundles it, so it must not
// use Node's APIs: web's typecheck, which has no Node types, fails if it does.

// bcrypt ignores everything after 72 bytes, so a longer password would match a shorter one.
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;

// UTF-8 bytes, as bcrypt counts them. TextEncoder rather than Buffer, so the page can count too.
export function passwordBytes(password: string): number {
  return new TextEncoder().encode(password).length;
}

const EMAIL_RULE = 'Enter a valid email address.';
const PASSWORD_RULE = `Use a password of at least ${MIN_PASSWORD_LENGTH} characters and at most ${MAX_PASSWORD_BYTES} bytes.`;
const LOGIN_PASSWORD_RULE = 'Enter your password.';
const BODY_RULE = 'Send a JSON body with an email and a password.';

// Lowercased, so Fan@example.com and fan@example.com can't become two accounts.
const email = z
  .string({ error: EMAIL_RULE })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: EMAIL_RULE }).max(254, { error: EMAIL_RULE }));

export const signupSchema = z.object(
  {
    email,
    password: z
      .string({ error: PASSWORD_RULE })
      .min(MIN_PASSWORD_LENGTH, { error: PASSWORD_RULE })
      .refine((password) => passwordBytes(password) <= MAX_PASSWORD_BYTES, {
        error: PASSWORD_RULE,
      }),
  },
  { error: BODY_RULE },
);

// No length rules here: they would tell a guesser something, and verifyPassword handles any length.
export const loginSchema = z.object(
  {
    email,
    password: z.string({ error: LOGIN_PASSWORD_RULE }).min(1, { error: LOGIN_PASSWORD_RULE }),
  },
  { error: BODY_RULE },
);

export type Credentials = z.output<typeof loginSchema>;
