import { create } from 'zustand';
import { loadGrid } from './data/grid.ts';
import type { GridData } from './data/grid.ts';

export type Mode = 'plan' | 'walk';

/** Where the grid data comes from. M22 switches this to the real `data/`. */
export const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}fixtures`;

export type DataState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; grid: GridData }
  | { status: 'error'; message: string };

interface AppState {
  mode: Mode;
  setMode: (mode: Mode) => void;

  data: DataState;
  loadData: (baseUrl?: string) => Promise<void>;
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
      set({ data: { status: 'ready', grid: await loadGrid(baseUrl) } });
    } catch (err) {
      set({ data: { status: 'error', message: err instanceof Error ? err.message : String(err) } });
    }
  },
}));
