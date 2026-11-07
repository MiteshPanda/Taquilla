import { useCallback, useEffect, useRef, useState } from 'react';
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
      seatsById: ReadonlyMap<number, Seat>;
      states: SeatStateMap;
      // The last poll failed, so the states shown may be out of date.
      refreshError: string | null;
    };

export interface SeatMapHandle {
  map: SeatMapState;
  // Polls now rather than at the next turn, as after a hold, a release or a seat just taken.
  refresh: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong.';
}

// Loads the full map once, then polls only the seat states (FR-SEAT-5), pausing while the tab
// is hidden and catching up the moment it's shown again.
export function useSeatMap(
  api: ApiClient,
  eventId: number,
  random: () => number = Math.random,
): SeatMapHandle {
  const [map, setMap] = useState<SeatMapState>({ status: 'loading', error: null });
  const refreshNow = useRef<() => void>(() => undefined);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let seats: readonly Seat[] | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let paused = false;
    let inFlight = false;
    let refreshWhenDone = false;

    function schedule(wait: number) {
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), wait);
    }

    async function tick() {
      if (document.hidden) {
        paused = true;
        return;
      }
      inFlight = true;
      try {
        if (seats === null) {
          const loaded = await api.seatMap(eventId, signal);
          seats = loaded.seats;
          setMap({
            status: 'ready',
            event: loaded.event,
            stands: standsOf(loaded.seats),
            seatsById: new Map(loaded.seats.map((seat) => [seat.id, seat])),
            states: statesOf(loaded.seats),
            refreshError: null,
          });
        } else {
          const states = statesFrom(seats, await api.seatStates(eventId, signal));
          // Unchanged seats keep the same object, so nothing re-renders between sales.
          setMap((current) =>
            current.status !== 'ready' ||
            (current.refreshError === null && sameStates(current.states, states))
              ? current
              : { ...current, states, refreshError: null },
          );
        }
      } catch (err) {
        if (signal.aborted) return;
        const message = messageOf(err);
        setMap((current) =>
          current.status === 'ready'
            ? { ...current, refreshError: message }
            : { status: 'loading', error: message },
        );
      } finally {
        inFlight = false;
      }
      if (signal.aborted) return;
      if (refreshWhenDone) {
        // A refresh asked for while this poll was out may be about a change it missed.
        refreshWhenDone = false;
        void tick();
        return;
      }
      schedule(POLL_MIN_MS + random() * (POLL_MAX_MS - POLL_MIN_MS));
    }

    refreshNow.current = () => {
      if (signal.aborted || paused) return;
      if (inFlight) {
        refreshWhenDone = true;
        return;
      }
      clearTimeout(timer);
      void tick();
    };

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
      refreshNow.current = () => undefined;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [api, eventId, random]);

  const refresh = useCallback(() => refreshNow.current(), []);
  return { map, refresh };
}
