/**
 * Routing Web Worker.
 *
 * The UI creates it with
 *   new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' })
 * and imports only the message types from here (`import type`), so the
 * handler below never runs on the main thread. `checkAlerts` is a plain
 * function in `./alerts.ts` for the same reason.
 *
 * `route` uses A* (M07). `ring` uses the habitat's Dijkstra field (M18),
 * computed once on `init`; `route` also reuses it for the get-home check.
 * `replan` routes from the current position back to the habitat, dropping
 * stops that no longer fit the oxygen left (M23, see `replan.ts`).
 *
 * Slope limit: `cost.bin` already blocks cells over `GridMeta.maxSlopeDeg`.
 * When `init` also gets the elevation, the worker computes each cell's slope
 * once and, for a lower `Constraints.maxSlopeDeg`, blocks the cells over it on
 * top of `cost.bin` (cached per limit). Without elevation the baked limit
 * applies.
 */
import type { Cell, Constraints, GridMeta, RingResult, RouteRequest, RouteResult, Stop } from '../contracts.ts';
import { AStar, astarRoute } from './astar.ts';
import { replanRoute } from './replan.ts';
import { HomeField, ringPolygon } from './ring.ts';
import { slopeDegAt } from './terrain.ts';

export type WorkerIn =
  /** Send once after loading the data. Transfer `cost.buffer` to avoid a copy. */
  | { type: 'init'; meta: GridMeta; cost: Float32Array; elevation?: Float32Array }
  | { type: 'route'; req: RouteRequest }
  | { type: 'ring'; oxygenLeftMin: number; maxSlopeDeg?: number }
  | { type: 'replan'; from: Cell; stops: Stop[]; constraints: Constraints; oxygenLeftMin: number };

export type WorkerOut =
  | { type: 'route'; result: RouteResult }
  | { type: 'ring'; result: RingResult }
  | { type: 'error'; message: string };

interface EngineState {
  meta: GridMeta;
  cost: Float32Array;
  astar: AStar;
  /** Dijkstra from the habitat, recomputed only on `init`. */
  home: HomeField;
  /** Per-cell slope in degrees (Horn), when `init` had the elevation. */
  slope?: Float32Array;
  /** Router for the last lower slope limit asked for. */
  limited?: { limit: number; astar: AStar; home: HomeField };
}

/** Per-cell slope (degrees) of a row-major elevation grid. */
export function slopeGrid(meta: GridMeta, elevation: Float32Array): Float32Array {
  const out = new Float32Array(meta.width * meta.height);
  const terrain = { meta, elevation };
  for (let y = 0; y < meta.height; y++) for (let x = 0; x < meta.width; x++) out[y * meta.width + x] = slopeDegAt(terrain, x, y);
  return out;
}

/** `cost` with every cell steeper than `limit` blocked; the habitat cell stays open. */
export function limitCost(meta: GridMeta, cost: Float32Array, slope: Float32Array, limit: number): Float32Array {
  const out = Float32Array.from(cost);
  const home = meta.habitat.y * meta.width + meta.habitat.x;
  for (let i = 0; i < out.length; i++) if (i !== home && slope[i]! > limit) out[i] = Infinity;
  return out;
}

/** The A* and home field for `limit`: the base ones at or above the baked limit. */
function routerFor(state: EngineState, limit: number | undefined): { astar: AStar; home: HomeField } {
  if (!state.slope || limit === undefined || !(limit < state.meta.maxSlopeDeg)) return state;
  if (state.limited?.limit !== limit) {
    const cost = limitCost(state.meta, state.cost, state.slope, limit);
    state.limited = { limit, astar: new AStar(state.meta, cost), home: new HomeField(state.meta, cost, state.meta.habitat) };
  }
  return state.limited;
}

/** Message handler, exported so tests can drive it without a real worker. */
export function handleMessage(state: EngineState | null, msg: WorkerIn): { state: EngineState | null; out?: WorkerOut } {
  if (msg.type === 'init') {
    const expected = msg.meta.width * msg.meta.height;
    if (msg.cost.length !== expected) {
      return { state, out: { type: 'error', message: `cost has ${msg.cost.length} cells, expected ${expected}` } };
    }
    const slope = msg.elevation?.length === expected ? slopeGrid(msg.meta, msg.elevation) : undefined;
    return {
      state: { meta: msg.meta, cost: msg.cost, astar: new AStar(msg.meta, msg.cost), home: new HomeField(msg.meta, msg.cost, msg.meta.habitat), slope },
    };
  }
  if (!state) return { state, out: { type: 'error', message: `'${msg.type}' sent before 'init'` } };

  switch (msg.type) {
    case 'route': {
      const r = routerFor(state, msg.req.constraints.maxSlopeDeg);
      return { state, out: { type: 'route', result: astarRoute(r.astar, msg.req, state.meta, r.home) } };
    }
    case 'ring':
      return { state, out: { type: 'ring', result: ringPolygon(routerFor(state, msg.maxSlopeDeg).home, msg.oxygenLeftMin) } };
    case 'replan':
      return { state, out: { type: 'route', result: replanRoute(routerFor(state, msg.constraints.maxSlopeDeg).astar, msg, state.meta) } };
  }
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerIn>) => void) | null;
  postMessage(msg: WorkerOut): void;
}

// Register only inside a worker (no `window`), so tests can import this file.
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  const scope = self as unknown as WorkerScope;
  let state: EngineState | null = null;
  scope.onmessage = (e) => {
    try {
      const res = handleMessage(state, e.data);
      state = res.state;
      if (res.out) scope.postMessage(res.out);
    } catch (err) {
      scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };
}
