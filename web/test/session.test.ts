import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore, STORAGE_KEY, tokenExpiry } from '../src/auth/session.js';
import { makeToken, memoryStorage } from './helpers.js';

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const HOUR = 3_600_000;
const EMAIL = 'fan7@taquilla.test';

function stored(token: string, email = EMAIL): Record<string, string> {
  return { [STORAGE_KEY]: JSON.stringify({ token, email }) };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('tokenExpiry', () => {
  it("reads the token's exp in milliseconds, also when its encoding has - and _", () => {
    // These claims encode to base64 with + and /, which base64url writes as - and _.
    const token = makeToken(NOW + HOUR, { note: '>>>???' });
    expect(token.split('.')[1]).toMatch(/[-_]/);

    expect(tokenExpiry(token)).toBe(NOW + HOUR);
  });

  it.each([
    ['no payload', 'just-one-part'],
    ['a payload that is not base64', 'a.%%%.c'],
    ['a payload that is not JSON', `a.${btoa('not json')}.c`],
    ['no exp', `a.${btoa(JSON.stringify({ sub: '7' }))}.c`],
    ['an exp that is not a number', `a.${btoa(JSON.stringify({ exp: 'soon' }))}.c`],
  ])('gives undefined for a token with %s', (_case, token) => {
    expect(tokenExpiry(token)).toBeUndefined();
  });
});

describe('a new page', () => {
  it('starts logged out with nothing stored', () => {
    const store = createSessionStore(memoryStorage().storage);

    expect(store.getState()).toEqual({ session: null, notice: null });
  });

  it('picks up the session the tab stored, and ends it when the token expires', () => {
    const token = makeToken(NOW + HOUR);
    const { storage, items } = memoryStorage(stored(token));
    const store = createSessionStore(storage);

    expect(store.getState()).toEqual({
      session: { token, email: EMAIL, expiresAt: NOW + HOUR },
      notice: null,
    });

    vi.advanceTimersByTime(HOUR - 1);
    expect(store.getState().session).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(store.getState()).toEqual({ session: null, notice: 'expired' });
    expect(items.has(STORAGE_KEY)).toBe(false);
  });

  it('drops a stored token that has already expired, and says so', () => {
    const { storage, items } = memoryStorage(stored(makeToken(NOW - 1)));
    const store = createSessionStore(storage);

    expect(store.getState()).toEqual({ session: null, notice: 'expired' });
    expect(items.has(STORAGE_KEY)).toBe(false);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['JSON with no token', JSON.stringify({ email: EMAIL })],
    ['a token with no expiry', JSON.stringify({ token: 'a.b.c', email: EMAIL })],
  ])('quietly drops %s', (_case, value) => {
    const { storage, items } = memoryStorage({ [STORAGE_KEY]: value });
    const store = createSessionStore(storage);

    expect(store.getState()).toEqual({ session: null, notice: null });
    expect(items.has(STORAGE_KEY)).toBe(false);
  });
});

describe('logging in and out', () => {
  it('stores the token and email for this tab, and tells subscribers', () => {
    const { storage, items } = memoryStorage();
    const store = createSessionStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    const token = makeToken(NOW + HOUR);

    store.logIn(token, EMAIL);

    expect(store.getState()).toEqual({
      session: { token, email: EMAIL, expiresAt: NOW + HOUR },
      notice: null,
    });
    expect(JSON.parse(items.get(STORAGE_KEY) ?? 'null')).toEqual({ token, email: EMAIL });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears the notice of an earlier expiry', () => {
    const store = createSessionStore(memoryStorage(stored(makeToken(NOW - 1))).storage);

    store.logIn(makeToken(NOW + HOUR), EMAIL);

    expect(store.getState().notice).toBeNull();
  });

  it('refuses a token with no expiry, and stores nothing', () => {
    const { storage, items } = memoryStorage();
    const store = createSessionStore(storage);

    expect(() => store.logIn('a.b.c', EMAIL)).toThrow(/no expiry/);
    expect(store.getState().session).toBeNull();
    expect(items.size).toBe(0);
  });

  it('logs out without a notice, and the old timer no longer fires', () => {
    const { storage, items } = memoryStorage();
    const store = createSessionStore(storage);
    store.logIn(makeToken(NOW + HOUR), EMAIL);

    store.logOut();
    vi.advanceTimersByTime(2 * HOUR);

    expect(store.getState()).toEqual({ session: null, notice: null });
    expect(items.size).toBe(0);
  });

  it('keeps only the latest timer when a fan logs in again', () => {
    const store = createSessionStore(memoryStorage().storage);
    store.logIn(makeToken(NOW + HOUR), EMAIL);
    store.logIn(makeToken(NOW + 3 * HOUR), 'fan8@taquilla.test');

    vi.advanceTimersByTime(2 * HOUR);

    expect(store.getState().session?.email).toBe('fan8@taquilla.test');
  });

  it('stops telling a subscriber once it unsubscribes', () => {
    const store = createSessionStore(memoryStorage().storage);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    store.logIn(makeToken(NOW + HOUR), EMAIL);

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('expiry', () => {
  it('ends a refused session with a notice, and does nothing when no one is logged in', () => {
    const { storage, items } = memoryStorage();
    const store = createSessionStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);

    store.expire();
    expect(store.getState()).toEqual({ session: null, notice: null });
    expect(listener).not.toHaveBeenCalled();

    store.logIn(makeToken(NOW + HOUR), EMAIL);
    store.expire();
    expect(store.getState()).toEqual({ session: null, notice: 'expired' });
    expect(items.size).toBe(0);
  });

  it("waits out a token longer than setTimeout's limit in steps of that limit", () => {
    const thirtyDays = 30 * 24 * HOUR;
    const limit = 2 ** 31 - 1;
    const store = createSessionStore(memoryStorage().storage);
    store.logIn(makeToken(NOW + thirtyDays), EMAIL);

    // A longer delay would fire at once, and keep firing every millisecond for 30 days.
    vi.advanceTimersToNextTimer();
    expect(Date.now() - NOW).toBe(limit);
    expect(store.getState().session).not.toBeNull();

    vi.advanceTimersByTime(thirtyDays - limit);
    expect(store.getState().notice).toBe('expired');
  });
});

describe('a browser that blocks storage', () => {
  it('still logs in, for as long as the page stays open', () => {
    const { storage, block } = memoryStorage();
    block();
    const store = createSessionStore(storage);
    const token = makeToken(NOW + HOUR);

    store.logIn(token, EMAIL);
    expect(store.getState().session?.token).toBe(token);

    store.logOut();
    expect(store.getState().session).toBeNull();
  });

  it('starts logged out when there is no storage at all', () => {
    expect(createSessionStore(undefined).getState()).toEqual({ session: null, notice: null });
  });
});
