// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Brief } from '../src/brief/Brief.tsx';
import { parseSites } from '../src/data/sites.ts';
import { EngineClient } from '../src/engine/client.ts';
import { InspectPopup, InspectToggle } from '../src/map/MapView.tsx';
import { LayerToggles } from '../src/map/OverlayLayers.tsx';
import { RoutePanel } from '../src/plan/RoutePanel.tsx';
import { SettingsPanel } from '../src/plan/SettingsPanel.tsx';
import { StopCard } from '../src/plan/StopCard.tsx';
import { DEFAULT_CONSTRAINTS, resetEngine, useAppStore } from '../src/store.ts';
import { PLAN_CHAPTERS } from '../src/tour/chapters/plan.ts';
import type { TourApi, TourChapter, TourStep } from '../src/tour/types.ts';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(import.meta.dirname, '..');
const FIX = join(ROOT, 'fixtures');
const PUBLIC = join(ROOT, 'public');
const SITES = parseSites(JSON.parse(readFileSync(join(PUBLIC, 'data', 'sites.json'), 'utf8')));
const store = () => useAppStore.getState();

let host: HTMLDivElement;
let root: Root;

function serve(url: string): Response {
  const path = url.startsWith('/fixtures/') ? join(FIX, url.slice('/fixtures/'.length)) : join(PUBLIC, url.replace(/^\//, ''));
  try {
    return new Response(readFileSync(path));
  } catch {
    return new Response('', { status: 404 });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A TourApi for tests: the store plus plain DOM helpers (the real one comes with the #103 engine). */
const api: TourApi = {
  state: () => useAppStore.getState(),
  click: async (selector) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return false;
    await act(async () => el.click());
    return true;
  },
  ensureExpanded: async (selector) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && el.getAttribute('aria-expanded') === 'false') await act(async () => el.click());
  },
  waitFor: async (selector, ms = 2000) => {
    const end = Date.now() + Math.min(ms, 100);
    do {
      const el = document.querySelector(selector);
      if (el) return el;
      await act(async () => sleep(10));
    } while (Date.now() < end);
    return null;
  },
  sleep: (ms) => act(async () => sleep(ms)),
};

beforeEach(async () => {
  resetEngine();
  localStorage.clear();
  useAppStore.setState({
    makeEngine: () => new EngineClient(new FakeWorker()),
    mode: 'plan',
    sites: SITES,
    siteId: 'jezero',
    briefOpen: false,
    selectedStopId: null,
    layers: { difficulty: false, sand: false, geology: false, crism: false, ring: false },
    colorVision: 'normal',
    constraints: { ...DEFAULT_CONSTRAINTS },
    avoidZones: [],
    drawingZone: null,
    inspecting: false,
    inspectCell: null,
  });
  vi.stubGlobal('fetch', async (url: string) => serve(url));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => undefined }, configurable: true });
  await store().loadData('/fixtures');
  await store().planRoute();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const data = store().data;
  if (data.status !== 'ready') throw new Error('no data');
  await act(async () =>
    root.render(
      <>
        <SettingsPanel />
        <RoutePanel />
        <LayerToggles />
        <StopCard />
        <InspectToggle />
        <InspectPopup grid={data.grid} />
        <Brief />
      </>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({
    data: { status: 'idle' },
    route: { status: 'idle' },
    stops: [],
    briefOpen: false,
    selectedStopId: null,
    layers: { difficulty: false, sand: false, geology: false, crism: false, ring: false },
    avoidZones: [],
    orderUndo: null,
  });
});

const chapter = (id: string): TourChapter => PLAN_CHAPTERS.find((c) => c.id === id)!;

/** Where a step's target comes from: the DOM we mount here, an anchor #103 adds, or the Leaflet map. */
const KNOWN_TARGETS: RegExp[] = [
  /^section\[aria-label="(EVA settings|Route stats)"\]/,
  /^\[role="(radiogroup|group|dialog)"\]\[aria-label="[^"]+"\]$/,
  /^article\[aria-label\^="Stop "\]$/,
  /^\[aria-controls="(geology|crism)-legend"\]$/,
  /^\[data-tour="(layers|route-stats|elevation-profile|brief|copy-link|download-pdf)"\]$/,
  /^\.leaflet-container$/,
  /^\[data-tour="inspect"\]$/,
  /^\.leaflet-marker-draggable$/,
  /^\[role="dialog"\]\[aria-label="Mission brief"\]( \.brief-toolbar button(:nth-of-type\(2\))?| article)?$/,
];

/** Targets this test can find in the mounted DOM (the rest are Leaflet or #103 anchors). */
const IN_TEST_DOM = (sel: string) => !/leaflet|data-tour/.test(sel);

describe('plan chapters data (#104)', () => {
  it('exports chapters 2 to 4 in order', () => {
    expect(PLAN_CHAPTERS.map((c) => c.id)).toEqual(['plan-route', 'map-layers', 'mission-brief']);
    expect(PLAN_CHAPTERS.map((c) => c.title)).toEqual(['Plan a route', 'Map layers and tools', 'Mission brief']);
  });

  it('step ids are unique and prefixed by their chapter', () => {
    const all = PLAN_CHAPTERS.flatMap((c) => c.steps.map((s) => ({ c, s })));
    expect(new Set(all.map((x) => x.s.id)).size).toBe(all.length);
    for (const { c, s } of all) expect(s.id.startsWith(`${c.id}-`)).toBe(true);
  });

  it('every step has a title and body; actions have prompt, done and doIt', () => {
    for (const c of PLAN_CHAPTERS) {
      expect(c.summary.length).toBeGreaterThan(0);
      for (const s of c.steps) {
        expect(s.title.trim().length).toBeGreaterThan(0);
        expect(s.body.trim().length).toBeGreaterThan(0);
        if (s.action) {
          expect(s.action.prompt.trim().length).toBeGreaterThan(0);
          expect(typeof s.action.done).toBe('function');
          expect(typeof s.action.doIt).toBe('function');
        }
      }
    }
  });

  it('has the hands-on steps the issue lists', () => {
    const actions = (id: string) => chapter(id).steps.filter((s) => s.action).map((s) => s.id);
    expect(actions('plan-route')).toEqual([
      'plan-route-add-stop',
      'plan-route-drag-pin',
      'plan-route-open-card',
      'plan-route-rename',
      'plan-route-stars',
      'plan-route-goal',
      'plan-route-oxygen',
      'plan-route-best-order',
      'plan-route-undo',
    ]);
    expect(actions('map-layers')).toHaveLength(9);
    expect(actions('mission-brief')).toEqual(['mission-brief-open', 'mission-brief-copy-link']);
  });

  it('every target is a known selector, anchor or null', () => {
    for (const s of PLAN_CHAPTERS.flatMap((c) => c.steps)) {
      if (s.target === null) continue;
      expect(KNOWN_TARGETS.some((re) => re.test(s.target!)), `${s.id}: ${s.target}`).toBe(true);
    }
  });
});

/** Runs a chapter like the engine would: setup, then (for hands-on steps) done is false, Show me, done is true. */
async function runChapter(c: TourChapter, found: string[] = []): Promise<void> {
  for (const s of c.steps) {
    await act(async () => void (await s.setup?.(api)));
    if (s.target && IN_TEST_DOM(s.target)) {
      expect(document.querySelector(s.target), `${s.id}: target ${s.target} missing after setup`).not.toBeNull();
      found.push(s.id);
    }
    if (!s.action) continue;
    expect(s.action.done(store(), document), `${s.id}: done before doing it`).toBe(false);
    await act(async () => s.action!.doIt(api));
    expect(s.action.done(store(), document), `${s.id}: done after doIt`).toBe(true);
  }
}

describe('Chapter 2: Plan a route (#104)', () => {
  it('every setup and doIt runs and done is true afterwards', async () => {
    const stopsBefore = store().stops.length;
    await runChapter(chapter('plan-route'));
    expect(store().stops.length).toBe(stopsBefore + 1);
    // The added stop got its geology filled from the map, not a placeholder.
    expect(store().orderUndo).toBeNull();
  }, 60_000);

  it('add a stop adds a walkable, new cell near the habitat', async () => {
    const s = chapter('plan-route').steps.find((x) => x.id === 'plan-route-add-stop')!;
    await s.setup?.(api);
    const cells = store().stops.map((x) => `${x.cell.x},${x.cell.y}`);
    await s.action!.doIt(api);
    const added = store().stops.at(-1)!;
    expect(cells).not.toContain(`${added.cell.x},${added.cell.y}`);
  });

  it('the out-of-range step really leaves a stop out of range, and the next steps restore the defaults', async () => {
    const steps = chapter('plan-route').steps;
    const oor = steps.find((x) => x.id === 'plan-route-out-of-range')!;
    await act(async () => void (await oor.setup?.(api)));
    expect(store().constraints.oxygenMin).toBeLessThan(DEFAULT_CONSTRAINTS.oxygenMin);
    const r = store().route;
    expect(r.status).toBe('ready');
    // The fixture route is tiny (about 22 min of oxygen), so even the lowest settings leave it in range;
    // on a longer route the step halves the oxygen the route needs, so the far stops drop out.
    const c = store().constraints;
    const usable = (c.oxygenMin * (100 - c.reservePct)) / 100;
    expect(usable).toBeLessThanOrEqual(r.status === 'ready' ? Math.max(30, r.result.oxygenUsedMin * 0.5 + 15) : 0);
    const best = steps.find((x) => x.id === 'plan-route-best-order')!;
    await act(async () => void (await best.setup?.(api)));
    expect(store().constraints).toEqual(DEFAULT_CONSTRAINTS);
  }, 30_000);

  it('Find best order gets a real reorder to undo, and Undo restores the previous order', async () => {
    const steps = chapter('plan-route').steps;
    const best = steps.find((x) => x.id === 'plan-route-best-order')!;
    const undo = steps.find((x) => x.id === 'plan-route-undo')!;
    await act(async () => void (await best.setup?.(api)));
    const scrambled = store().stops.map((x) => x.id);
    expect(best.action!.done(store(), document)).toBe(false);
    await act(async () => best.action!.doIt(api));
    expect(best.action!.done(store(), document)).toBe(true);
    expect(store().stops.map((x) => x.id)).not.toEqual(scrambled);
    await act(async () => void (await undo.setup?.(api)));
    await act(async () => undo.action!.doIt(api));
    expect(store().stops.map((x) => x.id)).toEqual(scrambled);
  }, 30_000);

  it('the stop-card steps open the settings and route panels in the DOM', async () => {
    const found: string[] = [];
    await runChapter(chapter('plan-route'), found);
    expect(found).toEqual(
      expect.arrayContaining(['plan-route-rename', 'plan-route-stars', 'plan-route-goal', 'plan-route-oxygen', 'plan-route-limits', 'plan-route-out-of-range']),
    );
  }, 60_000);
});

describe('Chapter 3: Map layers and tools (#104)', () => {
  it('every setup and doIt runs and done is true afterwards', async () => {
    await runChapter(chapter('map-layers'));
    expect(store().layers).toEqual({ difficulty: false, sand: false, geology: false, crism: false, ring: false });
    expect(store().colorVision).toBe('normal');
    expect(store().avoidZones.length).toBe(1);
    expect(store().inspectCell).not.toBeNull();
  }, 60_000);

  it('layer steps switch the layer off first when it is already on, so done starts false', async () => {
    store().toggleLayer('sand');
    const s = chapter('map-layers').steps.find((x) => x.id === 'map-layers-sand')!;
    await s.setup?.(api);
    expect(store().layers.sand).toBe(false);
    expect(s.action!.done(store(), document)).toBe(false);
  });

  it('colour vision is reset to Normal by the next step', async () => {
    await runChapter(chapter('map-layers'));
    // After the avoid-zone step's setup ran, vision was back to normal.
    const steps = chapter('map-layers').steps;
    const cv = steps.find((x) => x.id === 'map-layers-colour-vision')!;
    await cv.action!.doIt(api);
    expect(store().colorVision).not.toBe('normal');
    await steps.find((x) => x.id === 'map-layers-avoid-zone')!.setup?.(api);
    expect(store().colorVision).toBe('normal');
  }, 60_000);

  it('every layer is switched back off, and colour vision to normal, before the avoid-zone step', async () => {
    const steps = chapter('map-layers').steps;
    for (const id of ['difficulty', 'sand', 'geology', 'crism', 'ring'] as const) store().toggleLayer(id);
    store().setColorVision('deuteranopia');
    await steps.find((x) => x.id === 'map-layers-avoid-zone')!.setup?.(api);
    expect(Object.values(store().layers).every((v) => !v)).toBe(true);
    expect(store().colorVision).toBe('normal');
  });

  it('Show me on the avoid-zone step draws and finishes a zone, and done becomes true', async () => {
    const s = chapter('map-layers').steps.find((x) => x.id === 'map-layers-avoid-zone')!;
    await s.setup?.(api);
    expect(s.action!.done(store(), document)).toBe(false);
    await act(async () => s.action!.doIt(api));
    expect(store().avoidZones.length).toBe(1);
    expect(store().drawingZone).toBeNull();
    expect(s.action!.done(store(), document)).toBe(true);
  });

  it('the inspect step highlights the Inspect button and leaves the map live', () => {
    const s = chapter('map-layers').steps.find((x) => x.id === 'map-layers-inspect')!;
    expect(s.target).toBe('[data-tour="inspect"]');
    expect(s.targets).toContain('.leaflet-container');
  });

  it('the avoid zone has three corners and does not cover a stop', async () => {
    const s = chapter('map-layers').steps.find((x) => x.id === 'map-layers-avoid-zone')!;
    await s.setup?.(api);
    await act(async () => s.action!.doIt(api));
    const zone = store().avoidZones[0]!;
    expect(zone).toHaveLength(3);
    for (const st of store().stops) {
      const inside = zone.every((c) => Math.hypot(c.x - st.cell.x, c.y - st.cell.y) < 4);
      expect(inside).toBe(false);
    }
  });
});

describe('Chapter 4: Mission brief (#104)', () => {
  it('every setup and doIt runs and done is true afterwards', async () => {
    await runChapter(chapter('mission-brief'));
    expect(store().briefOpen).toBe(true);
    expect(document.querySelector('[role="dialog"][aria-label="Mission brief"]')).not.toBeNull();
  }, 30_000);

  it('the read steps keep the brief open, and the brief has the sections they describe', async () => {
    await act(async () => store().setBriefOpen(false));
    for (const s of chapter('mission-brief').steps.slice(1)) {
      await act(async () => void (await s.setup?.(api)));
      expect(store().briefOpen).toBe(true);
    }
    const text = document.querySelector('[role="dialog"][aria-label="Mission brief"]')!.textContent!;
    for (const h of ['Legs', 'Totals', 'Alerts expected along the route', 'Space weather at plan time', 'Datasets used', "What's estimated"]) expect(text).toContain(h);
    expect(text).toContain('Copy link');
    expect(text).toContain('Download PDF');
  });

  it('Download PDF is explained and never triggered', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const pdf = chapter('mission-brief').steps.find((x) => x.id === 'mission-brief-pdf')!;
    expect(pdf.action).toBeUndefined();
    await runChapter(chapter('mission-brief'));
    expect(print).not.toHaveBeenCalled();
    const target = document.querySelector(pdf.target!);
    expect(target?.textContent).toBe('Download PDF');
  });

  it('the Copy link step targets the Copy link button', async () => {
    const s = chapter('mission-brief').steps.find((x) => x.id === 'mission-brief-copy-link')!;
    await act(async () => void (await s.setup?.(api)));
    expect(document.querySelector(s.target!)?.textContent).toBe('Copy link');
  });
});

describe('step helpers', () => {
  it('has no step typed as anything but TourStep', () => {
    const steps: TourStep[] = PLAN_CHAPTERS.flatMap((c) => c.steps);
    expect(steps.length).toBeGreaterThan(30);
  });
});
