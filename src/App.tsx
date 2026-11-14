import { MapView } from './map/MapView.tsx';
import { useAppStore } from './store.ts';
import type { Mode } from './store.ts';

const MODES: { id: Mode; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'walk', label: 'Walk' },
];

export function App() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-2">
        <h1 className="text-lg font-semibold tracking-wide">
          <span className="text-mars">●</span> Marcia
        </h1>
        <div role="tablist" aria-label="Mode" className="flex rounded-md bg-white/5 p-0.5 text-sm">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => setMode(m.id)}
              className={`rounded px-3 py-1 transition-colors ${
                mode === m.id ? 'bg-mars text-white' : 'text-white/70 hover:text-white'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </header>
      <main className="relative flex-1">
        <MapView />
      </main>
    </div>
  );
}
