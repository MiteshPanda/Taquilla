import type { Seat } from '../api/client.js';
import type { Stand } from '../seats/seats.js';

// The ground as one model, in metres: x runs east, y north, z up, and the centre spot is the
// origin. The plan draws it from above and the seat view from a seat's eyes, so where a seat sits
// on the plan is where its view is taken from. The seed's 25 seats a row stand for whole blocks,
// so the stands are drawn deeper and longer than any real row of seats.

export interface Point2 {
  x: number;
  y: number;
}

export interface Point3 extends Point2 {
  z: number;
}

export const PITCH = { halfLength: 52.5, halfWidth: 34 } as const;
export const RUN_OFF = 6;
// Every stand is this deep, whatever its number of rows.
export const STAND_DEPTH = 40;
// The rake: how far the seats climb for each metre back, about 31 degrees.
export const RAKE = 0.6;
// The front row's floor above the pitch, behind the advertising boards.
export const FRONT_HEIGHT = 1.2;
// A seated fan's eyes above their row's floor.
export const EYE_HEIGHT = 1.15;
// The roof's edge above the back row.
export const ROOF_RISE = 7;
// How far the roof reaches over the stand, from the back.
export const ROOF_REACH = 30;

export type Side = 'north' | 'south' | 'east' | 'west';

// The seed's four stands (FR-SEAT-4). A stand with another name isn't drawn.
const SIDE_OF: Readonly<Record<string, Side>> = {
  'Fondo Norte': 'north',
  'Fondo Sur': 'south',
  'Lateral Este': 'east',
  'Lateral Oeste': 'west',
};

export function sideOf(standName: string): Side | undefined {
  return SIDE_OF[standName];
}

export interface Frame {
  // Toward the pitch, and a fan's left as they face it.
  inward: Point2;
  left: Point2;
  // The front row's distance from the centre spot, and half the stand's length.
  front: number;
  halfSpan: number;
}

const ENDS = PITCH.halfLength + RUN_OFF;
const SIDES = PITCH.halfWidth + RUN_OFF;

// Seat 1 is on a fan's left as they face the pitch, in every stand.
export const FRAMES: Readonly<Record<Side, Frame>> = {
  north: { inward: { x: 0, y: -1 }, left: { x: 1, y: 0 }, front: ENDS, halfSpan: SIDES },
  south: { inward: { x: 0, y: 1 }, left: { x: -1, y: 0 }, front: ENDS, halfSpan: SIDES },
  east: { inward: { x: -1, y: 0 }, left: { x: 0, y: -1 }, front: SIDES, halfSpan: ENDS },
  west: { inward: { x: 1, y: 0 }, left: { x: 0, y: 1 }, front: SIDES, halfSpan: ENDS },
};

// A point of a stand: `depth` metres out from the centre spot, `along` metres toward a fan's left
// from the stand's middle, at the rake's height.
export function standPoint(frame: Frame, depth: number, along: number, lift = 0): Point3 {
  return {
    x: -frame.inward.x * depth + frame.left.x * along,
    y: -frame.inward.y * depth + frame.left.y * along,
    z: FRONT_HEIGHT + (depth - frame.front) * RAKE + lift,
  };
}

export interface SeatSpot {
  seat: Seat;
  side: Side;
  // The seat's place in its stand: row 0 is the front row.
  row: number;
  rows: number;
  // The middle of the seat's block on the plan, and the block's size along and across the row.
  at: Point2;
  along: number;
  across: number;
  // Where the fan's eyes are.
  eye: Point3;
}

export interface StandPlan {
  stand: Stand;
  side: Side;
  frame: Frame;
  // Row by row, front row first, each in seat order.
  rows: readonly (readonly SeatSpot[])[];
}

export interface VenuePlan {
  stands: readonly StandPlan[];
  byId: ReadonlyMap<number, SeatSpot>;
}

// Places every seat of the seed's four stands. A row's seats share the stand's length evenly.
export function planOf(stands: readonly Stand[]): VenuePlan {
  const byId = new Map<number, SeatSpot>();
  const plans: StandPlan[] = [];
  for (const stand of stands) {
    const side = sideOf(stand.name);
    if (side === undefined) continue;
    const frame = FRAMES[side];
    const across = STAND_DEPTH / Math.max(stand.rows.length, 1);
    const rows = stand.rows.map((row, r) => {
      const along = (2 * frame.halfSpan) / Math.max(row.seats.length, 1);
      const depth = frame.front + (r + 0.5) * across;
      return row.seats.map((seat, c) => {
        const point = standPoint(frame, depth, frame.halfSpan - (c + 0.5) * along);
        const spot: SeatSpot = {
          seat,
          side,
          row: r,
          rows: stand.rows.length,
          at: { x: point.x, y: point.y },
          along,
          across,
          eye: { ...point, z: point.z + EYE_HEIGHT },
        };
        byId.set(seat.id, spot);
        return spot;
      });
    });
    plans.push({ stand, side, frame, rows });
  }
  return { stands: plans, byId };
}

// The seat whose block holds a point of the plan, if any.
export function spotAt(plan: VenuePlan, point: Point2): SeatSpot | null {
  for (const { frame, rows } of plan.stands) {
    const depth = -(point.x * frame.inward.x + point.y * frame.inward.y) - frame.front;
    const along = point.x * frame.left.x + point.y * frame.left.y;
    if (depth < 0 || depth >= STAND_DEPTH || Math.abs(along) > frame.halfSpan) continue;
    const row = rows[Math.floor((depth / STAND_DEPTH) * rows.length)];
    if (row === undefined || row.length === 0) return null;
    const c = Math.floor(((frame.halfSpan - along) / (2 * frame.halfSpan)) * row.length);
    return row[Math.min(Math.max(c, 0), row.length - 1)] ?? null;
  }
  return null;
}

// The pitch's markings, in metres.
const CIRCLE = 9.15;
const BOX = { depth: 16.5, halfWidth: 20.16 } as const;
const SIX_YARD = { depth: 5.5, halfWidth: 9.16 } as const;
const SPOT = 11;
export const GOAL = { halfWidth: 3.66, height: 2.44, depth: 2 } as const;

// Where a seat is, in a fan's words: "Behind the goal" or "Level with the halfway line".
export function whereIs(spot: SeatSpot): string {
  if (spot.side === 'north' || spot.side === 'south') {
    return Math.abs(spot.at.x) < BOX.halfWidth
      ? 'Behind the goal'
      : 'Behind the goal, toward the corner';
  }
  const fromHalfway = Math.abs(spot.at.y);
  if (fromHalfway < 14) return 'Level with the halfway line';
  if (fromHalfway < PITCH.halfLength - 16.5) return 'Between halfway and the box';
  return 'Level with the penalty box';
}

// Straight-line metres from a fan's eyes to the centre spot.
export function toCentreSpot(spot: SeatSpot): number {
  return Math.round(Math.hypot(spot.eye.x, spot.eye.y, spot.eye.z));
}

function arc(cx: number, cy: number, r: number, from: number, to: number, steps: number) {
  const points: Point2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = from + ((to - from) * i) / steps;
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return points;
}

// The pitch's markings as lines on the ground, each a list of points.
export function pitchLines(): Point2[][] {
  const { halfLength: L, halfWidth: W } = PITCH;
  const lines: Point2[][] = [
    [
      { x: -W, y: -L },
      { x: W, y: -L },
      { x: W, y: L },
      { x: -W, y: L },
      { x: -W, y: -L },
    ],
    [
      { x: -W, y: 0 },
      { x: W, y: 0 },
    ],
    arc(0, 0, CIRCLE, 0, 2 * Math.PI, 48),
  ];
  // The penalty arc is the part of the circle round the spot that lies outside the box.
  const outside = Math.acos((BOX.depth - SPOT) / CIRCLE);
  for (const end of [1, -1]) {
    const goalLine = end * L;
    const inward = -end;
    for (const box of [BOX, SIX_YARD]) {
      lines.push([
        { x: -box.halfWidth, y: goalLine },
        { x: -box.halfWidth, y: goalLine + inward * box.depth },
        { x: box.halfWidth, y: goalLine + inward * box.depth },
        { x: box.halfWidth, y: goalLine },
      ]);
    }
    const middle = inward > 0 ? Math.PI / 2 : -Math.PI / 2;
    lines.push(arc(0, goalLine + inward * SPOT, CIRCLE, middle - outside, middle + outside, 16));
    for (const side of [1, -1]) lines.push(cornerArc(side * W, goalLine, side, inward));
  }
  return lines;
}

// A quarter circle of a metre at a corner flag, curving into the pitch.
function cornerArc(x: number, y: number, side: number, inward: number): Point2[] {
  const points: Point2[] = [];
  for (let i = 0; i <= 6; i += 1) {
    const a = (Math.PI / 2) * (i / 6);
    points.push({ x: x - side * Math.cos(a), y: y + inward * Math.sin(a) });
  }
  return points;
}

// The centre spot and the two penalty spots.
export function pitchSpots(): Point2[] {
  return [
    { x: 0, y: 0 },
    { x: 0, y: PITCH.halfLength - SPOT },
    { x: 0, y: -(PITCH.halfLength - SPOT) },
  ];
}

// The mown stripes run across the pitch, so there are this many down its length.
export const STRIPES = 18;
