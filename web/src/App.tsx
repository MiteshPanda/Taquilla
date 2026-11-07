import { useSyncExternalStore } from 'react';
import { ApiStatus } from './ApiStatus.js';
import { AuthPage } from './auth/AuthPage.js';
import { SeatMap } from './seats/SeatMap.js';
import type { Services } from './services.js';

export interface AppProps {
  services: Services;
  // Picks the demo fan and the wait between seat-map polls; tests pass their own.
  random?: () => number;
}

export function App({ services: { api, session, config }, random }: AppProps) {
  const { session: current, notice } = useSyncExternalStore(session.subscribe, session.getState);

  return (
    <main>
      <header className="masthead">
        <h1>Taquilla</h1>
        {current && (
          <div className="account">
            <span>
              Logged in as <strong>{current.email}</strong>
            </span>
            <button type="button" onClick={session.logOut}>
              Log out
            </button>
          </div>
        )}
      </header>
      <p>Match tickets that can't be sold twice.</p>
      {!current && (
        <AuthPage
          api={api}
          session={session}
          notice={notice}
          demoPassword={config.demoPassword}
          random={random}
        />
      )}
      <SeatMap api={api} random={random} />
      <ApiStatus api={api} apiUrl={config.apiUrl} />
    </main>
  );
}
