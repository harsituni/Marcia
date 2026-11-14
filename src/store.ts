import { create } from 'zustand';
import type { Constraints, RouteResult } from './contracts.ts';
import { loadGrid } from './data/grid.ts';
import type { GridData } from './data/grid.ts';
import { createWorkerEngine } from './engine/client.ts';
import type { EngineClient } from './engine/client.ts';

export type Mode = 'plan' | 'walk';

/** Where the grid data comes from. M22 switches this to the real `data/`. */
export const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}fixtures`;

/** Starting constraints until the settings panel (M13) lets the crew edit them. */
export const DEFAULT_CONSTRAINTS: Constraints = { oxygenMin: 480, reservePct: 20, maxSlopeDeg: 25 };

export type DataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; grid: GridData }
  | { status: 'error'; message: string };

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

  constraints: Constraints;
  route: RouteState;
  /** Asks the engine for a route from the habitat through the current stops. */
  planRoute: () => Promise<void>;

  /** Engine factory; tests swap in a fake worker. */
  makeEngine: () => EngineClient;
}

let engine: EngineClient | null = null;
let engineGrid: GridData | null = null;
let planSeq = 0;

/** App-wide UI state. Plan/Walk features add their slices here. */
export const useAppStore = create<AppState>()((set, get) => ({
  mode: 'plan',
  setMode: (mode) => set({ mode }),

  data: { status: 'idle' },
  loadData: async (baseUrl = DATA_URL) => {
    if (get().data.status === 'loading') return;
    set({ data: { status: 'loading' } });
    try {
      set({ data: { status: 'ready', grid: await loadGrid(baseUrl) } });
    } catch (err) {
      set({ data: { status: 'error', message: errorMessage(err) } });
      return;
    }
    await get().planRoute();
  },

  constraints: DEFAULT_CONSTRAINTS,
  route: { status: 'idle' },
  planRoute: async () => {
    const data = get().data;
    if (data.status !== 'ready') return;
    const { grid } = data;
    const seq = ++planSeq;
    set({ route: { status: 'planning' } });
    try {
      if (!engine) engine = get().makeEngine();
      if (engineGrid !== grid) {
        engine.init(grid.meta, grid.cost);
        engineGrid = grid;
      }
      const result = await engine.route({ start: grid.meta.habitat, stops: grid.stops, constraints: get().constraints });
      if (seq === planSeq) set({ route: { status: 'ready', result } });
    } catch (err) {
      if (seq === planSeq) set({ route: { status: 'error', message: errorMessage(err) } });
    }
  },

  makeEngine: createWorkerEngine,
}));

/** Drops the cached engine (tests, or after swapping the factory). */
export function resetEngine(): void {
  engine?.terminate();
  engine = null;
  engineGrid = null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
