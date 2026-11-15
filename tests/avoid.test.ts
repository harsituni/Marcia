import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell, GridMeta, Stop } from '../src/contracts.ts';
import { avoidMask, insideZone } from '../src/engine/avoid.ts';
import { EngineClient } from '../src/engine/client.ts';
import { handleMessage } from '../src/engine/worker.ts';
import { resetEngine, useAppStore } from '../src/store.ts';
import { FakeWorker } from './fakeWorker.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const store = () => useAppStore.getState();
const square = (c: Cell, r: number): Cell[] => [
  { x: c.x - r, y: c.y - r },
  { x: c.x + r, y: c.y - r },
  { x: c.x + r, y: c.y + r },
  { x: c.x - r, y: c.y + r },
];

describe('avoidMask', () => {
  const meta = { width: 10, height: 10 };
  it('marks the inside and the edge of a zone, nothing else', () => {
    const m = avoidMask(meta, [square({ x: 5, y: 5 }, 2)]);
    expect(m[5 * 10 + 5]).toBe(1);
    expect(m[3 * 10 + 3]).toBe(1); // corner
    expect(m[5 * 10 + 7]).toBe(1); // edge
    expect(m[5 * 10 + 8]).toBe(0);
    expect(m.reduce((s, v) => s + v, 0)).toBe(25);
  });
  it('ignores zones with fewer than 3 corners and clips to the grid', () => {
    expect(avoidMask(meta, [[{ x: 1, y: 1 }, { x: 4, y: 4 }]]).includes(1)).toBe(false);
    expect(avoidMask(meta, [square({ x: 0, y: 0 }, 3)]).reduce((s, v) => s + v, 0)).toBe(16);
  });
  it('insideZone uses the even-odd rule', () => {
    const tri = [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 8 }];
    expect(insideZone(tri, 2, 2)).toBe(true);
    expect(insideZone(tri, 7, 7)).toBe(false);
  });
});

describe('worker avoid message', () => {
  const W = 21;
  const meta: GridMeta = { width: W, height: W, cellSizeM: 5, maxSlopeDeg: 25, habitat: { x: 2, y: 10 } };
  const cost = new Float32Array(W * W).fill(1);
  const stop = { id: 's', name: 'S', cell: { x: 18, y: 10 }, goal: '', geologyUnit: '', minerals: [], photo: '', scienceValue: 1 } as unknown as Stop;
  const route = (state: Parameters<typeof handleMessage>[0]) => {
    const { out } = handleMessage(state, { type: 'route', req: { start: meta.habitat, stops: [stop], constraints: { oxygenMin: 100000, reservePct: 0, maxSlopeDeg: 25 } } });
    if (out?.type !== 'route') throw new Error('no route');
    return out.result;
  };

  it('routes around a zone, then straight again once it is cleared', () => {
    const { state } = handleMessage(null, { type: 'init', meta, cost });
    const direct = route(state);
    handleMessage(state, { type: 'avoid', zones: [square({ x: 10, y: 10 }, 4)] });
    const around = route(state);
    const mask = avoidMask(meta, [square({ x: 10, y: 10 }, 4)]);
    expect(around.path.every((c) => !mask[c.y * W + c.x])).toBe(true);
    expect(around.distanceM).toBeGreaterThan(direct.distanceM);
    handleMessage(state, { type: 'avoid', zones: [] });
    expect(route(state).path).toEqual(direct.path);
  });

  it('a stop inside a zone is out of range, not a crash', () => {
    const { state } = handleMessage(null, { type: 'init', meta, cost });
    handleMessage(state, { type: 'avoid', zones: [square(stop.cell, 2)] });
    expect(route(state).outOfRangeIds).toEqual(['s']);
  });
});

describe('store: crew-drawn avoid zones reroute', () => {
  beforeEach(() => {
    resetEngine();
    useAppStore.setState({ makeEngine: () => new EngineClient(new FakeWorker()), mode: 'plan', avoidZones: [], drawingZone: null });
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], avoidZones: [], drawingZone: null });
  });

  it('drawing a zone across the route reroutes around it; clearing restores it', async () => {
    await store().loadData('/fixtures');
    const before = store().route;
    if (before.status !== 'ready') throw new Error('no route');
    const path = before.result.path;
    const mid = path[Math.floor(before.result.legs[0]!.endIdx / 2)]!;
    const zone = square(mid, 2);

    store().startZone();
    const stopsBefore = store().stops.length;
    for (const c of zone.slice(0, 2)) store().addZonePoint(c);
    expect(store().finishZone()).toBe(false); // needs 3 corners
    for (const c of zone.slice(2)) store().addZonePoint(c);
    expect(store().stops.length).toBe(stopsBefore); // corners are not stops
    expect(store().finishZone()).toBe(true);
    expect(store().drawingZone).toBeNull();
    expect(store().avoidZones).toHaveLength(1);
    await store().planRoute();

    const after = store().route;
    if (after.status !== 'ready') throw new Error('no reroute');
    const meta = (store().data as { grid: { meta: GridMeta } }).grid.meta;
    const mask = avoidMask(meta, [zone]);
    expect(after.result.path.some((c) => mask[c.y * meta.width + c.x])).toBe(false);
    expect(after.result.path).not.toEqual(path);

    store().clearZones();
    await store().planRoute();
    const cleared = store().route;
    expect(cleared.status === 'ready' && cleared.result.path).toEqual(path);
  });
});
