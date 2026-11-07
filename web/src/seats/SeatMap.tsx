import { useCallback, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Seat } from '../api/client.js';
import { Ground, PLAN_BOX } from '../stadium/Ground.js';
import { SeatView } from '../stadium/SeatView.js';
import { planOf, sideOf } from '../stadium/venue.js';
import type { SeatSpot } from '../stadium/venue.js';
import { LEGEND, SEAT_VIEWS, viewOf } from './seats.js';
import type { Stand } from './seats.js';
import { StandGrid } from './StandGrid.js';
import { StandTabs } from './StandTabs.js';
import type { SeatMapState } from './useSeatMap.js';

const NO_SEATS: ReadonlySet<number> = new Set();
const NO_STANDS: readonly Stand[] = [];

const kickOff = new Intl.DateTimeFormat('en-IN', { dateStyle: 'full', timeStyle: 'short' });

export interface SeatMapProps {
  map: SeatMapState;
  // The seats this fan holds, from their hold response (FR-WEB-1).
  mine?: ReadonlySet<number>;
  // Free seats the fan has picked but not yet held.
  selected?: ReadonlySet<number>;
  // Absent while seats can't be picked.
  onToggleSeat?: ((seat: Seat) => void) | undefined;
  // Shown under the match's name, such as the login form.
  intro?: ReactNode;
  // The end of the side column, such as the fan's picks and hold.
  children?: ReactNode;
}

// The ground from above beside one stand's seats. The plan marks the fan's seats and shows the
// view from the seat pointed at or picked last; the stand's grid is where seats are picked.
export function SeatMap({
  map,
  mine = NO_SEATS,
  selected = NO_SEATS,
  onToggleSeat,
  intro,
  children,
}: SeatMapProps) {
  const headingId = useId();
  const tabsId = useId();
  const ready = map.status === 'ready';
  const stands = ready ? map.stands : NO_STANDS;
  const states = ready ? map.states : null;
  const plan = useMemo(() => planOf(stands), [stands]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [pointedId, setPointedId] = useState<number | null>(null);

  const active = stands.find((stand) => stand.name === chosen) ?? stands[0];
  const pointed = pointedId === null ? null : (plan.byId.get(pointedId) ?? null);
  // The view shown: the seat pointed at, else the newest pick, else the first seat held.
  const newest = [...selected].at(-1) ?? [...mine].at(0);
  const viewed = pointed ?? (newest === undefined ? null : (plan.byId.get(newest) ?? null));

  const point = useCallback((spot: SeatSpot | null) => setPointedId(spot?.seat.id ?? null), []);
  const choose = useCallback(
    (spot: SeatSpot, pick: boolean) => {
      setChosen(spot.seat.section);
      setPointedId(spot.seat.id);
      if (!pick || onToggleSeat === undefined || states === null) return;
      const view = viewOf(
        states.get(spot.seat.id) ?? spot.seat.state,
        mine.has(spot.seat.id),
        selected.has(spot.seat.id),
      );
      if (view === 'available' || view === 'selected') onToggleSeat(spot.seat);
    },
    [onToggleSeat, states, mine, selected],
  );

  return (
    <div className="seat-map" aria-busy={ready ? undefined : true}>
      <div className="ground">
        <div
          className="ground-frame"
          style={{ aspectRatio: `${PLAN_BOX.width} / ${PLAN_BOX.height}` }}
        >
          <Ground
            plan={plan}
            states={states}
            mine={mine}
            selected={selected}
            activeSide={active === undefined ? null : (sideOf(active.name) ?? null)}
            pointed={pointed}
            viewed={viewed}
            onPoint={point}
            onChoose={choose}
          />
          {viewed !== null && states !== null ? (
            <SeatView plan={plan} spot={viewed} states={states} mine={mine} selected={selected} />
          ) : (
            ready && <p className="ground-hint">Point at a seat, or pick one, to see its view.</p>
          )}
        </div>
      </div>

      <div className="side">
        {map.status === 'loading' ? (
          <p className="map-loading" role="status">
            {map.error === null
              ? 'Loading the seat map…'
              : `Can't load the seat map. ${map.error} Trying again…`}
          </p>
        ) : (
          <header className="match">
            <h2 id={headingId}>{map.event.name}</h2>
            <p className="kick-off">{kickOff.format(new Date(map.event.startsAt))}</p>
          </header>
        )}
        {intro}
        {map.status === 'ready' && active !== undefined && (
          <section className="stands" aria-labelledby={headingId}>
            {map.refreshError !== null && (
              <p className="refresh-error" role="status">
                The seat map may be out of date. {map.refreshError} Trying again…
              </p>
            )}
            <StandTabs
              stands={map.stands}
              active={active}
              states={map.states}
              idBase={tabsId}
              onChoose={setChosen}
            />
            <ul className="legend" aria-label="Key">
              {SEAT_VIEWS.map((view) => (
                <li key={view}>
                  <span className={`seat seat-${view}`} aria-hidden="true" />
                  {LEGEND[view]}
                </li>
              ))}
            </ul>
            <div
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-tab-${map.stands.indexOf(active)}`}
              className="stand"
            >
              <StandGrid
                key={active.name}
                stand={active}
                states={map.states}
                mine={mine}
                selected={selected}
                onToggleSeat={onToggleSeat}
                onPoint={setPointedId}
              />
            </div>
          </section>
        )}
        {children}
      </div>
    </div>
  );
}
