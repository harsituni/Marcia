import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../src/contracts.ts';
import { EngineClient } from '../src/engine/client.ts';
import { isWalkable, resetEngine, useAppStore } from '../src/store.ts';
import { FakeWorker } from './fakeWorker.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const settle = () => new Promise((r) => setTimeout(r, 0));

let worker: FakeWorker;
const store = () => useAppStore.getState();
const routeRequests = () => worker.sent.filter((m) => m.type === 'route');
const lastRequestedStops = () => {
  const m = routeRequests().at(-1);
  return m?.type === 'route' ? m.req.stops.map((s) => s.id) : [];
};
const routeResult = () => {
  const r = store().route;
  if (r.status !== 'ready') throw new Error(`route is ${r.status}`);
  return r.result;
};
const grid = () => {
  const d = store().data;
  if (d.status !== 'ready') throw new Error('no data');
  return d.grid;
};
function blockedCell(): Cell {
  const i = grid().cost.findIndex((c) => !Number.isFinite(c));
  return { x: i % grid().meta.width, y: Math.floor(i / grid().meta.width) };
}

beforeEach(async () => {
  worker = new FakeWorker();
  resetEngine();
  useAppStore.setState({ makeEngine: () => new EngineClient(worker), route: { status: 'idle' }, notice: null });
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  await store().loadData('/fixtures');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], notice: null });
});

describe('stop editing', () => {
  it('starts with the stops from stops.json', () => {
    expect(store().stops.map((s) => s.id)).toEqual(['stop-a', 'stop-b', 'stop-c', 'stop-d']);
  });

  it('adding a stop re-requests the route and redraws through it', async () => {
    expect(store().addStop({ x: 50, y: 85 })).toBe(true);
    await settle();
    expect(routeRequests()).toHaveLength(2);
    expect(lastRequestedStops()).toEqual(['stop-a', 'stop-b', 'stop-c', 'stop-d', 'custom-1']);
    const r = routeResult();
    expect(r.legs.at(-2)!.toId).toBe('custom-1');
    expect(r.path[r.legs.at(-2)!.endIdx]).toEqual({ x: 50, y: 85 });
  });

  it('gives added stops unique ids', () => {
    store().addStop({ x: 50, y: 85 });
    store().addStop({ x: 52, y: 85 });
    store().removeStop('custom-1');
    store().addStop({ x: 54, y: 85 });
    expect(store().stops.map((s) => s.id).filter((id) => id.startsWith('custom'))).toEqual(['custom-2', 'custom-1']);
  });

  it('moving a stop re-requests the route with the new cell', async () => {
    expect(store().moveStop('stop-b', { x: 85, y: 50 })).toBe(true);
    await settle();
    expect(routeRequests()).toHaveLength(2);
    const r = routeResult();
    const leg = r.legs.find((l) => l.toId === 'stop-b')!;
    expect(r.path[leg.endIdx]).toEqual({ x: 85, y: 50 });
  });

  it('removing a stop re-requests the route without it', async () => {
    store().removeStop('stop-c');
    await settle();
    expect(routeRequests()).toHaveLength(2);
    expect(lastRequestedStops()).toEqual(['stop-a', 'stop-b', 'stop-d']);
    expect(routeResult().legs.some((l) => l.toId === 'stop-c')).toBe(false);
  });

  it('rejects blocked or off-grid cells without re-planning', async () => {
    const blocked = blockedCell();
    expect(isWalkable(grid(), blocked)).toBe(false);
    expect(store().addStop(blocked)).toBe(false);
    expect(store().moveStop('stop-a', { x: -1, y: 5 })).toBe(false);
    await settle();
    expect(routeRequests()).toHaveLength(1);
    expect(store().stops.find((s) => s.id === 'stop-a')!.cell).toEqual({ x: 40, y: 22 });
  });

  it('only the latest of several quick edits is drawn', async () => {
    store().moveStop('stop-a', { x: 41, y: 22 });
    store().moveStop('stop-a', { x: 42, y: 22 });
    store().moveStop('stop-a', { x: 43, y: 22 });
    await settle();
    const r = routeResult();
    expect(r.path[r.legs[0]!.endIdx]).toEqual({ x: 43, y: 22 });
  });

  it('notices clear themselves', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store().showNotice('hi');
    expect(store().notice).toBe('hi');
    vi.advanceTimersByTime(3000);
    expect(store().notice).toBeNull();
  });
});
