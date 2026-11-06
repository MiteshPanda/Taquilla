import { useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { ApiError } from './api/errors.js';

type ApiStatus = { kind: 'checking' } | { kind: 'up' } | { kind: 'down'; reason: string };

export interface AppProps {
  api: ApiClient;
  apiUrl: string;
}

export function App({ api, apiUrl }: AppProps) {
  const [status, setStatus] = useState<ApiStatus>({ kind: 'checking' });

  useEffect(() => {
    const controller = new AbortController();
    api.health(controller.signal).then(
      () => setStatus({ kind: 'up' }),
      (err: unknown) => {
        // React unmounted the page, or ran the effect twice in development: not a failure.
        if (controller.signal.aborted) return;
        setStatus({
          kind: 'down',
          reason: err instanceof ApiError ? err.message : 'Something went wrong.',
        });
      },
    );
    return () => controller.abort();
  }, [api]);

  return (
    <main>
      <h1>Taquilla</h1>
      <p>Match tickets that can't be sold twice.</p>
      <p className={`api-status api-status-${status.kind}`} role="status">
        {status.kind === 'checking' && `Checking the API at ${apiUrl}…`}
        {status.kind === 'up' && `The API at ${apiUrl} is up.`}
        {status.kind === 'down' && `The API at ${apiUrl} is down. ${status.reason}`}
      </p>
    </main>
  );
}
