import { Suspense, lazy, useEffect } from 'react';
import { Brief, BriefButton } from './brief/Brief.tsx';
import { parseHash } from './brief/share.ts';
import { MapView } from './map/MapView.tsx';
import { RoutePanel } from './plan/RoutePanel.tsx';
import { SpaceWeatherChip } from './SpaceWeatherChip.tsx';
import { SettingsPanel } from './plan/SettingsPanel.tsx';
import { StopCard } from './plan/StopCard.tsx';
import { SiteSwitcher } from './SiteSwitcher.tsx';
import { useAppStore } from './store.ts';
import { Hud } from './walk/Hud.tsx';
import { ViewToggle } from './view3d/ViewToggle.tsx';
import type { Mode } from './store.ts';

const TerrainView = lazy(() => import('./view3d/TerrainView.tsx').then((m) => ({ default: m.TerrainView })));

const MODES: { id: Mode; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'walk', label: 'Walk' },
];

export function App() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const mapKind = useAppStore((s) => s.mapKind);
  const loadData = useAppStore((s) => s.loadData);

  useEffect(() => {
    // A share link (M37) restores its plan instead of loading the default site.
    const req = parseHash(location.hash);
    const s = useAppStore.getState();
    if (req.kind === 'shared') {
      void s.restoreShared(req.plan);
      return;
    }
    if (req.kind === 'error') s.showNotice(req.message);
    void loadData().then(() => {
      if (req.kind === 'brief') useAppStore.getState().setBriefOpen(true);
    });
  }, [loadData]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <h1 className="text-lg font-semibold tracking-wide">
            <span className="text-mars">●</span> Marcia
          </h1>
          <SiteSwitcher />
        </div>
        <div className="flex items-center gap-3">
          <SpaceWeatherChip />
          <BriefButton />
          <ViewToggle />
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
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <div className={`relative min-h-0 flex-1 ${mode === 'walk' ? 'walk-mode' : ''}`}>
          {mapKind === '3d' ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-white/70">Loading 3D…</div>
              }
            >
              <TerrainView />
            </Suspense>
          ) : (
            <MapView />
          )}
          {mode === 'plan' && <SettingsPanel />}
          {mode === 'walk' && <Hud />}
          <StopCard />
        </div>
        {mode === 'plan' && <RoutePanel />}
      </main>
      <Brief />
    </div>
  );
}
