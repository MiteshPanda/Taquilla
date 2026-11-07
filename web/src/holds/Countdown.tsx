import { useEffect, useState } from 'react';

const TICK_MS = 500;

export interface CountdownProps {
  // When the hold expires, as the API sent it (FR-WEB-2).
  expiresAt: string;
  // Called once the time is up.
  onExpire: () => void;
}

// m:ss, rounded up, so the last second shows 0:01 rather than 0:00.
export function formatLeft(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Counts down on this device's clock. The API decides when a hold has really lapsed, so a clock
// that's a little off only moves when the page says so.
export function Countdown({ expiresAt, onExpire }: CountdownProps) {
  const end = Date.parse(expiresAt);
  const [left, setLeft] = useState(() => end - Date.now());

  useEffect(() => {
    const timer = setInterval(() => setLeft(end - Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [end]);

  const expired = left <= 0;
  useEffect(() => {
    if (expired) onExpire();
  }, [expired, onExpire]);

  return (
    <p className="countdown">
      <span role="timer">{formatLeft(left)}</span> left on your hold
      {/* role="timer" isn't read out as it changes, so the last minute is announced once. */}
      <span className="visually-hidden" aria-live="polite">
        {left <= 60_000 ? 'One minute left on your hold.' : ''}
      </span>
    </p>
  );
}
