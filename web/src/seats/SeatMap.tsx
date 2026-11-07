import { useId } from 'react';
import type { Seat } from '../api/client.js';
import { LEGEND, SEAT_VIEWS } from './seats.js';
import { StandGrid } from './StandGrid.js';
import type { SeatMapState } from './useSeatMap.js';

const NO_SEATS: ReadonlySet<number> = new Set();

const kickOff = new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeStyle: 'short' });

export interface SeatMapProps {
  map: SeatMapState;
  // The seats this fan holds, from their hold response (FR-WEB-1).
  mine?: ReadonlySet<number>;
  // Free seats the fan has picked but not yet held.
  selected?: ReadonlySet<number>;
  // Absent while seats can't be picked.
  onToggleSeat?: ((seat: Seat) => void) | undefined;
}

export function SeatMap({ map, mine = NO_SEATS, selected = NO_SEATS, onToggleSeat }: SeatMapProps) {
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
        <StandGrid
          key={stand.name}
          stand={stand}
          states={map.states}
          mine={mine}
          selected={selected}
          onToggleSeat={onToggleSeat}
        />
      ))}
    </section>
  );
}
