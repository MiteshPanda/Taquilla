import { z } from 'zod';

// The login session, kept in sessionStorage and never localStorage (ADR 5): it lasts as long as
// the tab, each tab can be a different fan, and it never outlives the browser.

export const STORAGE_KEY = 'taquilla.session';

// setTimeout's longest delay. A longer one fires at once, so longer waits are taken in steps.
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface Session {
  token: string;
  email: string;
  // When the token expires, in milliseconds since 1970, read from its own claims.
  expiresAt: number;
}

// Why there's no session: 'expired' when one ended without the fan logging out.
export type SessionNotice = 'expired';

export interface SessionState {
  session: Session | null;
  notice: SessionNotice | null;
}

// Properties rather than methods, so each can be handed on alone, as useSyncExternalStore wants.
export interface SessionStore {
  getState: () => SessionState;
  // Returns a function that unsubscribes.
  subscribe: (listener: () => void) => () => void;
  // Throws if the token carries no expiry.
  logIn: (token: string, email: string) => void;
  logOut: () => void;
  // The token ran out, or the API refused it. Does nothing when no one is logged in.
  expire: () => void;
}

export type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storedSession = z.object({ token: z.string().min(1), email: z.string() });
const tokenClaims = z.object({ exp: z.number() });

// When a token expires, from its own claims. The page can't check the signature and doesn't need
// to: the API checks it on every request. This only lets the page log out on time.
export function tokenExpiry(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = tokenClaims.safeParse(JSON.parse(json));
    return claims.success ? claims.data.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// Storage can refuse to work, as when a browser blocks site data. The session then lasts only
// while the page is open, which is better than no login at all.
function attempt<T>(action: () => T): T | undefined {
  try {
    return action();
  } catch {
    return undefined;
  }
}

function readStored(storage: SessionStorage | undefined): Session | null {
  const raw = attempt(() => storage?.getItem(STORAGE_KEY));
  if (raw === undefined || raw === null) return null;
  const stored = storedSession.safeParse(attempt(() => JSON.parse(raw) as unknown));
  const expiresAt = stored.success ? tokenExpiry(stored.data.token) : undefined;
  if (!stored.success || expiresAt === undefined) {
    attempt(() => storage?.removeItem(STORAGE_KEY));
    return null;
  }
  return { ...stored.data, expiresAt };
}

export function createSessionStore(storage: SessionStorage | undefined): SessionStore {
  let state: SessionState = { session: null, notice: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();

  function set(next: SessionState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function end(notice: SessionNotice | null): void {
    clearTimeout(timer);
    timer = undefined;
    attempt(() => storage?.removeItem(STORAGE_KEY));
    set({ session: null, notice });
  }

  function expireAt(expiresAt: number): void {
    clearTimeout(timer);
    const wait = expiresAt - Date.now();
    if (wait <= 0) {
      end('expired');
      return;
    }
    timer = setTimeout(() => expireAt(expiresAt), Math.min(wait, MAX_TIMER_MS));
  }

  const restored = readStored(storage);
  if (restored !== null) {
    if (restored.expiresAt > Date.now()) {
      state = { session: restored, notice: null };
      expireAt(restored.expiresAt);
    } else {
      attempt(() => storage?.removeItem(STORAGE_KEY));
      state = { session: null, notice: 'expired' };
    }
  }

  return {
    getState: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    logIn: (token, email) => {
      const expiresAt = tokenExpiry(token);
      if (expiresAt === undefined) throw new Error('The login token carries no expiry.');
      attempt(() => storage?.setItem(STORAGE_KEY, JSON.stringify({ token, email })));
      set({ session: { token, email, expiresAt }, notice: null });
      expireAt(expiresAt);
    },

    logOut: () => end(null),

    expire: () => {
      if (state.session !== null) end('expired');
    },
  };
}
