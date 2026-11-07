import { useId } from 'react';
import type { ApiClient } from '../api/client.js';
import { EVENT_ID, LEGEND, SEAT_VIEWS } from './seats.js';
import { StandGrid } from './StandGrid.js';
import { useSeatMap } from './useSeatMap.js';

const NO_SEATS: ReadonlySet<number> = new Set();

const kickOff = new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeStyle: 'short' });

export interface SeatMapProps {
  api: ApiClient;
  eventId?: number;
  // The seats this fan holds, from their hold response (FR-WEB-1); WP 7.4 passes them.
  mine?: ReadonlySet<number>;
  // Picks each wait between polls; tests pass their own.
  random?: () => number;
}

export function SeatMap({ api, eventId = EVENT_ID, mine = NO_SEATS, random }: SeatMapProps) {
  const map = useSeatMap(api, eventId, random);
  const headingId = useId();

  if (map.status === 'loading') {
    return (
      <section className="seat-map" aria-busy="true">
        <p role="status">
          {map.error === null
            ? 'Loading the seat map…'
            : `Can't load the seat map. ${map.error} Trying again…`}
        </p>
      </section>
    );
  }

  return (
    <section className="seat-map" aria-labelledby={headingId}>
      <h2 id={headingId}>{map.event.name}</h2>
      <p className="kick-off">{kickOff.format(new Date(map.event.startsAt))}</p>
      <ul className="legend" aria-label="Key">
        {SEAT_VIEWS.map((view) => (
          <li key={view}>
            <span className={`seat seat-${view}`} aria-hidden="true" />
            {LEGEND[view]}
          </li>
        ))}
      </ul>
      {map.refreshError !== null && (
        <p className="refresh-error" role="status">
          The seat map may be out of date. {map.refreshError} Trying again…
        </p>
      )}
      {map.stands.map((stand) => (
        <StandGrid key={stand.name} stand={stand} states={map.states} mine={mine} />
      ))}
    </section>
  );
}
