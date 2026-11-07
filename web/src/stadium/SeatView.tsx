import { memo, useId, useMemo } from 'react';
import { seatName, viewOf } from '../seats/seats.js';
import type { SeatStateMap } from '../seats/seats.js';
import { toCentreSpot, whereIs } from './venue.js';
import type { SeatSpot, VenuePlan } from './venue.js';
import { VIEW_HEIGHT, VIEW_WIDTH, viewFrom } from './viewScene.js';

export interface SeatViewProps {
  plan: VenuePlan;
  spot: SeatSpot;
  states: SeatStateMap;
  mine: ReadonlySet<number>;
  selected: ReadonlySet<number>;
}

// What a fan would see from a seat: the pitch, the other stands with tonight's crowd as sold so
// far, and the rows in front of them.
export const SeatView = memo(function SeatView({
  plan,
  spot,
  states,
  mine,
  selected,
}: SeatViewProps) {
  const id = useId();
  const shapes = useMemo(
    () =>
      viewFrom(plan, spot, (seat) =>
        viewOf(states.get(seat.id) ?? seat.state, mine.has(seat.id), selected.has(seat.id)),
      ),
    [plan, spot, states, mine, selected],
  );
  const { seat } = spot;
  const where = whereIs(spot);

  return (
    <figure className="seat-view">
      <svg
        className="seat-view-picture"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label={`The view from ${seat.section}, row ${seat.row}, seat ${seat.number}`}
      >
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#060f1c" />
            <stop offset="0.55" stopColor="#11233b" />
            <stop offset="1" stopColor="#1b3352" />
          </linearGradient>
          <radialGradient id={`${id}-haze`} cx="0.5" cy="0.35" r="0.75">
            <stop offset="0" stopColor="#dfe9f5" stopOpacity="0.16" />
            <stop offset="1" stopColor="#dfe9f5" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-near`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.62" stopColor="#050b14" stopOpacity="0" />
            <stop offset="1" stopColor="#050b14" stopOpacity="0.35" />
          </linearGradient>
          <filter id={`${id}-glow`} x="-20%" y="-200%" width="140%" height="500%">
            <feGaussianBlur stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#${id}-sky)`} />
        {shapes.map((shape, i) =>
          shape.width === undefined ? (
            <path key={i} className={`v-${shape.paint}`} d={shape.d} />
          ) : (
            <path
              key={i}
              className={`v-${shape.paint}`}
              d={shape.d}
              strokeWidth={shape.width}
              filter={shape.paint === 'light' ? `url(#${id}-glow)` : undefined}
            />
          ),
        )}
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#${id}-haze)`} />
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill={`url(#${id}-near)`} />
      </svg>
      <figcaption>
        <strong>View from {seatName(seat)}</strong>
        <span>
          {seat.section}. {where}, row {seat.row} of {spot.rows}, {toCentreSpot(spot)} m from the
          centre spot.
        </span>
      </figcaption>
    </figure>
  );
});
