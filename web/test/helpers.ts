import type { Fetch } from '../src/api/client.js';
import type { SessionStorage } from '../src/auth/session.js';

export interface Call {
  url: string;
  init: RequestInit;
}

// A fetch that records each call and answers it with `answer`.
export function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetch };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// The JSON body a call sent.
export function bodyOf(call: Call | undefined): unknown {
  return typeof call?.init.body === 'string' ? JSON.parse(call.init.body) : undefined;
}

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A token shaped like the API's, expiring at `expiresAt` (milliseconds). The page never checks
// the signature, so a fake one does. `extra` claims can force - and _ into the encoding.
export function makeToken(expiresAt: number, extra: Record<string, unknown> = {}): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ sub: '7', exp: Math.floor(expiresAt / 1000), ...extra }),
  );
  return `${header}.${payload}.c2lnbmF0dXJl`;
}

// A Storage kept in a Map, which can also be made to throw, as a browser blocking site data does.
export function memoryStorage(entries: Record<string, string> = {}) {
  const items = new Map(Object.entries(entries));
  let blocked = false;
  const guard = () => {
    if (blocked) throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  const storage: SessionStorage = {
    getItem: (key) => {
      guard();
      return items.get(key) ?? null;
    },
    setItem: (key, value) => {
      guard();
      items.set(key, value);
    },
    removeItem: (key) => {
      guard();
      items.delete(key);
    },
  };
  return {
    storage,
    items,
    block: () => {
      blocked = true;
    },
  };
}
