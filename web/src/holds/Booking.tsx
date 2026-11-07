import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiClient, Hold, Seat } from '../api/client.js';
import { ApiError } from '../api/errors.js';
import type { PayOptions } from '../checkout/pay.js';
import { SeatMap } from '../seats/SeatMap.js';
import {
  describeSeats,
  EVENT_ID,
  formatPrice,
  MAX_HOLD_SEATS,
  takenMessage,
} from '../seats/seats.js';
import type { SeatStateMap } from '../seats/seats.js';
import { useSeatMap } from '../seats/useSeatMap.js';
import { HoldPanel } from './HoldPanel.js';
import { FULL, UNEXPECTED } from './messages.js';
import type { Notice } from './messages.js';
import { EMPTY_SELECTION, selectionReducer } from './selection.js';

// A hold belongs to the fan whose token made it, so another login or a logout hides it.
interface OwnHold {
  token: string;
  hold: Hold;
}

// The key for one hold attempt, kept while the same seats are tried again, so a retry after a
// lost answer gets the first hold back instead of colliding with it.
interface Attempt {
  seats: string;
  key: string;
}

// The same request sent again could still succeed, or be answered from the first one.
function worthRetrying(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return (
    err.status === 0 ||
    err.status >= 500 ||
    err.code === 'BAD_RESPONSE' ||
    err.code === 'SEAT_BUSY' ||
    err.code === 'REQUEST_IN_PROGRESS'
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface BookingProps {
  api: ApiClient;
  // The logged-in fan's token, or null, in which case seats can be picked but not held.
  token: string | null;
  // Picks the wait between seat-map polls; tests pass their own.
  random?: (() => number) | undefined;
  // Makes each hold and payment attempt's Idempotency-Key; tests pass their own.
  newKey?: () => string;
  // Waits between payment tries while the first is still running; tests pass their own.
  wait?: PayOptions['wait'];
  // Shown under the match's name, such as the login form, and at the foot of the page.
  intro?: ReactNode;
  footer?: ReactNode;
}

// The seat map and what the fan does with it: pick up to 6 seats, hold them, watch the hold count
// down, release it or pay for it (FR-WEB-2, FR-WEB-3, FR-WEB-5).
export function Booking({
  api,
  token,
  random,
  newKey = () => crypto.randomUUID(),
  wait,
  intro,
  footer,
}: BookingProps) {
  const { map, refresh } = useSeatMap(api, EVENT_ID, random);
  const [selection, dispatch] = useReducer(selectionReducer, EMPTY_SELECTION);
  const [ownHold, setOwnHold] = useState<OwnHold | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<Attempt | null>(null);

  // The latest seat states, for the seat click handler, which stays the same function so the
  // 2,000 seat buttons don't re-render on every click.
  const states = map.status === 'ready' ? map.states : null;
  const latestStates = useRef<SeatStateMap | null>(null);
  useEffect(() => {
    latestStates.current = states;
  }, [states]);

  const hold = ownHold !== null && ownHold.token === token ? ownHold.hold : null;
  const seatsById = map.status === 'ready' ? map.seatsById : new Map<number, Seat>();
  const seatsOf = (ids: readonly number[]) =>
    ids.map((id) => seatsById.get(id)).filter((seat) => seat !== undefined);

  // Picked seats still free; one someone else has just taken drops out. Both sets stay the same
  // objects until the selection, the seat states or the hold change, so the stands only redraw
  // when they must.
  const selected = useMemo(
    () => new Set(selection.seatIds.filter((id) => states?.get(id) === 'available')),
    [selection.seatIds, states],
  );
  const picked = [...selected];
  const mine = useMemo(() => new Set(hold?.seatIds), [hold]);
  const pickedSeats = seatsOf(picked);
  const pickedTotal = pickedSeats.reduce((sum, seat) => sum + seat.pricePaise, 0);

  const toggleSeat = useCallback((seat: Seat) => {
    setNotice(null);
    dispatch({
      type: 'toggle',
      seatId: seat.id,
      isFree: (id) => latestStates.current?.get(id) === 'available',
    });
  }, []);

  // The hold is over: expired, released, gone, or paid for and put away.
  const onHoldEnd = useCallback((next: Notice | null) => {
    setOwnHold(null);
    setNotice(next);
  }, []);

  async function holdPicked() {
    if (token === null || picked.length === 0) return;
    const seats = [...picked].sort((a, b) => a - b).join(',');
    if (attempt.current?.seats !== seats) attempt.current = { seats, key: newKey() };
    const { key } = attempt.current;

    setPending(true);
    setNotice(null);
    try {
      const made = await api.holdSeats(EVENT_ID, picked, token, key);
      attempt.current = null;
      setOwnHold({ token, hold: made });
      dispatch({ type: 'clear' });
    } catch (err) {
      if (!worthRetrying(err)) attempt.current = null;
      if (err instanceof ApiError && err.code === 'SEAT_TAKEN') {
        // FR-WEB-5: name the seats, in the fan's terms, and let them pick again.
        const taken = seatsOf(err.seatIds);
        setNotice({ role: 'alert', text: taken.length > 0 ? takenMessage(taken) : err.message });
        dispatch({ type: 'remove', seatIds: err.seatIds });
      } else {
        setNotice({ role: 'alert', text: err instanceof ApiError ? err.message : UNEXPECTED });
      }
    } finally {
      setPending(false);
      refresh();
    }
  }

  return (
    <SeatMap
      map={map}
      mine={mine}
      selected={selected}
      // One hold at a time: seats can't be picked while one is running.
      onToggleSeat={hold === null ? toggleSeat : undefined}
      intro={intro}
    >
      <section className="hold-bar" aria-label="Your seats">
        {notice !== null && (
          <p className={`hold-notice hold-notice-${notice.role}`} role={notice.role}>
            {notice.text}
          </p>
        )}
        {hold !== null && token !== null ? (
          <HoldPanel
            key={hold.holdId}
            api={api}
            token={token}
            hold={hold}
            seats={seatsOf(hold.seatIds)}
            newKey={newKey}
            refresh={refresh}
            onEnd={onHoldEnd}
            wait={wait}
          />
        ) : picked.length > 0 ? (
          <>
            <div className="stub-line">
              <p className="stub-seats">
                {plural(picked.length, 'seat', 'seats')} selected: {describeSeats(pickedSeats)}
              </p>
              <p className="stub-figure">{formatPrice(pickedTotal)}</p>
            </div>
            {selection.full && <p role="status">{FULL}</p>}
            <div className="actions">
              {token === null ? (
                <p className="stub-login">Log in to hold them.</p>
              ) : (
                <button type="button" onClick={() => void holdPicked()} disabled={pending}>
                  {pending ? 'Holding…' : `Hold ${plural(picked.length, 'seat', 'seats')}`}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => dispatch({ type: 'clear' })}
                disabled={pending}
              >
                Clear
              </button>
            </div>
          </>
        ) : (
          <p className="stub-empty">Pick up to {MAX_HOLD_SEATS} seats on the map.</p>
        )}
      </section>
      {footer}
    </SeatMap>
  );
}
