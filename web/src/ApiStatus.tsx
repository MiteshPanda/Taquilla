import { useEffect, useState } from 'react';
import type { ApiClient } from './api/client.js';
import { ApiError } from './api/errors.js';

type Status = { kind: 'checking' } | { kind: 'up' } | { kind: 'down'; reason: string };

export interface ApiStatusProps {
  api: ApiClient;
  apiUrl: string;
}

// Whether the API answers /health, checked once when the page opens.
export function ApiStatus({ api, apiUrl }: ApiStatusProps) {
  const [status, setStatus] = useState<Status>({ kind: 'checking' });

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
    <p className={`api-status api-status-${status.kind}`} role="status">
      {status.kind === 'checking' && `Checking the API at ${apiUrl}…`}
      {status.kind === 'up' && `The API at ${apiUrl} is up.`}
      {status.kind === 'down' && `The API at ${apiUrl} is down. ${status.reason}`}
    </p>
  );
}
