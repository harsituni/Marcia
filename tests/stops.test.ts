import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../src/contracts.ts';
import { EngineClient } from '../src/engine/client.ts';
import { isWalkable, resetEngine, sharePlanFrom, useAppStore } from '../src/store.ts';
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

describe('renaming stops (#98)', () => {
  const nameOf = (id: string) => store().stops.find((s) => s.id === id)!.name;

  it('renames a preset and a custom stop without rerouting', async () => {
    store().addStop({ x: 50, y: 85 });
    await settle();
    const requests = routeRequests().length;
    const order = store().stops.map((s) => s.id);
    const cell = store().stops[0]!.cell;
    expect(store().renameStop('stop-a', '  Crater rim  ')).toBe(true);
    expect(store().renameStop('custom-1', 'Dune field')).toBe(true);
    await settle();
    expect(nameOf('stop-a')).toBe('Crater rim');
    expect(nameOf('custom-1')).toBe('Dune field');
    expect(store().stops.map((s) => s.id)).toEqual(order);
    expect(store().stops[0]!.cell).toEqual(cell);
    expect(routeRequests()).toHaveLength(requests);
  });

  it('rejects empty and whitespace-only names and keeps the old one', () => {
    const old = nameOf('stop-b');
    expect(store().renameStop('stop-b', '')).toBe(false);
    expect(store().renameStop('stop-b', '   	 ')).toBe(false);
    expect(nameOf('stop-b')).toBe(old);
    expect(store().renameStop('nope', 'X')).toBe(false);
  });

  it('caps names at 40 characters', () => {
    store().renameStop('stop-c', 'x'.repeat(60));
    expect(nameOf('stop-c')).toBe('x'.repeat(40));
  });

  it('a renamed stop carries its name in the share plan, a preset with its own name does not', () => {
    store().renameStop('stop-a', 'Crater rim');
    const plan = sharePlanFrom(store(), 'test', new Date());
    expect(plan.stops.find((s) => s.id === 'stop-a')!.name).toBe('Crater rim');
    expect(plan.stops.find((s) => s.id === 'stop-b')!.name).toBeUndefined();
  });
});

describe('editing goal and science value (#98)', () => {
  const stopOf = (id: string) => store().stops.find((s) => s.id === id)!;

  it('sets the goal (trimmed, capped at 200, may be cleared) and the science value, without rerouting', async () => {
    await settle();
    const requests = routeRequests().length;
    expect(store().editStop('stop-a', { goal: '  Sample the layered rock  ' })).toBe(true);
    expect(stopOf('stop-a').goal).toBe('Sample the layered rock');
    store().editStop('stop-a', { goal: 'g'.repeat(300) });
    expect(stopOf('stop-a').goal).toBe('g'.repeat(200));
    expect(store().editStop('stop-a', { goal: '   ' })).toBe(true);
    expect(stopOf('stop-a').goal).toBe('');
    expect(store().editStop('stop-b', { scienceValue: 3 })).toBe(true);
    expect(stopOf('stop-b').scienceValue).toBe(3);
    await settle();
    expect(routeRequests()).toHaveLength(requests);
  });

  it('rejects a science value outside 1-3 and unknown stops', () => {
    const before = stopOf('stop-b').scienceValue;
    expect(store().editStop('stop-b', { scienceValue: 4 as never })).toBe(false);
    expect(stopOf('stop-b').scienceValue).toBe(before);
    expect(store().editStop('nope', { goal: 'x' })).toBe(false);
  });

  it('carries a changed goal and science value in the share plan, and leaves unchanged presets out', () => {
    store().editStop('stop-a', { goal: 'New goal', scienceValue: 1 }); // stop-a is 3 in the fixture
    const plan = sharePlanFrom(store(), 'test', new Date());
    expect(plan.stops.find((s) => s.id === 'stop-a')).toMatchObject({ goal: 'New goal', scienceValue: 1 });
    const untouched = plan.stops.find((s) => s.id === 'stop-b')!;
    expect(untouched.goal).toBeUndefined();
    expect(untouched.scienceValue).toBeUndefined();
  });
});

describe('crew stop geology from the map layers (#98)', () => {
  const real = useAppStore.getState().stopScience;
  afterEach(() => useAppStore.setState({ stopScience: real }));
  const stopOf = (id: string) => store().stops.find((s) => s.id === id)!;

  it('fills a new crew stop from the layers at its cell, and refills it when moved', async () => {
    useAppStore.setState({ stopScience: async (c) => ({ geologyUnit: `Unit at ${c.x},${c.y}`, minerals: ['Carbonates'] }) });
    expect(store().addStop({ x: 50, y: 85 })).toBe(true);
    await settle();
    expect(stopOf('custom-1')).toMatchObject({ geologyUnit: 'Unit at 50,85', minerals: ['Carbonates'] });
    expect(store().moveStop('custom-1', { x: 51, y: 85 })).toBe(true);
    await settle();
    expect(stopOf('custom-1').geologyUnit).toBe('Unit at 51,85');
  });

  it('ignores a late answer for a cell the stop has already left', async () => {
    let answer!: (s: { geologyUnit: string; minerals: string[] }) => void;
    useAppStore.setState({ stopScience: () => new Promise((r) => (answer = r)) });
    store().addStop({ x: 50, y: 85 });
    const late = answer;
    useAppStore.setState({ stopScience: async () => ({ geologyUnit: 'New spot', minerals: [] }) });
    store().moveStop('custom-1', { x: 51, y: 85 });
    await settle();
    late({ geologyUnit: 'Old spot', minerals: ['Olivine'] });
    await settle();
    expect(stopOf('custom-1')).toMatchObject({ geologyUnit: 'New spot', minerals: [] });
  });

  it('keeps a preset stop’s researched geology when it is moved', async () => {
    const calls: Cell[] = [];
    useAppStore.setState({ stopScience: async (c) => (calls.push(c), { geologyUnit: 'From map', minerals: [] }) });
    const before = stopOf('stop-a');
    const target = { x: before.cell.x + 1, y: before.cell.y };
    if (!isWalkable(grid(), target)) return;
    store().moveStop('stop-a', target);
    await settle();
    expect(stopOf('stop-a').geologyUnit).toBe(before.geologyUnit);
    expect(calls).toEqual([]);
  });
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
