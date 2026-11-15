import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { siteIdFromArgs, sitePaths, sitesIndex } from '../scripts/site.ts';
import { DATA_FILES } from '../src/contracts.ts';
import type { GridMeta, Stop } from '../src/contracts.ts';
import { EngineClient } from '../src/engine/client.ts';
import { parseGrid } from '../src/data/grid.ts';
import { parseSites, siteDataUrl } from '../src/data/sites.ts';
import { handleMessage } from '../src/engine/worker.ts';
import { DEFAULT_CONSTRAINTS, resetEngine, useAppStore } from '../src/store.ts';
import { IDLE_REPLAY } from '../src/walk/replay.ts';
import { FakeWorker } from './fakeWorker.ts';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

function loadSiteGrid(id: string) {
  const dir = join(PUBLIC, 'data', id);
  const read = (f: string) => readFileSync(join(dir, f));
  return parseGrid(
    {
      meta: JSON.parse(read(DATA_FILES.meta).toString('utf8')) as GridMeta,
      cost: ab(read(DATA_FILES.cost)),
      elevation: ab(read(DATA_FILES.elevation)),
      sand: ab(read(DATA_FILES.sand)),
      stops: JSON.parse(read(DATA_FILES.stops).toString('utf8')) as Stop[],
    },
    `/data/${id}/${DATA_FILES.basemap}`,
  );
}

describe('--site argument (M36)', () => {
  it('defaults to jezero and accepts both spellings', () => {
    expect(siteIdFromArgs([])).toBe('jezero');
    expect(siteIdFromArgs(['--skip-ti', '--site', 'gale'])).toBe('gale');
    expect(siteIdFromArgs(['--site=gale'])).toBe('gale');
  });

  it('rejects a missing or unsafe id', () => {
    expect(() => siteIdFromArgs(['--site'])).toThrow(/needs an id/);
    expect(() => siteIdFromArgs(['--site', '../x'])).toThrow(/bad site id/);
  });

  it('keeps each site in its own folders', () => {
    const p = sitePaths('gale', ROOT);
    expect(p.siteJson).toBe(join(ROOT, 'data', 'sites', 'gale', 'site.json'));
    expect(p.rawDir).toBe(join(ROOT, 'data', 'raw', 'gale'));
    expect(p.outDir).toBe(join(ROOT, 'public', 'data', 'gale'));
  });
});

describe('public/data/sites.json', () => {
  const sites = parseSites(JSON.parse(readFileSync(join(PUBLIC, 'data', 'sites.json'), 'utf8')));

  it('matches data/sites/*/site.json (regenerate with npm run export:grid)', () => {
    expect(sites).toEqual(sitesIndex(ROOT));
  });

  it('lists Jezero first, then Gale as slope-only, each with data credits and lon/lat bounds', () => {
    expect(sites.map((s) => s.id)).toEqual(['jezero', 'gale']);
    expect(sites.map((s) => s.slopeOnly)).toEqual([false, true]);
    for (const s of sites) {
      expect(s.credits.length).toBeGreaterThan(0);
      expect(s.bounds.maxLon).toBeGreaterThan(s.bounds.minLon);
      expect(s.bounds.maxLat).toBeGreaterThan(s.bounds.minLat);
    }
  });

  it('rejects a broken index', () => {
    const bounds = { minLon: 0, maxLon: 1, minLat: 0, maxLat: 1 };
    expect(() => parseSites({})).toThrow();
    expect(() => parseSites([])).toThrow();
    expect(() => parseSites([
      { id: 'a', name: 'A', bounds },
      { id: 'a', name: 'B', bounds },
    ])).toThrow(/duplicate/);
    expect(() => parseSites([{ id: 'Bad Id', name: 'x', bounds }])).toThrow(/bad id/);
    expect(() => parseSites([{ id: 'a', name: 'A' }])).toThrow(/bounds/);
    expect(siteDataUrl('/Marcia/data/', 'gale')).toBe('/Marcia/data/gale');
  });
});

describe.each(['jezero', 'gale'])('site %s', (id) => {
  const grid = loadSiteGrid(id);
  const { meta, cost, stops } = grid;
  const walkable = (c: { x: number; y: number }) => Number.isFinite(cost[c.y * meta.width + c.x]);

  it('loads in the DATA_FILES formats with a basemap', () => {
    expect(meta).toMatchObject({ width: 600, height: 600, cellSizeM: 5, maxSlopeDeg: 25 });
    expect(readFileSync(join(PUBLIC, 'data', id, DATA_FILES.basemap)).subarray(1, 4).toString()).toBe('PNG');
  });

  it('has 3–5 stops on walkable cells, each with a JPEG photo', () => {
    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(stops.length).toBeLessThanOrEqual(5);
    expect(walkable(meta.habitat)).toBe(true);
    for (const s of stops) {
      expect(walkable(s.cell)).toBe(true);
      const photo = normalize(join(PUBLIC, 'data', id, s.photo));
      expect(existsSync(photo)).toBe(true);
      expect([...readFileSync(photo).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
  });

  it('plans a route from the habitat through every stop and back', () => {
    const { state } = handleMessage(null, { type: 'init', meta, cost });
    const { out } = handleMessage(state, { type: 'route', req: { start: meta.habitat, stops, constraints: DEFAULT_CONSTRAINTS } });
    if (out?.type !== 'route') throw new Error(`no route: ${JSON.stringify(out)}`);
    expect(out.result.legs).toHaveLength(stops.length + 1);
    expect(out.result.path[0]).toEqual(meta.habitat);
    expect(out.result.path.at(-1)).toEqual(meta.habitat);
    expect(out.result.outOfRangeIds).toEqual([]);
  });
});

it('Gale has no sand layer (slope-only cost): sand.bin is all zero', () => {
  expect(loadSiteGrid('gale').sand.every((v) => v === 0)).toBe(true);
});

describe('switching site in the app', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({
      data: { status: 'idle' },
      route: { status: 'idle' },
      stops: [],
      ring: null,
      siteId: 'jezero',
      sites: [],
      walk: null,
      replay: IDLE_REPLAY,
      constraints: DEFAULT_CONSTRAINTS,
    });
  });

  it('reloads the grid in the worker, swaps the stops and route, and keeps the settings', async () => {
    const worker = new FakeWorker();
    resetEngine();
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(PUBLIC, url.replace(/^\//, '')))));
    useAppStore.setState({ makeEngine: () => new EngineClient(worker), siteId: 'jezero', constraints: { ...DEFAULT_CONSTRAINTS, reservePct: 30 } });
    const store = () => useAppStore.getState();

    await store().loadSites();
    expect(store().sites.map((s) => s.id)).toEqual(['jezero', 'gale']);
    await store().loadData();
    expect(store().stops.map((s) => s.id)).toContain('wildcat-ridge');
    expect(store().route.status).toBe('ready');

    await store().setSite('gale');
    expect(store().siteId).toBe('gale');
    expect(worker.sent.filter((m) => m.type === 'init')).toHaveLength(2);
    expect(store().stops.map((s) => s.id)).toEqual(['altadena', 'valle-de-la-luna', 'atacama', 'nazca']);
    const route = store().route;
    if (route.status !== 'ready') throw new Error(route.status);
    expect(route.result.path[0]).toEqual(loadSiteGrid('gale').meta.habitat);
    expect(store().constraints.reservePct).toBe(30);

    await store().setSite('nowhere');
    expect(store().siteId).toBe('gale');
    await store().setSite('jezero');
    expect(store().stops[0]!.id).toBe('wildcat-ridge');
  });
});
