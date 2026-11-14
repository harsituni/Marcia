import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '../src/engine/client.ts';
import { mockRoute } from '../src/engine/mockRouter.ts';
import { LIMITS, clampConstraints } from '../src/plan/constraints.ts';
import { DEFAULT_CONSTRAINTS, REPLAN_DELAY_MS, resetEngine, useAppStore } from '../src/store.ts';
import { FakeWorker } from './fakeWorker.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');

describe('clampConstraints', () => {
  it('keeps values inside the slider ranges', () => {
    expect(clampConstraints({ oxygenMin: 5, reservePct: 90, maxSlopeDeg: 1 }, 25)).toEqual({
      oxygenMin: LIMITS.oxygenMin.min,
      reservePct: LIMITS.reservePct.max,
      maxSlopeDeg: LIMITS.maxSlopeDeg.min,
    });
  });

  it('never lets max slope exceed the grid limit', () => {
    expect(clampConstraints({ ...DEFAULT_CONSTRAINTS, maxSlopeDeg: 40 }, 20).maxSlopeDeg).toBe(20);
  });

  it('replaces NaN with a safe value', () => {
    const c = clampConstraints({ oxygenMin: NaN, reservePct: NaN, maxSlopeDeg: NaN }, 25);
    expect(Object.values(c).every(Number.isFinite)).toBe(true);
  });
});

describe('setConstraints', () => {
  let worker: FakeWorker;
  const store = () => useAppStore.getState();
  const routeRequests = () => worker.sent.filter((m) => m.type === 'route');

  beforeEach(async () => {
    worker = new FakeWorker();
    resetEngine();
    useAppStore.setState({ makeEngine: () => new EngineClient(worker), constraints: DEFAULT_CONSTRAINTS });
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
    await store().loadData('/fixtures');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], constraints: DEFAULT_CONSTRAINTS });
  });

  it('each setting edits Constraints and reroutes with them', async () => {
    for (const patch of [{ oxygenMin: 300 }, { reservePct: 30 }, { maxSlopeDeg: 15 }]) {
      const before = routeRequests().length;
      store().setConstraints(patch);
      expect(store().constraints).toMatchObject(patch);
      vi.advanceTimersByTime(REPLAN_DELAY_MS);
      expect(routeRequests()).toHaveLength(before + 1);
      const req = routeRequests().at(-1);
      expect(req?.type === 'route' && req.req.constraints).toEqual(store().constraints);
    }
    expect(store().constraints).toEqual({ oxygenMin: 300, reservePct: 30, maxSlopeDeg: 15 });
  });

  it('a slider drag sends one reroute, after it stops', () => {
    for (let o = 480; o >= 300; o -= 15) {
      store().setConstraints({ oxygenMin: o });
      vi.advanceTimersByTime(50);
    }
    expect(routeRequests()).toHaveLength(1);
    vi.advanceTimersByTime(REPLAN_DELAY_MS);
    expect(routeRequests()).toHaveLength(2);
  });

  it('the new route reflects the constraints', async () => {
    store().setConstraints({ oxygenMin: 60, reservePct: 50 });
    vi.advanceTimersByTime(REPLAN_DELAY_MS);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    const route = store().route;
    const data = store().data;
    expect(route.status).toBe('ready');
    if (route.status !== 'ready' || data.status !== 'ready') return;
    const expected = mockRoute({ start: data.grid.meta.habitat, stops: store().stops, constraints: store().constraints }, data.grid.meta);
    expect(route.result).toEqual(expected);
  });

  it('clamps values from the store too', () => {
    store().setConstraints({ maxSlopeDeg: 90 });
    expect(store().constraints.maxSlopeDeg).toBe(25);
  });
});
