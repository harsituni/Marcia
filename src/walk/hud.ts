/**
 * Everything the Walk-mode HUD shows, derived from the planned route and a
 * small walk state. Pure functions: the HUD components only draw the result,
 * and the walk replay (M25) only has to update `WalkState`.
 */
import { START_ID } from '../contracts.ts';
import type { Cell, Constraints, GridMeta, RouteResult, Stop } from '../contracts.ts';
import { OXYGEN_MIN_PER_MIN, WALK_SPEED_M_PER_MIN } from '../engine/model.ts';

/** Where the crew is on the planned route, and what's left in the tank. */
export interface WalkState {
  /** Position as an index into `RouteResult.path`; fractions are between cells. */
  pathIdx: number;
  oxygenLeftMin: number;
}

export type Status = 'ok' | 'caution' | 'critical';

/** Below this many spare minutes the gauges turn to caution. */
export const CAUTION_MARGIN_MIN = 30;

/** Path cells to look ahead when working out the direction of travel. */
const HEADING_LOOKAHEAD = 4;

/** Compass bearing from one cell to another: 0 = grid north (up), 90 = east. */
export function bearingDeg(from: Cell, to: Cell): number {
  const deg = (Math.atan2(to.x - from.x, from.y - to.y) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Signed angle from `heading` to `bearing`, in (-180, 180]; positive = to the right. */
export function relativeBearing(bearing: number, heading: number): number {
  const d = (((bearing - heading) % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
}

/** Position at a (possibly fractional) path index, clamped to the path. */
export function positionAt(path: Cell[], idx: number): Cell {
  const i = Math.min(Math.max(idx, 0), path.length - 1);
  const a = path[Math.floor(i)]!;
  const b = path[Math.ceil(i)]!;
  const f = i - Math.floor(i);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Distance walked from the start to each path cell, metres. */
export function cumulativeM(path: Cell[], cellSizeM: number): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!;
    const q = path[i]!;
    out.push(out[i - 1]! + Math.hypot(q.x - p.x, q.y - p.y) * cellSizeM);
  }
  return out;
}

function distanceAt(cum: number[], idx: number): number {
  const i = Math.min(Math.max(idx, 0), cum.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return cum[lo]! + (cum[hi]! - cum[lo]!) * (i - lo);
}

export type NextTarget =
  | { kind: 'stop'; stop: Stop; n: number; cell: Cell; distanceM: number; etaMin: number; bearingDeg: number }
  | { kind: 'home'; cell: Cell; distanceM: number; etaMin: number; bearingDeg: number }
  | { kind: 'arrived' };

export interface HudState {
  position: Cell;
  /** Direction of travel along the route. */
  headingDeg: number;
  next: NextTarget;
  /** Straight-line bearing back to the habitat; null while standing on it. */
  habitatBearingDeg: number | null;
  oxygen: { leftMin: number; supplyMin: number; reserveMin: number; fraction: number; status: Status };
  /**
   * Spare oxygen if the crew turned for home now: what's left, minus the
   * reserve, minus the walk home along the current route. On a planned route
   * that's the shorter of retracing it or finishing it; on a replanned route
   * (which starts where the crew was, not at the habitat) it's finishing it.
   * Pressing Replan swaps in the direct path home through the stops that still fit.
   */
  returnMargin: { marginMin: number; homeMin: number; fraction: number; status: Status };
  /** 'start': at the habitat before the first step; 'done': back at the habitat at the end of the path. */
  phase: 'start' | 'walking' | 'done';
}

export function deriveHud(input: {
  route: Pick<RouteResult, 'path' | 'legs'>;
  stops: Stop[];
  constraints: Constraints;
  /** `habitat` matters on replanned routes, whose path starts at the crew, not the habitat. */
  meta: Pick<GridMeta, 'cellSizeM'> & { habitat?: Cell };
  walk: WalkState;
}): HudState {
  const { route, stops, constraints, meta, walk } = input;
  const { path, legs } = route;
  const last = path.length - 1;
  const idx = Math.min(Math.max(walk.pathIdx, 0), last);
  const position = positionAt(path, idx);
  const cum = cumulativeM(path, meta.cellSizeM);
  const here = distanceAt(cum, idx);
  const total = cum[last] ?? 0;

  // Heading: towards a point a few cells ahead, or along the last few at the end.
  const ahead = positionAt(path, Math.min(idx + HEADING_LOOKAHEAD, last));
  const moved = ahead.x !== position.x || ahead.y !== position.y;
  const behind = positionAt(path, Math.max(idx - HEADING_LOOKAHEAD, 0));
  const headingDeg = moved ? bearingDeg(position, ahead) : last > 0 ? bearingDeg(behind, position) : 0;

  let next: NextTarget = { kind: 'arrived' };
  const leg = legs.find((l) => l.endIdx > idx);
  if (leg) {
    const cell = path[leg.endIdx]!;
    const distanceM = distanceAt(cum, leg.endIdx) - here;
    const common = { cell, distanceM, etaMin: distanceM / WALK_SPEED_M_PER_MIN, bearingDeg: bearingDeg(position, cell) };
    const stopIdx = stops.findIndex((s) => s.id === leg.toId);
    next = leg.toId !== START_ID && stopIdx >= 0 ? { kind: 'stop', stop: stops[stopIdx]!, n: stopIdx + 1, ...common } : { kind: 'home', ...common };
  }

  const home = meta.habitat ?? path[0]!;
  const atHome = Math.hypot(position.x - home.x, position.y - home.y) < 0.5;
  const startsAtHome = Math.hypot(path[0]!.x - home.x, path[0]!.y - home.y) < 0.5;

  const supplyMin = constraints.oxygenMin;
  const reserveMin = (supplyMin * constraints.reservePct) / 100;
  const leftMin = Math.max(0, walk.oxygenLeftMin);
  // Retracing only leads home when the route started there.
  const homeM = startsAtHome ? Math.min(here, total - here) : total - here;
  const homeMin = (homeM / WALK_SPEED_M_PER_MIN) * OXYGEN_MIN_PER_MIN;
  const marginMin = leftMin - reserveMin - homeMin;
  const usable = Math.max(1, supplyMin - reserveMin);

  return {
    position,
    headingDeg,
    next,
    habitatBearingDeg: atHome ? null : bearingDeg(position, home),
    oxygen: {
      leftMin,
      supplyMin,
      reserveMin,
      fraction: supplyMin > 0 ? Math.min(1, leftMin / supplyMin) : 0,
      status: leftMin <= reserveMin ? 'critical' : leftMin <= reserveMin + CAUTION_MARGIN_MIN ? 'caution' : 'ok',
    },
    phase: atHome && idx === 0 ? 'start' : atHome && idx === last ? 'done' : 'walking',
    returnMargin: {
      marginMin,
      homeMin,
      fraction: Math.min(1, Math.max(0, marginMin / usable)),
      status: marginMin <= 0 ? 'critical' : marginMin < CAUTION_MARGIN_MIN ? 'caution' : 'ok',
    },
  };
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export interface CompassTick {
  /** Compass degrees, 0–359. */
  deg: number;
  /** Degrees right (+) or left (−) of the current heading. */
  offsetDeg: number;
  /** N, NE, E… on the 45° ticks. */
  label: string | null;
}

/** Ticks visible on a compass strip `spanDeg` wide, centred on `heading`. */
export function compassTicks(heading: number, spanDeg = 120, stepDeg = 15): CompassTick[] {
  const half = spanDeg / 2;
  const ticks: CompassTick[] = [];
  for (let d = Math.ceil((heading - half) / stepDeg) * stepDeg; d <= heading + half; d += stepDeg) {
    const deg = ((d % 360) + 360) % 360;
    ticks.push({ deg, offsetDeg: d - heading, label: deg % 45 === 0 ? POINTS[deg / 45]! : null });
  }
  return ticks;
}

export function formatHeading(deg: number): string {
  return `${(Math.round(deg) % 360).toString().padStart(3, '0')}°`;
}
