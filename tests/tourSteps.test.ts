// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeSwitch } from '../src/App.tsx';
import { AboutButton, BriefButton } from '../src/brief/Brief.tsx';
import { EngineClient } from '../src/engine/client.ts';
import { SiteSwitcher } from '../src/SiteSwitcher.tsx';
import { SpaceWeatherChip } from '../src/SpaceWeatherChip.tsx';
import { DEFAULT_CONSTRAINTS, resetEngine, useAppStore } from '../src/store.ts';
import { makeTourApi, waitForStore } from '../src/tour/api.ts';
import { START_CHAPTER, liveDataPausedNote } from '../src/tour/chapters/start.ts';
import { CHAPTERS } from '../src/tour/steps.ts';
import { ViewToggle } from '../src/view3d/ViewToggle.tsx';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIX = join(import.meta.dirname, '..', 'fixtures');
const SRC = join(import.meta.dirname, '..', 'src');
const store = () => useAppStore.getState();
const flush = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Every .ts/.tsx under src/ except the tutorial itself (its selectors would match themselves). */
function sourceText(dir = SRC): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p !== join(SRC, 'tour')) out += sourceText(p);
    } else if (/\.tsx?$/.test(name)) out += readFileSync(p, 'utf8');
  }
  return out;
}

let worker: FakeWorker;

beforeEach(async () => {
  resetEngine();
  worker = new FakeWorker();
  useAppStore.setState({
    makeEngine: () => new EngineClient(worker),
    fetchDonki: async () => {
      throw new Error('offline');
    },
    mode: 'plan',
    siteId: 'jezero',
  });
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  await store().loadData('/fixtures');
});

afterEach(async () => {
  if (store().tour.active) await store().endTour();
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], avoidZones: [], drawingZone: null, mode: 'plan', briefOpen: false });
});

describe('live-data paused note', () => {
  const live = { status: 'clear' as const, reasons: [], fetchedAt: '2026-11-15T00:00:00Z', missing: [] as string[] };
  const note = (sw: Partial<ReturnType<typeof useAppStore.getState>['spaceWeather']>) =>
    liveDataPausedNote({ ...useAppStore.getState(), spaceWeather: { assessment: null, stale: false, loading: false, error: null, demo: false, ...sw } });

  it('says nothing while DONKI is live, still loading, or the storm demo is on', () => {
    expect(note({ assessment: live })).toBeNull();
    expect(note({ loading: true, error: 'HTTP 429' })).toBeNull();
    expect(note({ demo: true, error: 'HTTP 429' })).toBeNull();
  });

  it('says live space weather is paused when DONKI is unreachable, stale or has gaps', () => {
    expect(note({ error: 'DONKI unavailable (SEP: HTTP 429)' })).toMatch(/paused: NASA DONKI can't be reached/);
    expect(note({ assessment: live, stale: true, error: 'HTTP 429' })).toMatch(/last saved check/);
    expect(note({ assessment: { ...live, missing: ['FLR'] } })).toMatch(/Part of the live feed is paused right now \(no data from FLR\)/);
  });

  it('is on both space-weather steps', () => {
    for (const id of ['space-weather-chip', 'space-weather-panel']) {
      expect(START_CHAPTER.steps.find((s) => s.id === id)!.note).toBe(liveDataPausedNote);
    }
  });
});

describe('chapters as data', () => {
  it('has unique chapter ids and unique step ids within each chapter', () => {
    const ids = CHAPTERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CHAPTERS) {
      const steps = c.steps.map((s) => s.id);
      expect(new Set(steps).size, c.id).toBe(steps.length);
      expect(c.title && c.summary, c.id).toBeTruthy();
    }
  });

  it('gives every step a title and body, and every action a prompt', () => {
    for (const c of CHAPTERS)
      for (const s of c.steps) {
        expect(s.title.trim(), `${c.id}/${s.id}`).not.toBe('');
        expect(s.body.trim(), `${c.id}/${s.id}`).not.toBe('');
        if (s.action) expect(s.action.prompt.trim(), `${c.id}/${s.id}`).not.toBe('');
      }
  });

  /** Leaflet's own class names: stable, but not ours to label. */
  const LEAFLET = new Set(['.leaflet-container', '.leaflet-marker-draggable']);

  it('only the Welcome step uses a centred card', () => {
    for (const c of CHAPTERS)
      for (const s of c.steps) {
        if (s.id === 'welcome') {
          expect(s.placement).toBe('center');
          continue;
        }
        expect(s.placement, `${c.id}/${s.id}`).not.toBe('center');
        expect(s.target, `${c.id}/${s.id}`).not.toBeNull();
      }
  });

  it('only targets aria-labels and data-tour anchors that exist in src/', () => {
    const src = sourceText();
    for (const c of CHAPTERS)
      for (const s of c.steps) {
        if (s.target === null || LEAFLET.has(s.target)) continue;
        if (s.target === '[data-tour="tutorial"]') continue; // the Tutorial button lives in src/tour
        const where = `${c.id}/${s.id}: ${s.target}`;
        const labels = [...s.target.matchAll(/aria-label(\^?)="([^"]+)"/g)];
        const anchors = [...s.target.matchAll(/data-tour="([^"]+)"/g)];
        const controls = [...s.target.matchAll(/aria-controls="([^"]+)"/g)];
        expect(labels.length + anchors.length + controls.length, where).toBeGreaterThan(0);
        for (const [, id] of controls) expect(src.includes(`aria-controls="${id}"`), where).toBe(true);
        for (const [, prefix, label] of labels) {
          // A prefix label may be built in code (e.g. ariaLabel={`Return margin: ${…}`}), so a string starting with it counts.
          const found = prefix
            ? src.includes(`aria-label="${label}`) || src.includes(`aria-label={\`${label}`) || src.includes(`\`${label}`) || src.includes(`'${label}`)
            : src.includes(`aria-label="${label}"`);
          expect(found, where).toBe(true);
        }
        for (const [, anchor] of anchors) expect(src.includes(`data-tour="${anchor}"`), where).toBe(true);
      }
  });
});

describe('every setup and Show me', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    // The header controls chapter 1 points at (the map itself is never mounted in tests).
    await act(async () =>
      root.render(
        createElement('div', null, createElement(SiteSwitcher), createElement(SpaceWeatherChip), createElement(BriefButton), createElement(AboutButton), createElement(ViewToggle), createElement(ModeSwitch)),
      ),
    );
    await act(async () => store().startTour());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  // Only chapter 1: its controls are mounted above. Chapters 2-6 run their steps in
  // tests/tourPlanChapters.test.tsx and tests/tourWalkChapters.test.ts with their own components.
  for (const c of [START_CHAPTER])
    for (const s of c.steps)
      it(`${c.id}/${s.id} runs on the fixture store`, async () => {
        const api = makeTourApi();
        await act(async () => {
          await s.setup?.(api);
        });
        await flush();
        if (s.target) expect(document.querySelector(s.target), `target ${s.target}`).not.toBeNull();
        if (!s.action) return;
        await act(async () => {
          await s.action!.doIt(api);
        });
        await flush(20);
        expect(s.action.done(store(), document)).toBe(true);
      });
});

describe('practice run and restore', () => {
  it('starts on the preset stops in Plan mode and puts everything back exactly, engine zones included', async () => {
    const grid = store().data.status === 'ready' ? (store().data as { grid: { stops: unknown[] } }).grid : null;
    expect(grid).not.toBeNull();

    // The crew's own setup.
    store().removeStop(store().stops[0]!.id);
    store().setConstraints({ oxygenMin: 300, reservePct: 30 });
    store().toggleLayer('difficulty');
    store().setColorVision('deuteranopia');
    store().startZone();
    for (const cell of [{ x: 2, y: 2 }, { x: 6, y: 2 }, { x: 4, y: 6 }]) store().addZonePoint(cell);
    expect(store().finishZone()).toBe(true);
    store().setSpaceWeatherDemo(true);
    store().setMapKind('3d');
    store().setBriefOpen(true);
    await waitForStore((s) => s.route.status === 'ready');
    store().setMode('walk');
    await flush(250);

    const before = {
      stops: store().stops,
      constraints: store().constraints,
      layers: store().layers,
      colorVision: store().colorVision,
      avoidZones: store().avoidZones,
      demo: store().spaceWeather.demo,
      mode: store().mode,
      mapKind: store().mapKind,
      briefOpen: store().briefOpen,
    };

    worker.sent.length = 0;
    await store().startTour();
    expect(store().tour).toEqual({ active: true, chapter: null, step: 0 });
    expect(store().stops).toEqual(grid!.stops);
    expect(store().avoidZones).toEqual([]);
    expect(store().constraints).toEqual(DEFAULT_CONSTRAINTS);
    expect(store().mode).toBe('plan');
    expect(store().mapKind).toBe('2d');
    expect(store().spaceWeather.demo).toBe(false);
    expect(store().briefOpen).toBe(false);
    expect(Object.values(store().layers).every((on) => !on)).toBe(true);
    expect(worker.sent.some((m) => m.type === 'avoid' && m.zones.length === 0)).toBe(true);

    // Practice changes are thrown away.
    store().addStop(store().stops[0]!.cell);
    store().setConstraints({ maxSlopeDeg: 10 });

    worker.sent.length = 0;
    await store().endTour();
    await waitForStore((s) => s.route.status === 'ready');
    expect(store().tour.active).toBe(false);
    expect(store().stops).toEqual(before.stops);
    expect(store().constraints).toEqual(before.constraints);
    expect(store().layers).toEqual(before.layers);
    expect(store().colorVision).toBe(before.colorVision);
    expect(store().avoidZones).toEqual(before.avoidZones);
    expect(store().spaceWeather.demo).toBe(before.demo);
    expect(store().mode).toBe(before.mode);
    expect(store().mapKind).toBe(before.mapKind);
    expect(store().briefOpen).toBe(before.briefOpen);
    expect(worker.sent.some((m) => m.type === 'avoid' && JSON.stringify(m.zones) === JSON.stringify(before.avoidZones))).toBe(true);

    // The settings timer from the practice run doesn't fire into the restored plan.
    await flush(300);
    expect(store().constraints).toEqual(before.constraints);
  });

  it('opening a chapter mid-tour starts a fresh practice run but keeps the saved setup', async () => {
    store().setConstraints({ oxygenMin: 300 });
    const saved = store().constraints;
    await store().startTour('getting-started');
    store().setConstraints({ oxygenMin: 200 });
    await store().startTour('getting-started');
    expect(store().constraints).toEqual(DEFAULT_CONSTRAINTS);
    await store().endTour();
    expect(store().constraints).toEqual(saved);
  });
});
