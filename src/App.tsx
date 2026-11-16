import { Suspense, lazy, useEffect, useState } from 'react';
import { AboutButton, Brief, BriefButton } from './brief/Brief.tsx';
import { parseHash } from './brief/share.ts';
import { MapView } from './map/MapView.tsx';
import { RoutePanel } from './plan/RoutePanel.tsx';
import { SpaceWeatherChip } from './SpaceWeatherChip.tsx';
import { SettingsPanel } from './plan/SettingsPanel.tsx';
import { StopCard } from './plan/StopCard.tsx';
import { SiteSwitcher } from './SiteSwitcher.tsx';
import { FirstVisitPrompt, Tour, TutorialButton } from './tour/Tour.tsx';
import { useAppStore, walkWarnings } from './store.ts';
import { Hud } from './walk/Hud.tsx';
import { ViewToggle } from './view3d/ViewToggle.tsx';
import type { Mode } from './store.ts';

const TerrainView = lazy(() => import('./view3d/TerrainView.tsx').then((m) => ({ default: m.TerrainView })));

const MODES: { id: Mode; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'walk', label: 'Walk' },
];

/**
 * Plan / Walk switch (#89). Clicking Walk with a reason not to walk (EVA blocked,
 * a stop out of range) opens a warning first; Start anyway or Cancel decides.
 */
export function ModeSwitch() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  useEffect(() => {
    if (!warnings) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setWarnings(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [warnings]);

  const choose = (id: Mode) => {
    if (id === 'walk' && mode !== 'walk') {
      const found = walkWarnings(useAppStore.getState());
      if (found.length > 0) {
        setWarnings(found);
        return;
      }
    }
    setMode(id);
  };

  return (
    <>
      <div role="tablist" aria-label="Mode" className="flex rounded-md bg-white/5 p-0.5 text-sm">
        {MODES.map((m) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => choose(m.id)}
            className={`rounded px-3 py-1 transition-colors ${
              mode === m.id ? 'bg-mars text-white' : 'text-white/70 hover:text-white'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      {warnings && (
        <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Walk warning" onClick={() => setWarnings(null)}>
          <section className="w-full max-w-md space-y-3 rounded-lg bg-regolith p-4 text-sm shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold">Walk with warnings</h2>
            <ul className="list-disc pl-5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setWarnings(null)} className="rounded border border-white/40 px-3 py-1">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setWarnings(null);
                  setMode('walk');
                }}
                className="rounded bg-mars px-3 py-1 font-semibold text-white"
              >
                Start anyway (simulation)
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function App() {
  const mode = useAppStore((s) => s.mode);
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
          <h1 data-tour="logo" className="flex items-center gap-2 text-lg font-semibold tracking-wide">
            <img src="/marcia-logo.svg" alt="" aria-hidden="true" className="size-7" />
            Marcia
          </h1>
          <SiteSwitcher />
        </div>
        <div className="flex items-center gap-3">
          <SpaceWeatherChip />
          <BriefButton />
          <AboutButton />
          <TutorialButton />
          <ViewToggle />
          <ModeSwitch />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <div className={`relative flex min-h-[45vh] flex-1 flex-col ${mode === 'walk' ? 'walk-mode' : ''}`}>
          {mapKind === '3d' ? (
            <Suspense
              fallback={
                <div className="flex h-full min-h-0 flex-1 items-center justify-center text-sm text-white/70">
                  Loading 3D…
                </div>
              }
            >
              <div className="min-h-0 flex-1">
                <TerrainView />
              </div>
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
      <FirstVisitPrompt />
      <Tour />
    </div>
  );
}
