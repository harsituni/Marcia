// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { START_ID } from '../src/contracts.ts';
import { EngineClient } from '../src/engine/client.ts';
import { splitOutAndHome } from '../src/map/route.ts';
import { DEFAULT_CONSTRAINTS, resetEngine, useAppStore } from '../src/store.ts';
import { Hud } from '../src/walk/Hud.tsx';
import { deriveHud } from '../src/walk/hud.ts';
import { IDLE_REPLAY } from '../src/walk/replay.ts';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIX = join(import.meta.dirname, '..', 'fixtures');
const store = () => useAppStore.getState();
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const route = () => {
  const r = store().route;
  if (r.status !== 'ready') throw new Error(`route is ${r.status}`);
  return r.result;
};
const grid = () => {
  const d = store().data;
  if (d.status !== 'ready') throw new Error('no data');
  return d.grid;
};

let worker: FakeWorker;

/** Loads the fixtures with a given supply and enters Walk mode. The fixture walk needs ~22 oxygen-minutes. */
async function start(oxygenMin: number, reservePct: number) {
  worker = new FakeWorker();
  resetEngine();
  useAppStore.setState({
    makeEngine: () => new EngineClient(worker),
    constraints: { ...DEFAULT_CONSTRAINTS, oxygenMin, reservePct },
    mode: 'plan',
    replay: IDLE_REPLAY,
    walk: null,
    replanned: null,
    alerts: [],
  });
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  await store().loadData('/fixtures');
  // Loading clamps to the settings sliders (60 min minimum); tests need tighter supplies than that.
  useAppStore.setState({ constraints: { ...DEFAULT_CONSTRAINTS, oxygenMin, reservePct } });
  await store().planRoute();
  store().setMode('walk');
  await settle();
}

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
    replanned: null,
    replanning: false,
    alerts: [],
    mode: 'plan',
    constraints: DEFAULT_CONSTRAINTS,
  });
});

describe('alerts during a replay', () => {
  it('a healthy walk has none', async () => {
    await start(480, 20);
    store().playWalk();
    for (let i = 0; i < 4; i++) store().tickWalk(1);
    expect(store().alerts).toEqual([]);
  });

  it('an alert fires as the walk goes on, on a tick', async () => {
    // 45 min supply, 9 reserve: fine at the start (36 usable vs ~22 needed is a 14-min margin → warn straight away),
    // so use 50: margin ~18 at the start, and it stays ~18 on the route. Drop the tank mid-walk to trip it.
    await start(50, 20);
    store().playWalk();
    store().tickWalk(1);
    expect(store().alerts).toEqual([]);
    // The crew loses 10 minutes of oxygen (a leak): the next tick picks it up.
    useAppStore.setState({ constraints: { ...store().constraints, oxygenMin: 40 } });
    store().tickWalk(0.25);
    expect(store().alerts.map((a) => `${a.kind}:${a.severity}`)).toEqual(['oxygen:warn']);
  });

  it('critical alerts come first, and clear when leaving Walk mode', async () => {
    await start(30, 50); // 15 usable for a ~22 min walk: the route doesn't fit
    expect(store().alerts[0]).toMatchObject({ kind: 'oxygen', severity: 'critical' });
    expect(store().alerts[0]!.message).toMatch(/Replan\.$/);
    expect(store().alerts.findIndex((a) => a.severity === 'warn')).not.toBe(0);
    store().setMode('plan');
    expect(store().alerts).toEqual([]);
  });
});

describe('Replan', () => {
  it('replaces the route from where the crew is, drops stops, and clears the critical alert', async () => {
    await start(30, 50);
    store().playWalk();
    store().tickWalk(0.5); // 2 minutes in: 100 m, short of the first stop
    const before = route();
    const walk = store().walk!;
    const requestsBefore = worker.sent.length;

    await store().replanWalk();
    await settle();

    const msg = worker.sent.slice(requestsBefore).find((m) => m.type === 'replan');
    if (msg?.type !== 'replan') throw new Error('no replan message sent');
    expect(msg.oxygenLeftMin).toBeCloseTo(walk.oxygenLeftMin);
    expect(msg.constraints).toEqual(store().constraints);
    expect(msg.stops.map((s) => s.id)).toEqual(['stop-a', 'stop-b', 'stop-c', 'stop-d']);

    const after = route();
    expect(after).not.toBe(before);
    expect(after.path[0]).toEqual(msg.from);
    expect(after.path.at(-1)).toEqual(grid().meta.habitat);
    expect(after.legs.at(-1)!.toId).toBe(START_ID);
    expect(after.outOfRangeIds.length).toBeGreaterThan(0);
    expect(store().replanned).toMatchObject({ droppedIds: after.outOfRangeIds, startOxygenMin: walk.oxygenLeftMin, offsetMin: 2 });

    // The walk carries on from the start of the new route with the same oxygen, still playing.
    expect(store().walk).toEqual({ pathIdx: 0, oxygenLeftMin: walk.oxygenLeftMin });
    expect(store().replay).toMatchObject({ status: 'playing', elapsedMin: 0 });
    expect(store().alerts.filter((a) => a.kind === 'oxygen' && a.severity === 'critical')).toEqual([]);

    // The ring was redrawn for the oxygen left now.
    const ringAsks = worker.sent.slice(requestsBefore).filter((m) => m.type === 'ring');
    expect(ringAsks.length).toBeGreaterThan(0);

    // And the replay keeps draining from the oxygen at the replan, not the full supply.
    store().tickWalk(0.25);
    expect(store().walk!.oxygenLeftMin).toBeCloseTo(walk.oxygenLeftMin - 1);
  });

  it('only sends the stops still ahead', async () => {
    await start(480, 20);
    store().playWalk();
    const pastFirst = (route().legs[0]!.endIdx + 2) / (route().path.length - 1);
    store().seekWalk(pastFirst);
    const n = worker.sent.length;
    await store().replanWalk();
    const msg = worker.sent.slice(n).find((m) => m.type === 'replan');
    expect(msg?.type === 'replan' && msg.stops.map((s) => s.id)).toEqual(['stop-b', 'stop-c', 'stop-d']);
    expect(store().replanned!.droppedIds).toEqual([]);
  });

  it('works while paused, and before the walk has started', async () => {
    await start(30, 50);
    await store().replanWalk(); // idle: from the habitat
    expect(store().replanned).not.toBeNull();
    expect(store().replay.status).toBe('paused');

    store().playWalk();
    store().tickWalk(0.5);
    store().pauseWalk();
    const paused = route();
    await store().replanWalk();
    expect(route()).not.toBe(paused);
    expect(store().replay.status).toBe('paused');
    // Whole-EVA time keeps adding up across replans.
    expect(store().replanned!.offsetMin).toBeCloseTo(2);
  });

  it('a straight-home route still draws, and the HUD points at the real habitat', async () => {
    await start(30, 50);
    store().playWalk();
    store().tickWalk(2);
    await store().replanWalk();
    const r = route();
    const parts = splitOutAndHome(r);
    expect(parts.home.length).toBeGreaterThan(1);
    const hud = deriveHud({ route: r, stops: store().stops, constraints: store().constraints, meta: grid().meta, walk: store().walk! });
    expect(hud.habitatBearingDeg).not.toBeNull(); // path[0] is the crew, not the habitat
    expect(hud.returnMargin.homeMin).toBeCloseTo(r.oxygenUsedMin);
  });

  it('restart and going back to Plan bring the planned route back', async () => {
    await start(30, 50);
    const planned = route();
    store().playWalk();
    store().tickWalk(1);
    await store().replanWalk();
    store().resetWalk();
    await settle();
    expect(store().replanned).toBeNull();
    expect(route().path).toEqual(planned.path);
    expect(store().walk).toBeNull();

    await store().replanWalk();
    store().setMode('plan');
    await settle();
    expect(store().replanned).toBeNull();
    expect(route().path[0]).toEqual(grid().meta.habitat);
  });

  it('at the habitat with nothing left, says so and keeps the route', async () => {
    await start(480, 20);
    store().playWalk();
    store().seekWalk(1);
    const done = route();
    await store().replanWalk();
    expect(route()).toBe(done);
    expect(store().notice).toMatch(/Already at the habitat/);
  });
});

describe('Head home now', () => {
  it('replans with no stops: the route ends at the habitat with no stop legs, and every stop ahead is dropped', async () => {
    await start(480, 20);
    store().playWalk();
    store().tickWalk(0.5);
    const n = worker.sent.length;
    await store().headHome();
    await settle();
    const msg = worker.sent.slice(n).find((m) => m.type === 'replan');
    expect(msg?.type === 'replan' && msg.stops).toEqual([]);
    const r = route();
    expect(r.path.at(-1)).toEqual(grid().meta.habitat);
    expect(r.legs.every((l) => l.toId === START_ID)).toBe(true);
    expect(store().replanned).toMatchObject({ droppedIds: ['stop-a', 'stop-b', 'stop-c', 'stop-d'], headedHome: true });
    expect(store().replanning).toBe(false);
  });

  it('keeps stops dropped by an earlier replan', async () => {
    await start(30, 50);
    store().playWalk();
    store().tickWalk(0.5);
    await store().replanWalk();
    const earlier = store().replanned!.droppedIds;
    await store().headHome();
    expect(store().replanned!.droppedIds).toEqual(expect.arrayContaining(earlier));
    expect(store().replanned!.droppedIds.length).toBe(store().stops.length);
  });
});

describe('HUD banner', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('shows alerts critical-first, and the Replan button swaps the route and lists dropped stops', async () => {
    await start(30, 50);
    await act(async () => root.render(<Hud />));
    // Walk off the habitat: the Replan button is hidden while standing on it.
    await act(async () => store().setWalk({ pathIdx: 1, oxygenLeftMin: 30 }));
    const items = () => [...host.querySelectorAll('ul[aria-label="Alerts"] li')];
    expect(items().length).toBeGreaterThan(0);
    expect(items()[0]!.getAttribute('data-severity')).toBe('critical');
    expect(items()[0]!.getAttribute('role')).toBe('alert');
    expect(items()[0]!.textContent).toMatch(/Critical: Oxygen is \d+ min short for this route\. Replan\./);
    const order = items().map((li) => li.getAttribute('data-severity'));
    expect(order).toEqual([...order].sort((a, b) => Number(b === 'critical') - Number(a === 'critical')));

    const before = route();
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Replan from here')!;
    await act(async () => {
      button.click();
      await settle();
    });
    expect(route()).not.toBe(before);
    const result = host.querySelector('[aria-label="Replan result"]')!;
    expect(result.textContent).toMatch(/^Replanned\. Dropped: /);
    for (const id of store().replanned!.droppedIds) {
      expect(result.textContent).toContain(store().stops.find((s) => s.id === id)!.name);
    }
    expect(items().filter((li) => li.textContent!.includes('short for this route'))).toEqual([]);
  });

  it('Head home now: hidden at the habitat, disabled while replanning, and the note says heading straight home', async () => {
    await start(480, 20);
    await act(async () => root.render(<Hud />));
    const btn = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Head home now');
    expect(btn()).toBeUndefined(); // standing on the habitat
    await act(async () => store().setWalk({ pathIdx: 1, oxygenLeftMin: 400 }));
    expect(btn()!.disabled).toBe(false);
    await act(async () => useAppStore.setState({ replanning: true }));
    expect(btn()!.disabled).toBe(true);
    await act(async () => useAppStore.setState({ replanning: false }));
    await act(async () => {
      btn()!.click();
      await settle();
    });
    const note = host.querySelector('[aria-label="Replan result"]')!;
    expect(note.textContent).toMatch(/^Heading straight home\. Dropped: /);
    expect(route().legs.every((l) => l.toId === START_ID)).toBe(true);
  });
});
