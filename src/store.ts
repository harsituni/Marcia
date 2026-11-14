import { create } from 'zustand';
import { START_ID } from './contracts.ts';
import type { Alert, Cell, Constraints, RingResult, RouteResult, Stop } from './contracts.ts';
import { loadGrid } from './data/grid.ts';
import type { GridData } from './data/grid.ts';
import { checkAlerts } from './engine/alerts.ts';
import { createWorkerEngine } from './engine/client.ts';
import type { EngineClient } from './engine/client.ts';
import { usableOxygenMin } from './engine/model.ts';
import { clampConstraints } from './plan/constraints.ts';
import { positionAt } from './walk/hud.ts';
import type { WalkState } from './walk/hud.ts';
import { IDLE_REPLAY, RING_STEP_MIN, advance, walkAt } from './walk/replay.ts';
import type { Replay } from './walk/replay.ts';

export type Mode = 'plan' | 'walk';

/** Where the grid data comes from: the real Jezero files in `public/data/`. */
export const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}data`;

/** Starting constraints; the crew edits them in the settings panel. */
export const DEFAULT_CONSTRAINTS: Constraints = { oxygenMin: 480, reservePct: 20, maxSlopeDeg: 25 };

export type DataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; grid: GridData }
  | { status: 'error'; message: string };

export type LayerId = 'difficulty' | 'sand' | 'ring';

/** Set once the crew has replanned mid-walk; `route` is then the replanned one. */
export interface Replanned {
  /** Stops dropped by this and any earlier replan, in planned order. */
  droppedIds: string[];
  /** Oxygen in the tank where the replanned route starts. */
  startOxygenMin: number;
  /** EVA minutes walked before the replanned route starts. */
  offsetMin: number;
}

export type RouteState =
  | { status: 'idle' }
  | { status: 'planning' }
  | { status: 'ready'; result: RouteResult }
  | { status: 'error'; message: string };

interface AppState {
  mode: Mode;
  setMode: (mode: Mode) => void;

  data: DataState;
  loadData: (baseUrl?: string) => Promise<void>;

  /** Planned stops, in visiting order. Starts as `stops.json`. */
  stops: Stop[];
  /** Adds a stop at the end of the route. Returns false if the cell isn't walkable. */
  addStop: (cell: Cell) => boolean;
  /** Moves a stop. Returns false (and leaves it) if the cell isn't walkable. */
  moveStop: (id: string, cell: Cell) => boolean;
  removeStop: (id: string) => void;

  /** Stop whose card is open, if any. */
  selectedStopId: string | null;
  selectStop: (id: string | null) => void;

  /** Short message shown over the map, cleared after a few seconds. */
  notice: string | null;
  showNotice: (message: string) => void;

  constraints: Constraints;
  /** Updates some constraints (clamped to valid ranges) and reroutes shortly after. */
  setConstraints: (patch: Partial<Constraints>) => void;
  route: RouteState;
  /** Asks the engine for a route from the habitat through the current stops. */
  planRoute: () => Promise<void>;

  /** Which map overlays are switched on. */
  layers: Record<LayerId, boolean>;
  toggleLayer: (id: LayerId) => void;
  /** Turn-back ring for the usable oxygen; fetched while the ring layer is on. */
  ring: RingResult | null;
  planRing: () => Promise<void>;

  /**
   * Progress along the route in Walk mode. Null until a walk starts; the HUD
   * then shows the crew at the habitat with a full supply. The replay (M25)
   * drives this.
   */
  walk: WalkState | null;
  setWalk: (walk: WalkState | null) => void;

  /** Simulated walk along the route (Walk mode). */
  replay: Replay;
  playWalk: () => void;
  pauseWalk: () => void;
  /** Back to the habitat with a full supply. */
  resetWalk: () => void;
  /** Jumps to a point in the walk, 0 (start) to 1 (home again). */
  seekWalk: (fraction: number) => void;
  setWalkSpeed: (speed: number) => void;
  /** Advances the replay by `dtRealSec` of real time; called once per frame. */
  tickWalk: (dtRealSec: number) => void;

  /** Walk-mode alerts for where the crew is now (`checkAlerts`), critical first. */
  alerts: Alert[];
  /** Non-null after a mid-walk replan. Planning again from the habitat clears it. */
  replanned: Replanned | null;
  /** True while a replan request is with the worker; the replay clock holds. */
  replanning: boolean;
  /**
   * Replans from the crew's position through the stops still ahead, with the
   * oxygen left. Swaps the new route in and records which stops were dropped.
   */
  replanWalk: () => Promise<void>;

  /** Engine factory; tests swap in a fake worker. */
  makeEngine: () => EngineClient;
}

let engine: EngineClient | null = null;
let engineGrid: GridData | null = null;
let planSeq = 0;
let ringSeq = 0;
/** Oxygen value the last ring was requested for, and whether one is in flight. */
let ringOxygen: number | null = null;
let ringBusy = false;
let replanSeq = 0;

/** Returns the engine, initialised with `grid` (once per grid). */
function engineFor(grid: GridData, make: () => EngineClient): EngineClient {
  if (!engine) engine = make();
  if (engineGrid !== grid) {
    engine.init(grid.meta, grid.cost);
    engineGrid = grid;
  }
  return engine;
}
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let replanTimer: ReturnType<typeof setTimeout> | undefined;

/** Wait after the last settings change before rerouting, so dragging a slider sends one request. */
export const REPLAN_DELAY_MS = 200;

/** True if `cell` is inside the grid and not blocked in `cost.bin`. */
export function isWalkable(grid: GridData, cell: Cell): boolean {
  const { width, height } = grid.meta;
  if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y)) return false;
  if (cell.x < 0 || cell.y < 0 || cell.x >= width || cell.y >= height) return false;
  return Number.isFinite(grid.cost[cell.y * width + cell.x]!);
}

/** A crew-added stop; the science fields stay blank until someone fills them in. */
function customStop(cell: Cell, existing: Stop[]): Stop {
  let n = 1;
  while (existing.some((s) => s.id === `custom-${n}`)) n++;
  return {
    id: `custom-${n}`,
    name: `Custom stop ${n}`,
    cell,
    goal: '',
    geologyUnit: 'Unknown',
    minerals: [],
    photo: '',
    scienceValue: 1,
  };
}

/** App-wide UI state. Plan/Walk features add their slices here. */
export const useAppStore = create<AppState>()((set, get) => ({
  mode: 'plan',
  setMode: (mode) => {
    if (mode === get().mode) return;
    // Leaving Walk pauses the replay; it resumes from the same spot.
    const replay = get().replay;
    set({ mode, replay: replay.status === 'playing' ? { ...replay, status: 'paused' } : replay });
    // Plan mode always shows the plan from the habitat, so a replanned walk ends here.
    if (mode === 'plan' && get().replanned) {
      void get().planRoute();
      return;
    }
    refreshAlerts();
    // The ring means "now" in Walk and "as planned" in Plan.
    if (mode === 'walk' || get().layers.ring) void get().planRing();
  },

  data: { status: 'idle' },
  loadData: async (baseUrl = DATA_URL) => {
    if (get().data.status === 'loading') return;
    set({ data: { status: 'loading' } });
    try {
      const grid = await loadGrid(baseUrl);
      set({
        data: { status: 'ready', grid },
        stops: grid.stops,
        selectedStopId: null,
        constraints: clampConstraints(get().constraints, grid.meta.maxSlopeDeg),
      });
    } catch (err) {
      set({ data: { status: 'error', message: errorMessage(err) } });
      return;
    }
    await get().planRoute();
  },

  stops: [],
  addStop: (cell) => {
    const data = get().data;
    if (data.status !== 'ready' || !isWalkable(data.grid, cell)) return false;
    set({ stops: [...get().stops, customStop(cell, get().stops)] });
    void get().planRoute();
    return true;
  },
  moveStop: (id, cell) => {
    const data = get().data;
    if (data.status !== 'ready' || !isWalkable(data.grid, cell)) return false;
    set({ stops: get().stops.map((s) => (s.id === id ? { ...s, cell } : s)) });
    void get().planRoute();
    return true;
  },
  removeStop: (id) => {
    set({
      stops: get().stops.filter((s) => s.id !== id),
      selectedStopId: get().selectedStopId === id ? null : get().selectedStopId,
    });
    void get().planRoute();
  },

  selectedStopId: null,
  selectStop: (id) => set({ selectedStopId: id && get().stops.some((s) => s.id === id) ? id : null }),

  notice: null,
  showNotice: (message) => {
    clearTimeout(noticeTimer);
    set({ notice: message });
    noticeTimer = setTimeout(() => set({ notice: null }), 3000);
  },

  constraints: DEFAULT_CONSTRAINTS,
  setConstraints: (patch) => {
    const data = get().data;
    const gridMax = data.status === 'ready' ? data.grid.meta.maxSlopeDeg : DEFAULT_CONSTRAINTS.maxSlopeDeg;
    set({ constraints: clampConstraints({ ...get().constraints, ...patch }, gridMax) });
    clearTimeout(replanTimer);
    replanTimer = setTimeout(() => void get().planRoute(), REPLAN_DELAY_MS);
  },
  route: { status: 'idle' },
  planRoute: async () => {
    const data = get().data;
    if (data.status !== 'ready') return;
    const { grid } = data;
    const seq = ++planSeq;
    set({ route: { status: 'planning' } });
    try {
      const result = await engineFor(grid, get().makeEngine).route({ start: grid.meta.habitat, stops: get().stops, constraints: get().constraints });
      // A new route starts a new walk: the old position indexed the old path.
      if (seq === planSeq) {
        replanSeq++; // a replan still in flight is for the old route
        set({ route: { status: 'ready', result }, walk: null, replay: { ...IDLE_REPLAY, speed: get().replay.speed }, replanned: null, replanning: false });
        refreshAlerts();
      }
    } catch (err) {
      if (seq === planSeq) set({ route: { status: 'error', message: errorMessage(err) } });
    }
    // Constraints changes reroute through here, so the ring follows them too.
    if (get().layers.ring || get().mode === 'walk') await get().planRing();
  },

  layers: { difficulty: false, sand: false, ring: false },
  toggleLayer: (id) => {
    const on = !get().layers[id];
    set({ layers: { ...get().layers, [id]: on } });
    if (id === 'ring' && on) void get().planRing();
  },
  ring: null,
  planRing: async () => {
    const data = get().data;
    if (data.status !== 'ready') return;
    const seq = ++ringSeq;
    const oxygen = ringOxygenNow(get());
    ringOxygen = oxygen;
    ringBusy = true;
    try {
      const ring = await engineFor(data.grid, get().makeEngine).ring(oxygen);
      if (seq === ringSeq) set({ ring });
    } catch (err) {
      if (seq === ringSeq) {
        set({ ring: null });
        get().showNotice(`Couldn't compute the turn-back ring: ${errorMessage(err)}`);
      }
    } finally {
      if (seq === ringSeq) ringBusy = false;
    }
  },

  walk: null,
  setWalk: (walk) => set({ walk }),

  replay: IDLE_REPLAY,
  playWalk: () => {
    const route = get().route;
    if (route.status !== 'ready' || route.result.timeMin <= 0) return;
    const replay = get().replay;
    // Play from the end starts over.
    const elapsedMin = replay.status === 'done' ? 0 : replay.elapsedMin;
    moveWalk({ ...replay, status: 'playing', elapsedMin });
  },
  pauseWalk: () => {
    if (get().replay.status === 'playing') set({ replay: { ...get().replay, status: 'paused' } });
  },
  resetWalk: () => {
    // After a replan the planned route is gone; plan it again from the habitat.
    if (get().replanned) {
      void get().planRoute();
      return;
    }
    set({ walk: null, replay: { ...IDLE_REPLAY, speed: get().replay.speed } });
    refreshAlerts();
    if (get().mode === 'walk') void get().planRing();
  },
  seekWalk: (fraction) => {
    const route = get().route;
    if (route.status !== 'ready') return;
    const replay = get().replay;
    const elapsedMin = Math.min(1, Math.max(0, fraction)) * route.result.timeMin;
    const status = elapsedMin >= route.result.timeMin ? 'done' : replay.status === 'playing' ? 'playing' : 'paused';
    moveWalk({ ...replay, status, elapsedMin }, true);
  },
  setWalkSpeed: (speed) => set({ replay: { ...get().replay, speed } }),
  tickWalk: (dtRealSec) => {
    const route = get().route;
    const replay = get().replay;
    if (route.status !== 'ready' || replay.status !== 'playing' || get().replanning) return;
    moveWalk(advance(replay, dtRealSec, route.result.timeMin));
  },

  alerts: [],
  replanned: null,
  replanning: false,
  replanWalk: async () => {
    const { data, route } = get();
    if (data.status !== 'ready' || route.status !== 'ready' || get().replanning) return;
    const { grid } = data;
    const current = route.result;
    const walk = get().walk ?? { pathIdx: 0, oxygenLeftMin: startOxygen(get()) };
    const p = positionAt(current.path, walk.pathIdx);
    const from = { x: Math.round(p.x), y: Math.round(p.y) };
    // Stops still ahead on the current route, in order.
    const aheadIds = current.legs.filter((l) => l.endIdx > walk.pathIdx && l.toId !== START_ID).map((l) => l.toId);
    const ahead = aheadIds.flatMap((id) => get().stops.filter((s) => s.id === id));

    const seq = ++replanSeq;
    set({ replanning: true });
    try {
      const result = await engineFor(grid, get().makeEngine).replan(from, ahead, get().constraints, walk.oxygenLeftMin);
      if (seq !== replanSeq) return;
      if (result.path.length < 2) {
        const atHome = from.x === grid.meta.habitat.x && from.y === grid.meta.habitat.y;
        get().showNotice(atHome ? 'Already at the habitat: nothing to replan.' : "Can't find a walkable way home from here.");
        return;
      }
      const before = get().replanned;
      const dropped = new Set([...(before?.droppedIds ?? []), ...result.outOfRangeIds]);
      const replay = get().replay;
      set({
        route: { status: 'ready', result },
        walk: { pathIdx: 0, oxygenLeftMin: walk.oxygenLeftMin },
        replanned: {
          droppedIds: get().stops.filter((s) => dropped.has(s.id)).map((s) => s.id),
          startOxygenMin: walk.oxygenLeftMin,
          offsetMin: (before?.offsetMin ?? 0) + replay.elapsedMin,
        },
        // Carry on from the start of the new route; a finished or unstarted walk waits for Play.
        replay: { ...replay, elapsedMin: 0, status: replay.status === 'playing' ? 'playing' : 'paused' },
      });
      refreshAlerts();
      void get().planRing();
    } catch (err) {
      if (seq === replanSeq) get().showNotice(`Couldn't replan: ${errorMessage(err)}`);
    } finally {
      if (seq === replanSeq) set({ replanning: false });
    }
  },

  makeEngine: createWorkerEngine,
}));

/** Usable oxygen the ring should be drawn for: right now in Walk mode, as planned otherwise. */
function ringOxygenNow(s: AppState): number {
  const { oxygenMin, reservePct } = s.constraints;
  if (s.mode !== 'walk' || !s.walk) return usableOxygenMin(oxygenMin, reservePct);
  return Math.max(0, s.walk.oxygenLeftMin - (oxygenMin * reservePct) / 100);
}

/** Oxygen in the tank at the start of the route being walked. */
function startOxygen(s: AppState): number {
  return s.replanned?.startOxygenMin ?? s.constraints.oxygenMin;
}

/** Runs `checkAlerts` for where the crew is now (Walk mode only). */
function refreshAlerts(): void {
  const s = useAppStore.getState();
  if (s.mode !== 'walk' || s.route.status !== 'ready' || s.data.status !== 'ready' || s.route.result.path.length === 0) {
    if (s.alerts.length > 0) useAppStore.setState({ alerts: [] });
    return;
  }
  const route = s.route.result;
  const walk = s.walk ?? { pathIdx: 0, oxygenLeftMin: startOxygen(s) };
  const alerts = checkAlerts(positionAt(route.path, walk.pathIdx), route, s.constraints, walk.oxygenLeftMin, s.data.grid);
  // Keep the same array while nothing changed, so the banner doesn't re-render every frame.
  const same = alerts.length === s.alerts.length && alerts.every((a, i) => a.kind === s.alerts[i]!.kind && a.severity === s.alerts[i]!.severity && a.message === s.alerts[i]!.message);
  if (!same) useAppStore.setState({ alerts });
}

/** Applies a replay clock: moves the crew, checks alerts, and refreshes the ring as the oxygen drops. */
function moveWalk(replay: Replay, forceRing = false): void {
  const s = useAppStore.getState();
  if (s.route.status !== 'ready' || s.data.status !== 'ready') return;
  useAppStore.setState({ replay, walk: walkAt(s.route.result, { oxygenMin: startOxygen(s) }, s.data.grid.meta, replay.elapsedMin) });
  refreshAlerts();
  if (useAppStore.getState().mode !== 'walk') return;
  const oxygen = ringOxygenNow(useAppStore.getState());
  const stale = ringOxygen === null || Math.abs(oxygen - ringOxygen) >= RING_STEP_MIN;
  // One request at a time: the next tick picks up whatever changed meanwhile.
  if (forceRing || replay.status === 'done' || (stale && !ringBusy)) void useAppStore.getState().planRing();
}

/** Drops the cached engine (tests, or after swapping the factory). */
export function resetEngine(): void {
  ringOxygen = null;
  ringBusy = false;
  replanSeq++;
  clearTimeout(replanTimer);
  engine?.terminate();
  engine = null;
  engineGrid = null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
