import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GridMeta, Stop } from '../src/contracts.ts';
import { AStar } from '../src/engine/astar.ts';
import { EngineClient } from '../src/engine/client.ts';
import { bestStopOrder } from '../src/engine/replan.ts';
import { pathLengthM } from '../src/engine/path.ts';
import { resetEngine, useAppStore } from '../src/store.ts';
import { FakeWorker } from './fakeWorker.ts';

// Open 60 x 20 grid, 5 m cells, habitat at the west end.
const meta: GridMeta = { width: 60, height: 20, cellSizeM: 5, maxSlopeDeg: 25, habitat: { x: 0, y: 10 } };
const open = () => new Float32Array(meta.width * meta.height).fill(1);
const stop = (id: string, x: number, y: number): Stop => ({ id, name: id, cell: { x, y }, goal: '', geologyUnit: '', minerals: [], photo: '', scienceValue: 2 });
const tourM = (engine: AStar, ids: string[], stops: Stop[]): number => {
  const cells = [meta.habitat, ...ids.map((id) => stops.find((s) => s.id === id)!.cell), meta.habitat];
  let total = 0;
  for (let i = 1; i < cells.length; i++) total += pathLengthM(engine.findPath(cells[i - 1]!, cells[i]!)!.path, meta.cellSizeM);
  return total;
};

describe('bestStopOrder', () => {
  const engine = new AStar(meta, open());

  it('finds the optimal order for a known small case', () => {
    // Along row 10: visiting 10, 20, 30, 40 outward is shortest; the walk is 80 cells.
    const stops = [stop('c', 30, 10), stop('a', 10, 10), stop('d', 40, 10), stop('b', 20, 10)];
    const ids = bestStopOrder(engine, stops, meta);
    // Several orders tie on a straight row (out to 40 and back), so check the distance, not one order.
    expect(tourM(engine, ids, stops)).toBe(80 * meta.cellSizeM);
  });

  it('never returns an order longer than the given one', () => {
    const stops = [stop('a', 10, 2), stop('b', 50, 18), stop('c', 12, 17), stop('d', 40, 3), stop('e', 25, 10), stop('f', 5, 12)];
    for (let r = 0; r < stops.length; r++) {
      const given = [...stops.slice(r), ...stops.slice(0, r)];
      const ids = bestStopOrder(engine, given, meta);
      expect([...ids].sort()).toEqual(given.map((s) => s.id).sort());
      expect(tourM(engine, ids, stops)).toBeLessThanOrEqual(tourM(engine, given.map((s) => s.id), stops) + 1e-9);
    }
  });

  it('keeps an already-best order as it is', () => {
    const stops = [stop('a', 10, 10), stop('b', 20, 10), stop('c', 30, 10)];
    expect(bestStopOrder(engine, stops, meta)).toEqual(['a', 'b', 'c']);
  });

  it('puts unreachable stops last, in their given order', () => {
    const cost = open();
    // Wall off x = 55..59 so those stops can't be reached.
    for (let y = 0; y < meta.height; y++) cost[y * meta.width + 54] = Infinity;
    const walled = new AStar(meta, cost);
    const stops = [stop('x1', 57, 5), stop('c', 30, 10), stop('x2', 58, 15), stop('a', 10, 10), stop('b', 20, 10)];
    const ids = bestStopOrder(walled, stops, meta);
    expect(ids.slice(3)).toEqual(['x1', 'x2']);
    expect(tourM(walled, ids.slice(0, 3), stops)).toBe(60 * meta.cellSizeM);
  });

  it('uses nearest neighbour + 2-opt above 8 stops and still beats a bad order', () => {
    const xs = [5, 50, 10, 45, 15, 40, 20, 35, 25, 30];
    const stops = xs.map((x, i) => stop(`s${i}`, x, 10));
    const ids = bestStopOrder(engine, stops, meta);
    expect(ids).toHaveLength(10);
    expect(tourM(engine, ids, stops)).toBe(100 * meta.cellSizeM);
  });
});

const FIX = join(import.meta.dirname, '..', 'fixtures');
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Find best order in the store', () => {
  const store = () => useAppStore.getState();
  const ids = () => store().stops.map((s) => s.id);
  let worker: FakeWorker;

  beforeEach(async () => {
    worker = new FakeWorker();
    resetEngine();
    useAppStore.setState({ makeEngine: () => new EngineClient(worker), mode: 'plan', orderUndo: null, ordering: false });
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
    await store().loadData('/fixtures');
    await settle();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({ orderUndo: null, ordering: false, drawingZone: null, mode: 'plan' });
  });

  const permutations = <T,>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));
  const distance = () => {
    const r = store().route;
    return r.status === 'ready' ? r.result.distanceM : NaN;
  };

  /** Sets the stops to the first 3 fixture stops in an order the finder changes; returns that order and its distance. */
  async function scramble(): Promise<{ order: string[]; distanceM: number }> {
    const base = store().stops.slice(0, 3);
    for (const p of permutations(base)) {
      useAppStore.setState({ stops: p, orderUndo: null });
      await store().planRoute();
      const before = distance();
      await store().bestOrder();
      if (store().orderUndo) {
        // Put things back so each test starts from the scrambled order.
        useAppStore.setState({ stops: p, orderUndo: null });
        await store().planRoute();
        return { order: p.map((s) => s.id), distanceM: before };
      }
    }
    throw new Error('no permutation of the fixture stops changes');
  }

  it('reorders, keeps stop objects, reroutes and is not longer', async () => {
    const { order, distanceM } = await scramble();
    await store().bestOrder();
    await settle();
    expect(ids()).not.toEqual(order);
    expect([...ids()].sort()).toEqual([...order].sort());
    expect(distance()).toBeLessThanOrEqual(distanceM + 1e-9);
    expect(store().orderUndo).not.toBeNull();
  });

  it('undo restores the old order and reroutes', async () => {
    const { order, distanceM } = await scramble();
    await store().bestOrder();
    await settle();
    store().undoOrder();
    await settle();
    expect(ids()).toEqual(order);
    expect(distance()).toBeCloseTo(distanceM);
    expect(store().orderUndo).toBeNull();
  });

  it('says so and changes nothing when the order is already best', async () => {
    await scramble();
    await store().bestOrder();
    await settle();
    const best = ids();
    await store().bestOrder();
    expect(ids()).toEqual(best);
    expect(store().notice).toMatch(/already/);
  });

  it('ignores a reply when the stops changed meanwhile', async () => {
    const { order } = await scramble();
    const pending = store().bestOrder();
    // Rename a stop while the engine is thinking.
    useAppStore.setState({ stops: store().stops.map((s, i) => (i === 0 ? { ...s, name: 'Renamed' } : s)) });
    await pending;
    await settle();
    expect(ids()).toEqual(order);
    expect(store().stops[0]!.name).toBe('Renamed');
    expect(store().orderUndo).toBeNull();
    expect(store().ordering).toBe(false);
  });

  it('does nothing in Walk mode, while drawing a zone, or with fewer than 3 stops', async () => {
    const sent = () => worker.sent.filter((m) => m.type === 'order').length;
    store().setMode('walk');
    await store().bestOrder();
    store().setMode('plan');
    useAppStore.setState({ drawingZone: [] });
    await store().bestOrder();
    useAppStore.setState({ drawingZone: null, stops: store().stops.slice(0, 2) });
    await store().bestOrder();
    expect(sent()).toBe(0);
  });
});
