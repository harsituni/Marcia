import { create } from 'zustand';
import type { Cell, Constraints, RingResult, RouteResult, Stop } from './contracts.ts';
import { loadGrid } from './data/grid.ts';
import type { GridData } from './data/grid.ts';
import { createWorkerEngine } from './engine/client.ts';
import type { EngineClient } from './engine/client.ts';
import { usableOxygenMin } from './engine/model.ts';
import { clampConstraints } from './plan/constraints.ts';
import type { WalkState } from './walk/hud.ts';

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

  /** Engine factory; tests swap in a fake worker. */
  makeEngine: () => EngineClient;
}

let engine: EngineClient | null = null;
let engineGrid: GridData | null = null;
let planSeq = 0;
let ringSeq = 0;

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
  setMode: (mode) => set({ mode }),

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
      if (seq === planSeq) set({ route: { status: 'ready', result } });
    } catch (err) {
      if (seq === planSeq) set({ route: { status: 'error', message: errorMessage(err) } });
    }
    // Constraints changes reroute through here, so the ring follows them too.
    if (get().layers.ring) await get().planRing();
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
    const { oxygenMin, reservePct } = get().constraints;
    try {
      const ring = await engineFor(data.grid, get().makeEngine).ring(usableOxygenMin(oxygenMin, reservePct));
      if (seq === ringSeq) set({ ring });
    } catch (err) {
      if (seq === ringSeq) {
        set({ ring: null });
        get().showNotice(`Couldn't compute the turn-back ring: ${errorMessage(err)}`);
      }
    }
  },

  walk: null,
  setWalk: (walk) => set({ walk }),

  makeEngine: createWorkerEngine,
}));

/** Drops the cached engine (tests, or after swapping the factory). */
export function resetEngine(): void {
  clearTimeout(replanTimer);
  engine?.terminate();
  engine = null;
  engineGrid = null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
