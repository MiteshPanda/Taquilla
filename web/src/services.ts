import { createApiClient } from './api/client.js';
import type { ApiClient, Fetch } from './api/client.js';
import { createSessionStore } from './auth/session.js';
import type { SessionStorage, SessionStore } from './auth/session.js';
import { parseWebConfig } from './config.js';
import type { WebConfig } from './config.js';

export interface Services {
  config: WebConfig;
  api: ApiClient;
  session: SessionStore;
}

// The tab's sessionStorage, never localStorage (ADR 5). Where a browser blocks site data, reading
// the property itself throws, and the session then lives only in the page.
function tabStorage(win: Window): SessionStorage | undefined {
  try {
    return win.sessionStorage;
  } catch {
    return undefined;
  }
}

// What the page runs on, built once at startup. Tests pass their own window and fetch.
export function createServices(
  env: Record<string, unknown>,
  win: Window = window,
  fetch?: Fetch,
): Services {
  const config = parseWebConfig(env);
  const session = createSessionStore(tabStorage(win));
  const api = createApiClient({
    baseUrl: config.apiUrl,
    fetch,
    // Whichever request finds the token refused ends the session, so the fan lands on login.
    onUnauthorized: session.expire,
  });
  return { config, api, session };
}
