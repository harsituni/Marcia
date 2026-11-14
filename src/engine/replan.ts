/**
 * Replan from the crew's current position (M23).
 *
 * The new route runs: current position → the remaining stops that still fit,
 * in their planned order → the habitat. A plan "fits" when its oxygen use is
 * within the budget:
 *
 *   budget = oxygenLeftMin − reserve,  reserve = constraints.oxygenMin × reservePct / 100
 *
 * so `oxygenLeftMin` is what's in the tank right now and `constraints` are the
 * EVA's original ones (the reserve is a share of the full supply, not of
 * what's left).
 *
 * When the plan doesn't fit, stops are dropped one at a time, lowest
 * `scienceValue` first, until it does. Among stops of equal value the one
 * whose removal saves the most walking goes first (ties: the later stop).
 * Stops with no walkable path are dropped before any others.
 *
 * In the returned `RouteResult`:
 * - `path[0]` is the current position and the last cell is the habitat
 * - the first leg's `fromId` is `START_ID` (here: the current position) and
 *   the last leg's `toId` is `START_ID` (the habitat)
 * - `outOfRangeIds` lists every dropped stop, in planned order; unlike a
 *   `route` reply, dropped stops are not on the path
 * - stats are the same estimates as `astarRoute`, for the walk still ahead
 *
 * The way home is always returned, even when it alone is over budget (the
 * crew has to walk it regardless). With no way home at all, `path` is just
 * the current position and there are no legs.
 */
import { START_ID } from '../contracts.ts';
import type { Cell, Constraints, GridMeta, RouteLeg, RouteResult, Stop } from '../contracts.ts';
import type { AStar } from './astar.ts';
import { ENERGY_KJ_PER_MIN, OXYGEN_MIN_PER_MIN, WALK_SPEED_M_PER_MIN } from './model.ts';
import { pathLengthM } from './path.ts';

export interface ReplanRequest {
  from: Cell;
  /** Stops not yet visited, in planned order. */
  stops: Stop[];
  constraints: Constraints;
  oxygenLeftMin: number;
}

interface Segment {
  path: Cell[];
  lengthM: number;
}

export function replanRoute(engine: AStar, req: ReplanRequest, meta: GridMeta): RouteResult {
  const from = { x: Math.round(req.from.x), y: Math.round(req.from.y) };
  const habitat = meta.habitat;
  const reserveMin = (req.constraints.oxygenMin * req.constraints.reservePct) / 100;
  const budgetMin = Math.max(0, req.oxygenLeftMin - reserveMin);

  // A* per pair of waypoints, computed once however many plans are tried.
  const cache = new Map<string, Segment | null>();
  const segment = (a: Cell, b: Cell): Segment | null => {
    const key = `${a.x},${a.y}>${b.x},${b.y}`;
    let seg = cache.get(key);
    if (seg === undefined) {
      const found = engine.findPath(a, b);
      seg = found ? { path: found.path, lengthM: pathLengthM(found.path, meta.cellSizeM) } : null;
      cache.set(key, seg);
    }
    return seg;
  };

  /** Walking metres for current position → `kept` in order → habitat, or Infinity if a leg has no path. */
  const lengthOf = (kept: Stop[]): number => {
    let total = 0;
    let at = from;
    for (const s of kept) {
      const seg = segment(at, s.cell);
      if (!seg) return Infinity;
      total += seg.lengthM;
      at = s.cell;
    }
    const home = segment(at, habitat);
    return home ? total + home.lengthM : Infinity;
  };
  const oxygenFor = (lengthM: number) => (lengthM / WALK_SPEED_M_PER_MIN) * OXYGEN_MIN_PER_MIN;

  // Unreachable stops go first: costs are symmetric and the crew is on walkable
  // ground, so a stop with no path from here has no path from anywhere on the route.
  let kept = req.stops.filter((s) => segment(from, s.cell) !== null);

  while (kept.length > 0 && oxygenFor(lengthOf(kept)) > budgetMin) {
    const lowest = Math.min(...kept.map((s) => s.scienceValue));
    let drop = -1;
    let best = Infinity;
    kept.forEach((s, i) => {
      if (s.scienceValue !== lowest) return;
      const without = lengthOf(kept.filter((_, j) => j !== i));
      // `<=` so that on a tie the later stop is the one dropped.
      if (without <= best) {
        best = without;
        drop = i;
      }
    });
    kept = kept.filter((_, i) => i !== drop);
  }

  const keptIds = new Set(kept.map((s) => s.id));
  const outOfRangeIds = req.stops.filter((s) => !keptIds.has(s.id)).map((s) => s.id);

  const path: Cell[] = [from];
  const legs: RouteLeg[] = [];
  let at = { id: START_ID as string, cell: from };
  const append = (toId: string, to: Cell): boolean => {
    const seg = segment(at.cell, to);
    if (!seg) return false;
    const startIdx = path.length - 1;
    for (let i = 1; i < seg.path.length; i++) path.push(seg.path[i]!);
    legs.push({ fromId: at.id, toId, startIdx, endIdx: path.length - 1 });
    at = { id: toId, cell: to };
    return true;
  };
  for (const s of kept) append(s.id, s.cell);
  // Already standing on the habitat with nothing left to visit: no walk at all.
  if (kept.length > 0 || from.x !== habitat.x || from.y !== habitat.y) append(START_ID, habitat);

  const distanceM = pathLengthM(path, meta.cellSizeM);
  const timeMin = distanceM / WALK_SPEED_M_PER_MIN;
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
