/**
 * Routing Web Worker.
 *
 * The UI creates it with
 *   new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' })
 * and imports only the message types from here (`import type`), so the
 * handler below never runs on the main thread. `checkAlerts` is a plain
 * function in `./alerts.ts` for the same reason.
 *
 * `route` and `replan` use A* (M07). `ring` still answers from the mock router.
 */
import type { Cell, Constraints, GridMeta, RingResult, RouteRequest, RouteResult, Stop } from '../contracts.ts';
import { AStar, astarRoute } from './astar.ts';
import { mockRing } from './mockRouter.ts';

export type WorkerIn =
  /** Send once after loading the data. Transfer `cost.buffer` to avoid a copy. */
  | { type: 'init'; meta: GridMeta; cost: Float32Array }
  | { type: 'route'; req: RouteRequest }
  | { type: 'ring'; oxygenLeftMin: number }
  | { type: 'replan'; from: Cell; stops: Stop[]; constraints: Constraints; oxygenLeftMin: number };

export type WorkerOut =
  | { type: 'route'; result: RouteResult }
  | { type: 'ring'; result: RingResult }
  | { type: 'error'; message: string };

interface EngineState {
  meta: GridMeta;
  cost: Float32Array;
  astar: AStar;
}

/** Message handler, exported so tests can drive it without a real worker. */
export function handleMessage(state: EngineState | null, msg: WorkerIn): { state: EngineState | null; out?: WorkerOut } {
  if (msg.type === 'init') {
    const expected = msg.meta.width * msg.meta.height;
    if (msg.cost.length !== expected) {
      return { state, out: { type: 'error', message: `cost has ${msg.cost.length} cells, expected ${expected}` } };
    }
    return { state: { meta: msg.meta, cost: msg.cost, astar: new AStar(msg.meta, msg.cost) } };
  }
  if (!state) return { state, out: { type: 'error', message: `'${msg.type}' sent before 'init'` } };

  switch (msg.type) {
    case 'route':
      return { state, out: { type: 'route', result: astarRoute(state.astar, msg.req, state.meta) } };
    case 'ring':
      return { state, out: { type: 'ring', result: mockRing(state.meta.habitat, msg.oxygenLeftMin, state.meta) } };
    case 'replan': {
      const constraints = { ...msg.constraints, oxygenMin: msg.oxygenLeftMin };
      return { state, out: { type: 'route', result: astarRoute(state.astar, { start: msg.from, stops: msg.stops, constraints }, state.meta) } };
    }
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
