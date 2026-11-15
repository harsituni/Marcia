import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '../src/engine/client.ts';
import { DEFAULT_CONSTRAINTS, resetEngine, useAppStore } from '../src/store.ts';
import { cumulativeM } from '../src/walk/hud.ts';
import { DEFAULT_SPEED, IDLE_REPLAY, advance, indexAtDistance, walkAt } from '../src/walk/replay.ts';
import { FakeWorker } from './fakeWorker.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('replay maths', () => {
  // 5 cells east, 10 m each: 40 m, taking 4 minutes and 8 oxygen-minutes.
  const route = { path: Array.from({ length: 5 }, (_, x) => ({ x, y: 0 })), distanceM: 40, timeMin: 4, oxygenUsedMin: 8 };
  const at = (t: number) => walkAt(route, { oxygenMin: 100 }, { cellSizeM: 10 }, t);

  it('indexAtDistance interpolates between cells', () => {
    const cum = cumulativeM(route.path, 10);
    expect(indexAtDistance(cum, 0)).toBe(0);
    expect(indexAtDistance(cum, 15)).toBe(1.5);
    expect(indexAtDistance(cum, 40)).toBe(4);
    expect(indexAtDistance(cum, 999)).toBe(4);
    expect(indexAtDistance([0], 5)).toBe(0);
  });

  it('moves along the path and drains oxygen in step with the route stats', () => {
    expect(at(0)).toEqual({ pathIdx: 0, oxygenLeftMin: 100 });
    expect(at(1)).toEqual({ pathIdx: 1, oxygenLeftMin: 98 });
    expect(at(2.5)).toEqual({ pathIdx: 2.5, oxygenLeftMin: 95 });
    expect(at(4)).toEqual({ pathIdx: 4, oxygenLeftMin: 92 });
    expect(at(99)).toEqual({ pathIdx: 4, oxygenLeftMin: 92 });
    expect(at(-1)).toEqual({ pathIdx: 0, oxygenLeftMin: 100 });
  });

  it('advance runs the clock at the chosen speed and stops at the end', () => {
    const playing = { status: 'playing' as const, speed: 240, elapsedMin: 0 };
    expect(advance(playing, 0.5, 10)).toEqual({ status: 'playing', speed: 240, elapsedMin: 2 });
    expect(advance(playing, 60, 10)).toEqual({ status: 'done', speed: 240, elapsedMin: 10 });
    expect(advance({ ...playing, status: 'paused' }, 1, 10).elapsedMin).toBe(0);
  });
});

describe('walk replay in the store', () => {
  let worker: FakeWorker;
  const store = () => useAppStore.getState();
  const ringRequests = () => worker.sent.flatMap((m) => (m.type === 'ring' ? [m.oxygenLeftMin] : []));
  const route = () => {
    const r = store().route;
    if (r.status !== 'ready') throw new Error('no route');
    return r.result;
  };

  beforeEach(async () => {
    worker = new FakeWorker();
    resetEngine();
    // 60 min supply, 20% reserve: 48 usable. The fixture walk takes ~22 min.
    useAppStore.setState({ makeEngine: () => new EngineClient(worker), constraints: { ...DEFAULT_CONSTRAINTS, oxygenMin: 60 }, mode: 'plan', replay: IDLE_REPLAY, walk: null });
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
    await store().loadData('/fixtures');
    store().setMode('walk');
    await settle();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({
      data: { status: 'idle' },
      route: { status: 'idle' },
      stops: [],
      ring: null,
      walk: null,
      replay: IDLE_REPLAY,
      mode: 'plan',
      layers: { difficulty: false, sand: false, geology: false, crism: false, ring: false },
      constraints: DEFAULT_CONSTRAINTS,
    });
  });

  it('entering Walk mode requests the ring for the full usable supply', () => {
    expect(ringRequests()).toEqual([48]);
    expect(store().ring?.polygon.length).toBeGreaterThan(2);
  });

  it('playing moves the dot along the path and the oxygen drops', () => {
    store().playWalk();
    expect(store().replay.status).toBe('playing');
    store().tickWalk(1); // 1 s at 240× = 4 simulated minutes
    const w1 = store().walk!;
    expect(store().replay.elapsedMin).toBe(4);
    expect(w1.pathIdx).toBeGreaterThan(0);
    expect(w1.oxygenLeftMin).toBeCloseTo(60 - 4);
    store().tickWalk(1);
    const w2 = store().walk!;
    expect(w2.pathIdx).toBeGreaterThan(w1.pathIdx);
    expect(w2.oxygenLeftMin).toBeLessThan(w1.oxygenLeftMin);
  });

  it('the ring is re-requested from the worker as the oxygen drops, and shrinks', async () => {
    const area = () => {
      const p = store().ring!.polygon;
      let a = 0;
      for (let i = 0; i < p.length; i++) a += p[i]!.x * p[(i + 1) % p.length]!.y - p[(i + 1) % p.length]!.x * p[i]!.y;
      return Math.abs(a / 2);
    };
    // The fixture site is only 500 m wide, so use a supply small enough for the ring to sit inside it:
    // 30 min with a 15 min reserve leaves 15 usable (750 m of walking).
    useAppStore.setState({ constraints: { ...DEFAULT_CONSTRAINTS, oxygenMin: 30, reservePct: 50 } });
    store().resetWalk();
    await settle();
    const before = area();
    worker.sent.length = 0;
    store().playWalk();
    for (let i = 0; i < 5; i++) {
      store().tickWalk(1);
      await settle();
    }
    const asked = ringRequests();
    expect(asked.length).toBeGreaterThanOrEqual(3);
    // Each request carries less usable oxygen than the one before.
    for (let i = 1; i < asked.length; i++) expect(asked[i]).toBeLessThan(asked[i - 1]!);
    expect(asked.at(-1)).toBeCloseTo(Math.max(0, store().walk!.oxygenLeftMin - 15));
    expect(area()).toBeLessThan(before);
  });

  it('does not stack ring requests while one is in flight', () => {
    store().playWalk();
    const n = ringRequests().length;
    for (let i = 0; i < 20; i++) store().tickWalk(0.2); // no awaits: the first reply hasn't arrived
    expect(ringRequests().length).toBe(n + 1);
  });

  it('finishes at the habitat with the route’s own oxygen use', () => {
    store().playWalk();
    for (let i = 0; i < 100 && store().replay.status === 'playing'; i++) store().tickWalk(0.25);
    expect(store().replay.status).toBe('done');
    expect(store().walk!.pathIdx).toBe(route().path.length - 1);
    expect(store().walk!.oxygenLeftMin).toBeCloseTo(60 - route().oxygenUsedMin);
    // Play again starts over.
    store().playWalk();
    expect(store().replay).toMatchObject({ status: 'playing', elapsedMin: 0 });
  });

  it('pause, seek, speed and restart', async () => {
    store().playWalk();
    store().tickWalk(1);
    store().pauseWalk();
    const paused = store().walk;
    store().tickWalk(5);
    expect(store().walk).toEqual(paused);

    store().seekWalk(0.5);
    expect(store().replay).toMatchObject({ status: 'paused', elapsedMin: route().timeMin / 2 });
    await settle();
    expect(ringRequests().at(-1)).toBeCloseTo(store().walk!.oxygenLeftMin - 12);

    store().setWalkSpeed(600);
    expect(store().replay.speed).toBe(600);

    store().resetWalk();
    expect(store().walk).toBeNull();
    expect(store().replay).toEqual({ status: 'idle', speed: 600, elapsedMin: 0 });
  });

  it('leaving Walk mode pauses; a new route starts a new walk', async () => {
    store().playWalk();
    store().tickWalk(1);
    store().setMode('plan');
    expect(store().replay.status).toBe('paused');
    expect(store().walk).not.toBeNull();

    store().removeStop('stop-d');
    await settle();
    expect(store().walk).toBeNull();
    expect(store().replay).toEqual({ status: 'idle', speed: DEFAULT_SPEED, elapsedMin: 0 });
  });
});
