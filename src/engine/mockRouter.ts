/**
 * Test-only stand-ins for the engine (straight-line route, circular ring).
 * The app uses the real worker (A* + Dijkstra ring); nothing in `src/` imports this.
 */
import { START_ID } from '../contracts.ts';
import type { Cell, GridMeta, RingResult, RouteLeg, RouteRequest, RouteResult } from '../contracts.ts';
import { pathLengthM } from './path.ts';
import { ENERGY_KJ_PER_MIN, OXYGEN_MIN_PER_MIN, WALK_SPEED_M_PER_MIN, usableOxygenMin } from './model.ts';

/** Cells on the straight line from `a` to `b`, both ends included (Bresenham). */
export function lineCells(a: Cell, b: Cell): Cell[] {
  let x = Math.round(a.x);
  let y = Math.round(a.y);
  const x1 = Math.round(b.x);
  const y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  const out: Cell[] = [{ x, y }];
  while (x !== x1 || y !== y1) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    out.push({ x, y });
  }
  return out;
}

function minutesFor(distanceM: number): number {
  return distanceM / WALK_SPEED_M_PER_MIN;
}

/**
 * Stand-in for the real A* engine: joins start → stops → start with straight
 * lines, ignoring cost and blocked cells. Same shape as the real `RouteResult`.
 */
export function mockRoute(req: RouteRequest, meta: GridMeta): RouteResult {
  const { start, stops, constraints } = req;
  const waypoints = [
    { id: START_ID, cell: start },
    ...stops.map((s) => ({ id: s.id, cell: s.cell })),
    { id: START_ID, cell: start },
  ];

  const path: Cell[] = [];
  const legs: RouteLeg[] = [];
  const budget = usableOxygenMin(constraints.oxygenMin, constraints.reservePct);
  const outOfRangeIds: string[] = [];
  let elapsedMin = 0;

  for (let i = 1; i < waypoints.length; i++) {
    const from = waypoints[i - 1]!;
    const to = waypoints[i]!;
    const seg = lineCells(from.cell, to.cell);
    // Join legs without repeating the shared waypoint cell.
    const startIdx = path.length === 0 ? 0 : path.length - 1;
    path.push(...(path.length === 0 ? seg : seg.slice(1)));
    legs.push({ fromId: from.id, toId: to.id, startIdx, endIdx: path.length - 1 });

    elapsedMin += minutesFor(pathLengthM(seg, meta.cellSizeM));
    if (to.id !== START_ID) {
      const backMin = minutesFor(pathLengthM(lineCells(to.cell, start), meta.cellSizeM));
      if ((elapsedMin + backMin) * OXYGEN_MIN_PER_MIN > budget) outOfRangeIds.push(to.id);
    }
  }

  const distanceM = pathLengthM(path, meta.cellSizeM);
  const timeMin = minutesFor(distanceM);
  return {
    path,
    legs,
    distanceM,
    timeMin,
    energyKJ: timeMin * ENERGY_KJ_PER_MIN,
    oxygenUsedMin: timeMin * OXYGEN_MIN_PER_MIN,
    outOfRangeIds,
  };
}

/**
 * Stand-in for the turn-back ring: a circle around `center` whose radius is
 * the out-and-back distance the remaining usable oxygen allows on flat ground.
 */
export function mockRing(center: Cell, oxygenLeftMin: number, meta: GridMeta, points = 48): RingResult {
  const radiusCells = Math.max(0, (oxygenLeftMin / OXYGEN_MIN_PER_MIN / 2) * WALK_SPEED_M_PER_MIN) / meta.cellSizeM;
  const polygon: Cell[] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * 2 * Math.PI;
    polygon.push({
      x: Math.min(meta.width - 1, Math.max(0, center.x + radiusCells * Math.cos(a))),
      y: Math.min(meta.height - 1, Math.max(0, center.y + radiusCells * Math.sin(a))),
    });
  }
  return { polygon };
}
