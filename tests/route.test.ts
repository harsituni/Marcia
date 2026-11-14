import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { START_ID } from '../src/contracts.ts';
import type { GridMeta, Stop } from '../src/contracts.ts';
import { EngineClient } from '../src/engine/client.ts';
import { mockRoute } from '../src/engine/mockRouter.ts';
import { FakeWorker } from './fakeWorker.ts';
import { splitOutAndHome } from '../src/map/route.ts';
import { DEFAULT_CONSTRAINTS, resetEngine, useAppStore } from '../src/store.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const meta = JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8')) as GridMeta;
const stops = JSON.parse(readFileSync(join(FIX, 'stops.json'), 'utf8')) as Stop[];

describe('splitOutAndHome', () => {
  const route = mockRoute({ start: meta.habitat, stops, constraints: DEFAULT_CONSTRAINTS }, meta);

  it('out ends at the last stop and home runs from it back to start', () => {
    const { out, home } = splitOutAndHome(route);
    expect(out[0]).toEqual(meta.habitat);
    expect(out.at(-1)).toEqual(stops.at(-1)!.cell);
    expect(home[0]).toEqual(stops.at(-1)!.cell);
    expect(home.at(-1)).toEqual(meta.habitat);
    expect(out.length + home.length - 1).toBe(route.path.length);
  });

  it('is empty with no stops', () => {
    const empty = mockRoute({ start: meta.habitat, stops: [], constraints: DEFAULT_CONSTRAINTS }, meta);
    expect(splitOutAndHome(empty)).toEqual({ out: [], home: [] });
  });

  it('home is the final leg back to start', () => {
    expect(route.legs.at(-1)!.toId).toBe(START_ID);
  });
});

describe('EngineClient', () => {
  it('matches replies to requests in order', async () => {
    const client = new EngineClient(new FakeWorker());
    client.init(meta, new Float32Array(meta.width * meta.height));
    const [r, ring] = await Promise.all([
      client.route({ start: meta.habitat, stops, constraints: DEFAULT_CONSTRAINTS }),
      client.ring(60),
    ]);
    expect(r.path[0]).toEqual(meta.habitat);
    expect(ring.polygon.length).toBeGreaterThan(0);
  });

  it('rejects with the worker error (e.g. bad init)', async () => {
    const client = new EngineClient(new FakeWorker());
    client.init(meta, new Float32Array(3));
    await expect(client.route({ start: meta.habitat, stops, constraints: DEFAULT_CONSTRAINTS })).rejects.toThrow(/cost has 3 cells/);
  });
});

describe('planRoute', () => {
  let worker: FakeWorker;

  beforeEach(() => {
    worker = new FakeWorker();
    resetEngine();
    useAppStore.setState({ makeEngine: () => new EngineClient(worker), route: { status: 'idle' } });
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' } });
  });

  it('plans through the worker contract after the data loads', async () => {
    await useAppStore.getState().loadData('/fixtures');
    const route = useAppStore.getState().route;
    expect(route.status).toBe('ready');
    if (route.status === 'ready') expect(route.result.legs).toHaveLength(stops.length + 1);
    expect(worker.sent.map((m) => m.type)).toEqual(['init', 'route']);
    const req = worker.sent[1];
    expect(req?.type === 'route' && req.req.start).toEqual(meta.habitat);
  });

  it('inits the engine once per grid', async () => {
    await useAppStore.getState().loadData('/fixtures');
    await useAppStore.getState().planRoute();
    expect(worker.sent.map((m) => m.type)).toEqual(['init', 'route', 'route']);
  });
});
