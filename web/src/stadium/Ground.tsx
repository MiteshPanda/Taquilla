import { memo, useId, useMemo, useRef } from 'react';
import { seatName, viewOf } from '../seats/seats.js';
import type { SeatStateMap } from '../seats/seats.js';
import { crowdTone } from './viewScene.js';
import {
  FRAMES,
  GOAL,
  PITCH,
  RUN_OFF,
  STAND_DEPTH,
  STRIPES,
  pitchLines,
  pitchSpots,
  spotAt,
} from './venue.js';
import type { Point2, SeatSpot, Side, StandPlan, VenuePlan } from './venue.js';

// The ground from above, as in an aerial photograph at night: every seat drawn in its state, so
// the bowl fills with a crowd as the match sells, and the fan's own seats lifted out of it.

const ENDS = PITCH.halfLength + RUN_OFF;
const SIDES = PITCH.halfWidth + RUN_OFF;
const OUTER_X = SIDES + STAND_DEPTH;
const OUTER_Y = ENDS + STAND_DEPTH;
const RIM = 6;
const BOX_X = OUTER_X + RIM + 2;
// Room above the top stand for a lifted seat's label.
const BOX_Y = OUTER_Y + RIM + 6;
// The plan's frame, in metres, with the centre spot in the middle.
export const PLAN_BOX = { x: -BOX_X, y: -BOX_Y, width: 2 * BOX_X, height: 2 * BOX_Y } as const;

type CellPaint = 'open' | 'held' | 'picked' | 'crowd-0' | 'crowd-1' | 'crowd-2' | 'crowd-3';

function fixed(n: number): string {
  return String(Math.round(n * 100) / 100);
}

// The plan's y runs down the page, the ground's north.
function flip({ x, y }: Point2): Point2 {
  return { x, y: -y };
}

// Each seat as a block, grouped by how it's painted, one path per paint.
function cellPaths(
  stand: StandPlan,
  paintOf: (spot: SeatSpot) => CellPaint,
): Partial<Record<CellPaint, string>> {
  const paths: Partial<Record<CellPaint, string>> = {};
  const endOn = stand.side === 'north' || stand.side === 'south';
  for (const row of stand.rows) {
    for (const spot of row) {
      const w = (endOn ? spot.along : spot.across) * (endOn ? 0.74 : 0.6);
      const h = (endOn ? spot.across : spot.along) * (endOn ? 0.6 : 0.8);
      const { x, y } = flip(spot.at);
      const paint = paintOf(spot);
      paths[paint] =
        (paths[paint] ?? '') +
        `M${fixed(x - w / 2)} ${fixed(y - h / 2)}h${fixed(w)}v${fixed(h)}h${fixed(-w)}Z`;
    }
  }
  return paths;
}

// A stand's outline on the plan.
function standBox(side: Side) {
  const { front, halfSpan } = FRAMES[side];
  switch (side) {
    case 'north':
      return { x: -halfSpan, y: -(front + STAND_DEPTH), width: 2 * halfSpan, height: STAND_DEPTH };
    case 'south':
      return { x: -halfSpan, y: front, width: 2 * halfSpan, height: STAND_DEPTH };
    case 'east':
      return { x: front, y: -halfSpan, width: STAND_DEPTH, height: 2 * halfSpan };
    case 'west':
      return { x: -(front + STAND_DEPTH), y: -halfSpan, width: STAND_DEPTH, height: 2 * halfSpan };
  }
}

const LABELS: Record<Side, { x: number; y: number; rotate: number }> = {
  north: { x: 0, y: -(OUTER_Y + RIM / 2), rotate: 0 },
  south: { x: 0, y: OUTER_Y + RIM / 2, rotate: 0 },
  east: { x: OUTER_X + RIM / 2, y: 0, rotate: 90 },
  west: { x: -(OUTER_X + RIM / 2), y: 0, rotate: -90 },
};

// Roof trusses every few metres round the rim, as in the photograph.
function trusses(): string {
  let d = '';
  const step = 7;
  for (let x = -OUTER_X + 6; x <= OUTER_X - 6; x += step) {
    d += `M${fixed(x)} ${-OUTER_Y}v${-RIM}M${fixed(x)} ${OUTER_Y}v${RIM}`;
  }
  for (let y = -OUTER_Y + 6; y <= OUTER_Y - 6; y += step) {
    d += `M${-OUTER_X} ${fixed(y)}h${-RIM}M${OUTER_X} ${fixed(y)}h${RIM}`;
  }
  return d;
}

// The markings, drawn once: they never change.
const MARKINGS = pitchLines()
  .map((line) =>
    line.map((point, i) => `${i === 0 ? 'M' : 'L'}${fixed(point.x)} ${fixed(-point.y)}`).join(''),
  )
  .join('');
const STRIPE_PATH = Array.from({ length: Math.floor(STRIPES / 2) }, (_, k) => {
  const band = (2 * PITCH.halfLength) / STRIPES;
  const y = -PITCH.halfLength + (2 * k + 1) * band;
  return `M${-PITCH.halfWidth} ${fixed(y)}h${2 * PITCH.halfWidth}v${fixed(band)}h${-2 * PITCH.halfWidth}Z`;
}).join('');
const TRUSSES = trusses();

export interface GroundProps {
  plan: VenuePlan;
  // Null while the map loads: the ground is drawn empty.
  states: SeatStateMap | null;
  mine: ReadonlySet<number>;
  selected: ReadonlySet<number>;
  // The stand shown beside the plan, outlined on it.
  activeSide: Side | null;
  // The seat under the pointer, ringed, and the seat whose view is shown, with a line to it.
  pointed: SeatSpot | null;
  viewed: SeatSpot | null;
  onPoint: (spot: SeatSpot | null) => void;
  // A click on a seat. A mouse picks it; a finger, too small for a seat, only shows its stand.
  onChoose: (spot: SeatSpot, pick: boolean) => void;
}

export const Ground = memo(function Ground({
  plan,
  states,
  mine,
  selected,
  activeSide,
  pointed,
  viewed,
  onPoint,
  onChoose,
}: GroundProps) {
  const id = useId();
  const pointer = useRef<string>('mouse');

  const cells = useMemo(() => {
    if (states === null) return [];
    const paintOf = (spot: SeatSpot): CellPaint => {
      const view = viewOf(
        states.get(spot.seat.id) ?? spot.seat.state,
        mine.has(spot.seat.id),
        selected.has(spot.seat.id),
      );
      if (view === 'available') return 'open';
      if (view === 'held') return 'held';
      if (view === 'sold') return `crowd-${crowdTone(spot.seat.id)}`;
      return 'picked';
    };
    return plan.stands.map((stand) => ({ side: stand.side, paths: cellPaths(stand, paintOf) }));
  }, [plan, states, mine, selected]);

  // The fan's seats, picked or held, lifted out of the stand; the newest last, so it's on top.
  const lifted = [...mine, ...selected]
    .map((seatId) => plan.byId.get(seatId))
    .filter((spot) => spot !== undefined);

  function spotUnder(event: {
    currentTarget: SVGSVGElement;
    clientX: number;
    clientY: number;
  }): SeatSpot | null {
    // The screen point back through the plan's matrix (x' = ax + cy + e, y' = bx + dy + f).
    const m = event.currentTarget.getScreenCTM?.();
    if (m === null || m === undefined) return null;
    const det = m.a * m.d - m.b * m.c;
    if (det === 0) return null;
    const dx = event.clientX - m.e;
    const dy = event.clientY - m.f;
    const x = (m.d * dx - m.c * dy) / det;
    const y = (m.a * dy - m.b * dx) / det;
    return spotAt(plan, { x, y: -y });
  }

  return (
    <svg
      className="ground-plan"
      viewBox={`${PLAN_BOX.x} ${PLAN_BOX.y} ${PLAN_BOX.width} ${PLAN_BOX.height}`}
      role="img"
      aria-label="Plan of the ground: Fondo Norte at the top, Lateral Este on the right, Fondo Sur at the bottom and Lateral Oeste on the left. Your seats are marked in gold."
      onPointerDown={(event) => {
        pointer.current = event.pointerType;
      }}
      onPointerMove={(event) => onPoint(spotUnder(event))}
      onPointerLeave={() => onPoint(null)}
      onClick={(event) => {
        const spot = spotUnder(event);
        if (spot !== null) onChoose(spot, pointer.current === 'mouse');
      }}
    >
      <defs>
        <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={`${id}-shadow`} x="-100%" y="-100%" width="300%" height="300%">
          <feGaussianBlur stdDeviation="0.9" />
        </filter>
      </defs>

      <rect
        className="g-roof"
        x={-(OUTER_X + RIM)}
        y={-(OUTER_Y + RIM)}
        width={2 * (OUTER_X + RIM)}
        height={2 * (OUTER_Y + RIM)}
        rx={34}
      />
      <path className="g-truss" d={TRUSSES} />
      <rect
        className="g-bowl"
        x={-OUTER_X}
        y={-OUTER_Y}
        width={2 * OUTER_X}
        height={2 * OUTER_Y}
        rx={26}
      />
      {plan.stands.map((stand) => {
        const box = standBox(stand.side);
        return <rect key={stand.side} className="g-stand" {...box} rx={1.2} />;
      })}
      {cells.map(({ side, paths }) =>
        (Object.entries(paths) as [CellPaint, string][]).map(([paint, d]) => (
          <path key={`${side}-${paint}`} className={`g-${paint}`} d={d} />
        )),
      )}
      {(
        [
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ] as const
      ).map(([sx, sy]) => (
        <rect
          key={`${sx}${sy}`}
          className="g-flood"
          x={-7}
          y={-1.1}
          width={14}
          height={2.2}
          rx={1.1}
          filter={`url(#${id}-glow)`}
          transform={`translate(${sx * (OUTER_X - 3)} ${sy * (OUTER_Y - 3)}) rotate(${sx * sy * -45})`}
        />
      ))}

      <rect className="g-apron" x={-SIDES} y={-ENDS} width={2 * SIDES} height={2 * ENDS} />
      <rect
        className="g-boards"
        x={-SIDES + 1.4}
        y={-ENDS + 1.4}
        width={2 * SIDES - 2.8}
        height={2 * ENDS - 2.8}
        rx={0.6}
      />
      <rect
        className="g-pitch"
        x={-PITCH.halfWidth}
        y={-PITCH.halfLength}
        width={2 * PITCH.halfWidth}
        height={2 * PITCH.halfLength}
      />
      <path className="g-stripe" d={STRIPE_PATH} />
      <path className="g-line" d={MARKINGS} />
      {pitchSpots().map((spot) => (
        <circle key={spot.y} className="g-spot" cx={spot.x} cy={-spot.y} r={0.45} />
      ))}
      {[1, -1].map((end) => (
        <rect
          key={end}
          className="g-goal"
          x={-GOAL.halfWidth}
          y={end > 0 ? -(PITCH.halfLength + GOAL.depth) : PITCH.halfLength}
          width={2 * GOAL.halfWidth}
          height={GOAL.depth}
        />
      ))}

      {plan.stands.map((stand) => {
        const label = LABELS[stand.side];
        return (
          <text
            key={stand.side}
            className="g-label"
            x={label.x}
            y={label.y}
            transform={
              label.rotate === 0 ? undefined : `rotate(${label.rotate} ${label.x} ${label.y})`
            }
          >
            {stand.stand.name}
          </text>
        );
      })}
      {activeSide !== null && <rect className="g-active" {...standBox(activeSide)} rx={1.2} />}

      {viewed !== null && (
        <line className="g-sightline" x1={viewed.at.x} y1={-viewed.at.y} x2={0} y2={0} />
      )}
      {pointed !== null && (
        <circle className="g-pointed" cx={pointed.at.x} cy={-pointed.at.y} r={2.6} />
      )}
      {lifted.map((spot) => (
        <g key={spot.seat.id} transform={`translate(${fixed(spot.at.x)} ${fixed(-spot.at.y)})`}>
          <ellipse className="g-lift-shadow" rx={2.2} ry={1.1} filter={`url(#${id}-shadow)`} />
          <g className="g-lift">
            <rect x={-1.7} y={-1.4} width={3.4} height={2.8} rx={0.7} />
          </g>
        </g>
      ))}
      {viewed !== null && (
        <g
          key={viewed.seat.id}
          className="g-tag"
          transform={`translate(${fixed(viewed.at.x)} ${fixed(-viewed.at.y)})`}
        >
          <g className="g-tag-rise">
            <line x1={0} y1={-2.4} x2={0} y2={-6.5} />
            <rect x={-7.5} y={-12.5} width={15} height={6} rx={1.6} />
            <text x={0} y={-9.4}>
              {seatName(viewed.seat)}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
});
