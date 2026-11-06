// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { STORAGE_KEY } from '../src/auth/session.js';
import { createServices } from '../src/services.js';
import { fakeFetch, json, makeToken } from './helpers.js';

const HOUR = 3_600_000;
const REFUSED = {
  error: { code: 'UNAUTHORIZED', message: 'Your session is invalid or has expired. Log in again.' },
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('createServices', () => {
  it('keeps the session in sessionStorage and never in localStorage (ADR 5)', () => {
    const { session } = createServices({});
    const token = makeToken(Date.now() + HOUR);

    session.logIn(token, 'fan7@taquilla.test');

    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ token, email: 'fan7@taquilla.test' }),
    );
    expect(localStorage.length).toBe(0);
  });

  it('ends the session, with a notice, when the API refuses its token', async () => {
    const { fetch } = fakeFetch(() => json(401, REFUSED));
    const { api, session } = createServices({}, window, fetch);
    const token = makeToken(Date.now() + HOUR);
    session.logIn(token, 'fan7@taquilla.test');

    await expect(api.request('/orders/x', z.unknown(), { token })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    expect(session.getState()).toEqual({ session: null, notice: 'expired' });
    expect(sessionStorage.length).toBe(0);
  });

  it('still logs in where the browser blocks sessionStorage', () => {
    const blocked = {
      get sessionStorage(): Storage {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    } as unknown as Window;
    const { session } = createServices({}, blocked);

    session.logIn(makeToken(Date.now() + HOUR), 'fan7@taquilla.test');

    expect(session.getState().session?.email).toBe('fan7@taquilla.test');
  });

  it('builds the client from the configuration', async () => {
    const { calls, fetch } = fakeFetch(() => json(200, { status: 'ok' }));
    const { api, config } = createServices(
      { VITE_API_URL: 'https://tickets.example/api/', VITE_DEMO_PASSWORD: 'demo-pass' },
      window,
      fetch,
    );

    await api.health();

    expect(config).toEqual({ apiUrl: 'https://tickets.example/api', demoPassword: 'demo-pass' });
    expect(calls[0]?.url).toBe('https://tickets.example/api/health');
  });
});
