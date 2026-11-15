/**
 * M22: a full plan on the real Jezero data, through the same store → worker
 * path the app uses (the real message handler, no mocks).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { START_ID } from '../src/contracts.ts';
import { EngineClient } from '../src/engine/client.ts';
import { classifyCost, Difficulty } from '../src/map/overlays.ts';
import { elevationProfile } from '../src/plan/profile.ts';
import { DATA_URL, DEFAULT_CONSTRAINTS, REPLAN_DELAY_MS, resetEngine, useAppStore } from '../src/store.ts';
import { deriveHud } from '../src/walk/hud.ts';
import { FakeWorker } from './fakeWorker.ts';

const PUBLIC = join(import.meta.dirname, '..', 'public');
const store = () => useAppStore.getState();
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
const grid = () => {
  const d = store().data;
  if (d.status !== 'ready') throw new Error(`data is ${d.status}`);
  return d.grid;
};
const route = () => {
  const r = store().route;
  if (r.status !== 'ready') throw new Error(`route is ${r.status}`);
  return r.result;
};

beforeAll(async () => {
  resetEngine();
  useAppStore.setState({ makeEngine: () => new EngineClient(new FakeWorker()), constraints: DEFAULT_CONSTRAINTS });
  // Serve public/ the way the dev server and Pages do.
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(PUBLIC, url.replace(/^\//, '')))));
  await store().loadData();
});

afterAll(() => {
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({
    data: { status: 'idle' },
    route: { status: 'idle' },
    stops: [],
    ring: null,
    layers: { difficulty: false, sand: false, ring: false },
    constraints: DEFAULT_CONSTRAINTS,
  });
});

describe('real Jezero data', () => {
  it('the app points at public/data/jezero (M36: one folder per site)', () => {
    expect(DATA_URL).toBe('/data/jezero');
  });

  it('loads the 600 × 600 grid, basemap and four real stops', () => {
    const g = grid();
    expect(g.meta).toMatchObject({ width: 600, height: 600, cellSizeM: 5 });
    expect(g.cost).toHaveLength(360_000);
    expect(g.basemapUrl).toBe('/data/jezero/basemap.png');
    expect(readFileSync(join(PUBLIC, 'data', 'jezero', 'basemap.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(store().stops.map((s) => s.id)).toEqual(['wildcat-ridge', 'berea', 'hidden-harbor', 'amalik']);
  });

  it('the habitat and every stop are on walkable ground', () => {
    const g = grid();
    for (const c of [g.meta.habitat, ...store().stops.map((s) => s.cell)]) {
      expect(Number.isFinite(g.cost[c.y * g.meta.width + c.x])).toBe(true);
    }
  });

  it('plans a full route: habitat → all four stops → habitat, on walkable cells', () => {
    const r = route();
    const g = grid();
    expect(r.legs.map((l) => l.toId)).toEqual(['wildcat-ridge', 'berea', 'hidden-harbor', 'amalik', START_ID]);
    expect(r.path[0]).toEqual(g.meta.habitat);
    expect(r.path.at(-1)).toEqual(g.meta.habitat);
    for (const c of r.path) expect(Number.isFinite(g.cost[c.y * g.meta.width + c.x])).toBe(true);
    for (let i = 1; i < r.path.length; i++) {
      expect(Math.max(Math.abs(r.path[i]!.x - r.path[i - 1]!.x), Math.abs(r.path[i]!.y - r.path[i - 1]!.y))).toBe(1);
    }
    // A few km on a 3 km site, within a 480-minute supply.
    expect(r.distanceM).toBeGreaterThan(3000);
    expect(r.distanceM).toBeLessThan(15_000);
    expect(r.outOfRangeIds).toEqual([]);
  });

  it('feeds the stats panel, elevation profile, layers and HUD', () => {
    const r = route();
    const g = grid();
    const p = elevationProfile(r, g.elevation, g.meta, store().stops.map((s) => s.id));
    expect(p.stops.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    expect(p.maxM - p.minM).toBeGreaterThan(20); // the delta front is a real climb
    expect(p.elevM.every(Number.isFinite)).toBe(true);

    const classes = classifyCost(g.cost);
    const count = (k: number) => classes.reduce((n, c) => n + (c === k ? 1 : 0), 0);
    expect(count(Difficulty.Easy)).toBeGreaterThan(0);
    expect(count(Difficulty.Caution)).toBeGreaterThan(0);
    expect(count(Difficulty.NoGo)).toBeGreaterThan(0);

    const hud = deriveHud({ route: r, stops: store().stops, constraints: store().constraints, meta: g.meta, walk: { pathIdx: 0, oxygenLeftMin: 480 } });
    expect(hud.next).toMatchObject({ kind: 'stop', n: 1 });
  });

  it('a short oxygen supply puts far stops out of range, and the ring shrinks inside the map', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store().setConstraints({ oxygenMin: 60 }); // 48 usable min ≈ 2.4 km; the west edge is 2.6 km from the habitat
    vi.advanceTimersByTime(REPLAN_DELAY_MS);
    vi.useRealTimers();
    await settle();
    expect(route().outOfRangeIds).toContain('berea');

    store().toggleLayer('ring');
    await settle();
    const ring = store().ring!;
    expect(ring.polygon.length).toBeGreaterThan(8);
    const xs = ring.polygon.map((c) => c.x);
    expect(Math.min(...xs)).toBeGreaterThan(0); // doesn't reach the west edge (Berea side)
  });
});
