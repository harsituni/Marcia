/**
 * 8-direction A* over the cost grid (M07).
 *
 * Edge cost = step length (1 or √2 cells × `cellSizeM`) × the mean of the two
 * cells' costs, so a step costs the same both ways. `Infinity` cells are
 * blocked, and a diagonal step may not cut the corner of a blocked cell.
 * The heuristic is octile distance × the grid's cheapest cell cost, which
 * never overestimates, so paths are optimal.
 */
import { START_ID } from '../contracts.ts';
import type { Cell, GridMeta, RouteLeg, RouteRequest, RouteResult } from '../contracts.ts';
import { MinHeap } from './heap.ts';
import type { HomeField } from './ring.ts';
import { pathLengthM } from './mockRouter.ts';
import { ENERGY_KJ_PER_MIN, OXYGEN_MIN_PER_MIN, WALK_SPEED_M_PER_MIN, usableOxygenMin } from './model.ts';

const SQRT2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const DY = [0, 0, 1, -1, 1, -1, 1, -1] as const;

export interface PathResult {
  path: Cell[];
  /** Total edge cost of `path` (cost-weighted metres). */
  cost: number;
}

/**
 * Reusable A* search for one grid. Scratch arrays are allocated once and
 * invalidated per search with a generation stamp, so repeated searches don't
 * clear `width × height` cells each time.
 */
export class AStar {
  readonly width: number;
  readonly height: number;
  private readonly cellSizeM: number;
  private readonly cost: Float32Array;
  /** Heuristic scale: octile cells → lower bound on cost. */
  private readonly hScale: number;

  private readonly gScore: Float32Array;
  private readonly cameFrom: Int32Array;
  /** `seen[i] === gen` ⇒ gScore/cameFrom for i belong to this search. */
  private readonly seen: Uint32Array;
  /** `closed[i] === gen` ⇒ i is expanded. */
  private readonly closed: Uint32Array;
  private readonly heap: MinHeap;
  private gen = 0;

  constructor(meta: Pick<GridMeta, 'width' | 'height' | 'cellSizeM'>, cost: Float32Array) {
    const n = meta.width * meta.height;
    if (cost.length !== n) throw new Error(`cost has ${cost.length} cells, expected ${n}`);
    this.width = meta.width;
    this.height = meta.height;
    this.cellSizeM = meta.cellSizeM;
    this.cost = cost;

    let minCost = Infinity;
    for (let i = 0; i < n; i++) {
      const c = cost[i]!;
      if (c < minCost) minCost = c;
    }
    // All blocked (or empty): any heuristic works since nothing is expanded.
    this.hScale = Number.isFinite(minCost) && minCost > 0 ? minCost * meta.cellSizeM : 0;

    this.gScore = new Float32Array(n);
    this.cameFrom = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new MinHeap(Math.min(n, 1 << 16));
  }

  /** True if (x, y) is on the grid and not blocked. */
  passable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return Number.isFinite(this.cost[y * this.width + x]!);
  }

  /** Cheapest 8-connected path from `start` to `goal`, or `null` if there is none. */
  findPath(start: Cell, goal: Cell): PathResult | null {
    const sx = Math.round(start.x);
    const sy = Math.round(start.y);
    const gx = Math.round(goal.x);
    const gy = Math.round(goal.y);
    if (!this.passable(sx, sy) || !this.passable(gx, gy)) return null;

    const W = this.width;
    const H = this.height;
    const cost = this.cost;
    const gScore = this.gScore;
    const cameFrom = this.cameFrom;
    const seen = this.seen;
    const closed = this.closed;
    const heap = this.heap;
    const hScale = this.hScale;
    const cell = this.cellSizeM;

    const gen = this.nextGen();
    const startIdx = sy * W + sx;
    const goalIdx = gy * W + gx;
    if (startIdx === goalIdx) return { path: [{ x: sx, y: sy }], cost: 0 };

    const h = (x: number, y: number): number => {
      const dx = Math.abs(x - gx);
      const dy = Math.abs(y - gy);
      return dx > dy ? (dx - dy + SQRT2 * dy) * hScale : (dy - dx + SQRT2 * dx) * hScale;
    };

    heap.clear();
    seen[startIdx] = gen;
    gScore[startIdx] = 0;
    cameFrom[startIdx] = -1;
    heap.push(startIdx, h(sx, sy));

    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed[cur] === gen) continue; // stale duplicate
      if (cur === goalIdx) return { path: this.reconstruct(goalIdx), cost: gScore[goalIdx]! };
      closed[cur] = gen;

      const cx = cur % W;
      const cy = (cur - cx) / W;
      const gCur = gScore[cur]!;
      const cCur = cost[cur]!;

      for (let d = 0; d < 8; d++) {
        const dx = DX[d]!;
        const dy = DY[d]!;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (closed[ni] === gen) continue;
        const cN = cost[ni]!;
        if (cN === Infinity) continue;
        let step = cell;
        if (dx !== 0 && dy !== 0) {
          // No corner cutting: both orthogonal neighbours must be open.
          if (cost[cy * W + nx] === Infinity || cost[ny * W + cx] === Infinity) continue;
          step = cell * SQRT2;
        }
        const g = gCur + step * 0.5 * (cCur + cN);
        if (seen[ni] === gen && g >= gScore[ni]!) continue;
        seen[ni] = gen;
        gScore[ni] = g;
        cameFrom[ni] = cur;
        heap.push(ni, g + h(nx, ny));
      }
    }
    return null;
  }

  private reconstruct(goalIdx: number): Cell[] {
    const W = this.width;
    const out: Cell[] = [];
    for (let i = goalIdx; i !== -1; i = this.cameFrom[i]!) {
      const x = i % W;
      out.push({ x, y: (i - x) / W });
    }
    return out.reverse();
  }

  private nextGen(): number {
    this.gen++;
    if (this.gen === 0xffffffff) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.gen = 1;
    }
    return this.gen;
  }
}

function minutesFor(distanceM: number): number {
  return distanceM / WALK_SPEED_M_PER_MIN;
}

/** Walking minutes along the cheapest path from `from` back to `to`, or Infinity. */
function minutesBack(engine: AStar, from: Cell, to: Cell, meta: GridMeta): number {
  const back = engine.findPath(from, to);
  return back ? minutesFor(pathLengthM(back.path, meta.cellSizeM)) : Infinity;
}

/**
 * Real-engine counterpart of `mockRoute`: start → each stop in order → start,
 * each leg an A* path.
 *
 * `home` (optional) is the habitat's cached Dijkstra field (M18). When the
 * route starts at its source, the "can I get home from this stop" check reads
 * it instead of running one A* per stop; otherwise (e.g. replan from the
 * current position) the per-stop A* check is used. Same rule either way.
 *
 * A stop with no path from the previous waypoint is skipped and listed in
 * `outOfRangeIds` (the contract has no separate failure field); the route
 * carries on to the next stop. Costs are symmetric, so any stop that is
 * reached also has a way home. If nothing is reachable, `path` is just
 * `[start]` with no legs. Never throws for unreachable cells.
 *
 * Stats are ESTIMATES (`STATS_ARE_ESTIMATES` in `model.ts`): `distanceM` is
 * the path length (diagonal steps √2 cells); `timeMin`, `energyKJ` and
 * `oxygenUsedMin` scale from it with the flat-ground constants in `model.ts`.
 * Cell cost only steers which path is taken. With no reachable stop, all
 * four are 0.
 */
export function astarRoute(engine: AStar, req: RouteRequest, meta: GridMeta, home?: HomeField): RouteResult {
  const { start, stops, constraints } = req;
  const startCell = { x: Math.round(start.x), y: Math.round(start.y) };
  const budget = usableOxygenMin(constraints.oxygenMin, constraints.reservePct);

  const path: Cell[] = [startCell];
  const legs: RouteLeg[] = [];
  const outOfRangeIds: string[] = [];
  let elapsedMin = 0;
  let from = { id: START_ID as string, cell: startCell };
  // The cached Dijkstra field answers "minutes home from this stop" only when the route starts at its source.
  const homeFromStart = home && home.source.x === startCell.x && home.source.y === startCell.y ? home : undefined;

  const appendLeg = (toId: string, seg: Cell[]) => {
    const startIdx = path.length - 1;
    for (let i = 1; i < seg.length; i++) path.push(seg[i]!);
    legs.push({ fromId: from.id, toId, startIdx, endIdx: path.length - 1 });
  };

  for (const stop of stops) {
    const leg = engine.findPath(from.cell, stop.cell);
    if (!leg) {
      outOfRangeIds.push(stop.id);
      continue;
    }
    appendLeg(stop.id, leg.path);
    elapsedMin += minutesFor(pathLengthM(leg.path, meta.cellSizeM));

    const backMin = homeFromStart ? homeFromStart.minutesFrom(stop.cell) : minutesBack(engine, stop.cell, startCell, meta);
    if ((elapsedMin + backMin) * OXYGEN_MIN_PER_MIN > budget) outOfRangeIds.push(stop.id);
    from = { id: stop.id, cell: leg.path[leg.path.length - 1]! };
  }

  if (legs.length > 0) {
    const home = engine.findPath(from.cell, startCell);
    // Symmetric costs make this reachable; guard anyway rather than throw.
    if (home) appendLeg(START_ID, home.path);
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
