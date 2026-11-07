import { useSyncExternalStore } from 'react';
import { ApiStatus } from './ApiStatus.js';
import { AuthPage } from './auth/AuthPage.js';
import { Booking } from './holds/Booking.js';
import type { Services } from './services.js';

export interface AppProps {
  services: Services;
  // Picks the demo fan and the wait between seat-map polls; tests pass their own.
  random?: () => number;
}

// Taquilla's mark: the ground from above, the pitch inside the bowl.
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 30" aria-hidden="true">
      <rect x={1} y={1} width={22} height={28} rx={7} className="mark-bowl" />
      <rect x={7} y={7} width={10} height={16} rx={0.5} className="mark-pitch" />
      <path d="M7 15h10" className="mark-line" />
    </svg>
  );
}

export function App({ services: { api, session, config }, random }: AppProps) {
  const { session: current, notice } = useSyncExternalStore(session.subscribe, session.getState);

  return (
    <main>
      <header className="masthead">
        <div className="brand">
          <Mark />
          <h1>Taquilla</h1>
          <p className="tagline">Match tickets that can't be sold twice.</p>
        </div>
        {current && (
          <div className="account">
            <span>
              Logged in as <strong>{current.email}</strong>
            </span>
            <button type="button" className="secondary" onClick={session.logOut}>
              Log out
            </button>
          </div>
        )}
      </header>
      <Booking
        api={api}
        token={current?.token ?? null}
        random={random}
        intro={
          current ? null : (
            <AuthPage
              api={api}
              session={session}
              notice={notice}
              demoPassword={config.demoPassword}
              random={random}
            />
          )
        }
        footer={<ApiStatus api={api} apiUrl={config.apiUrl} />}
      />
    </main>
  );
}
