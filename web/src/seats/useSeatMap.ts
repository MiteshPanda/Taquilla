import { useEffect, useState } from 'react';
import type { ApiClient, Seat, SeatMapData } from '../api/client.js';
import { ApiError } from '../api/errors.js';
import { sameStates, standsOf, statesFrom, statesOf } from './seats.js';
import type { SeatStateMap, Stand } from './seats.js';

// FR-WEB-4: the map refreshes every 2 to 3 seconds. The wait is random within that window, so
// 1,000 fans who opened the page together don't keep polling in the same instant.
export const POLL_MIN_MS = 2_000;
export const POLL_MAX_MS = 3_000;

export type SeatMapState =
  // `error` is the last failed attempt; the hook keeps trying.
  | { status: 'loading'; error: string | null }
  | {
      status: 'ready';
      event: SeatMapData['event'];
      stands: readonly Stand[];
      states: SeatStateMap;
      // The last poll failed, so the states shown may be out of date.
      refreshError: string | null;
    };

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong.';
}

// Loads the full map once, then polls only the seat states (FR-SEAT-5), pausing while the tab
// is hidden and catching up the moment it's shown again.
export function useSeatMap(
  api: ApiClient,
  eventId: number,
  random: () => number = Math.random,
): SeatMapState {
  const [state, setState] = useState<SeatMapState>({ status: 'loading', error: null });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let seats: readonly Seat[] | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let paused = false;

    function schedule() {
      const wait = POLL_MIN_MS + random() * (POLL_MAX_MS - POLL_MIN_MS);
      timer = setTimeout(() => void tick(), wait);
    }

    async function tick() {
      if (document.hidden) {
        paused = true;
        return;
      }
      try {
        if (seats === null) {
          const map = await api.seatMap(eventId, signal);
          seats = map.seats;
          setState({
            status: 'ready',
            event: map.event,
            stands: standsOf(map.seats),
            states: statesOf(map.seats),
            refreshError: null,
          });
        } else {
          const states = statesFrom(seats, await api.seatStates(eventId, signal));
          // Unchanged seats keep the same object, so nothing re-renders between sales.
          setState((current) =>
            current.status !== 'ready' ||
            (current.refreshError === null && sameStates(current.states, states))
              ? current
              : { ...current, states, refreshError: null },
          );
        }
      } catch (err) {
        if (signal.aborted) return;
        const message = messageOf(err);
        setState((current) =>
          current.status === 'ready'
            ? { ...current, refreshError: message }
            : { status: 'loading', error: message },
        );
      }
      if (!signal.aborted) schedule();
    }

    function onVisibilityChange() {
      if (!document.hidden && paused) {
        paused = false;
        void tick();
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [api, eventId, random]);

  return state;
}
