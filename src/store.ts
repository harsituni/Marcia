import { create } from 'zustand';

export type Mode = 'plan' | 'walk';

interface AppState {
  mode: Mode;
  setMode: (mode: Mode) => void;
}

/** App-wide UI state. Plan/Walk features add their slices here. */
export const useAppStore = create<AppState>()((set) => ({
  mode: 'plan',
  setMode: (mode) => set({ mode }),
}));
