// The rules the API and the web page's forms share (api/src/auth/rules.ts). The routes' behaviour
// is in auth.test.ts; this checks what the move to a Node-free file could have changed.
import { describe, expect, it } from 'vitest';
import { loginSchema, MAX_PASSWORD_BYTES, passwordBytes, signupSchema } from '../src/auth/rules.js';

describe('passwordBytes', () => {
  it.each([
    ['plain ASCII', 'correct horse battery'],
    ['two-byte letters', 'contraseña-é'],
    ['three-byte symbols', '€€€₹₹'],
    ['four-byte emoji', '🎟️⚽🏟️'],
    ['a lone surrogate, which both count as the 3-byte replacement character', 'a\uD800b'],
    ['nothing', ''],
  ])('counts %s as Buffer does', (_case, password) => {
    expect(passwordBytes(password)).toBe(Buffer.byteLength(password, 'utf8'));
  });
});

describe('the sign-up rule', () => {
  it('allows exactly 72 bytes, counted as UTF-8: 24 € signs, but not 25', () => {
    expect(MAX_PASSWORD_BYTES).toBe(72);
    const email = 'fan@taquilla.test';

    expect(signupSchema.safeParse({ email, password: '€'.repeat(24) }).success).toBe(true);
    expect(signupSchema.safeParse({ email, password: '€'.repeat(25) }).success).toBe(false);
  });

  it('trims and lowercases the email, for both sign-up and login', () => {
    const body = { email: '  Fan@Taquilla.TEST ', password: 'correct horse' };

    expect(signupSchema.parse(body).email).toBe('fan@taquilla.test');
    expect(loginSchema.parse(body).email).toBe('fan@taquilla.test');
  });
});
