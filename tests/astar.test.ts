import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { START_ID } from '../src/contracts.ts';
import type { Cell, GridMeta, RouteResult, Stop } from '../src/contracts.ts';
import { parseGrid } from '../src/data/grid.ts';
import { AStar, astarRoute } from '../src/engine/astar.ts';
import { MinHeap } from '../src/engine/heap.ts';
import { handleMessage } from '../src/engine/worker.ts';
import type { WorkerIn } from '../src/engine/worker.ts';
import { DEFAULT_CONSTRAINTS } from '../src/store.ts';

const CELL = 5;
const BIG = { oxygenMin: 1e6, reservePct: 0, maxSlopeDeg: 25 };

function gridMeta(width: number, height: number): GridMeta {
  return { width, height, cellSizeM: CELL, maxSlopeDeg: 25, habitat: { x: 0, y: 0 } };
}

function openGrid(w: number, h: number): Float32Array {
  return new Float32Array(w * h).fill(1);
}

function block(cost: Float32Array, w: number, cells: Cell[]): void {
  for (const c of cells) cost[c.y * w + c.x] = Infinity;
}

function stop(id: string, cell: Cell): Stop {
  return { id, name: id, cell, goal: '', geologyUnit: '', minerals: [], photo: '', scienceValue: 1 };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGrid(w: number, h: number, blockedFrac: number, seed: number): Float32Array {
  const r = rng(seed);
  const cost = new Float32Array(w * h);
  for (let i = 0; i < cost.length; i++) cost[i] = r() < blockedFrac ? Infinity : 1 + 3 * r();
  return cost;
}

/** Every step is one of the 8 neighbours, on an open cell, without cutting a blocked corner. */
function expectValidPath(path: Cell[], cost: Float32Array, w: number): void {
  const open = (x: number, y: number) => Number.isFinite(cost[y * w + x]!);
  for (const p of path) expect(open(p.x, p.y)).toBe(true);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    expect(Math.max(Math.abs(dx), Math.abs(dy))).toBe(1);
    if (dx !== 0 && dy !== 0) {
      expect(open(a.x + dx, a.y)).toBe(true);
      expect(open(a.x, a.y + dy)).toBe(true);
    }
  }
}

/** Brute-force Dijkstra with the same edge rules, as a reference for optimality. */
function dijkstraCost(cost: Float32Array, w: number, h: number, s: Cell, g: Cell): number {
  const dist = new Float64Array(w * h).fill(Infinity);
  const done = new Uint8Array(w * h);
  dist[s.y * w + s.x] = 0;
  for (;;) {
    let cur = -1;
    let best = Infinity;
    for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i]! < best) (best = dist[i]!), (cur = i);
    if (cur === -1) return Infinity;
    if (cur === g.y * w + g.x) return best;
    done[cur] = 1;
    const cx = cur % w;
    const cy = (cur - cx) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!Number.isFinite(cost[ni]!)) continue;
        if (dx && dy && (!Number.isFinite(cost[cy * w + nx]!) || !Number.isFinite(cost[ny * w + cx]!))) continue;
        const d = best + (dx && dy ? Math.SQRT2 : 1) * CELL * 0.5 * (cost[cur]! + cost[ni]!);
        if (d < dist[ni]!) dist[ni] = d;
      }
    }
  }
}

describe('MinHeap', () => {
  it('pops ids in key order and grows past its capacity', () => {
    const heap = new MinHeap(2);
    const r = rng(1);
    const keys = Array.from({ length: 500 }, () => r());
    keys.forEach((k, i) => heap.push(i, k));
    const popped: number[] = [];
    while (heap.size > 0) popped.push(keys[heap.pop()]!);
    expect(popped).toEqual([...keys].sort((a, b) => a - b));
    expect(heap.pop()).toBe(-1);
  });
});

describe('AStar.findPath', () => {
  it('follows a straight open line with the expected length', () => {
    const w = 20;
    const astar = new AStar(gridMeta(w, 5), openGrid(w, 5));
    const res = astar.findPath({ x: 0, y: 2 }, { x: 19, y: 2 })!;
    expect(res.path).toHaveLength(20);
    expect(res.path.every((p) => p.y === 2)).toBe(true);
    expect(res.cost).toBeCloseTo(19 * CELL, 3);
  });

  it('takes the pure diagonal with √2 step cost', () => {
    const astar = new AStar(gridMeta(10, 10), openGrid(10, 10));
    const res = astar.findPath({ x: 0, y: 0 }, { x: 9, y: 9 })!;
    expect(res.path).toHaveLength(10);
    expect(res.cost).toBeCloseTo(9 * Math.SQRT2 * CELL, 3);
  });

  it('goes through the gap in a wall', () => {
    const w = 15;
    const h = 15;
    const cost = openGrid(w, h);
    const gapY = 11;
    block(cost, w, Array.from({ length: h }, (_, y) => ({ x: 7, y })).filter((c) => c.y !== gapY));
    const res = new AStar(gridMeta(w, h), cost).findPath({ x: 0, y: 0 }, { x: 14, y: 0 })!;
    expect(res).not.toBeNull();
    expect(res.path).toContainEqual({ x: 7, y: gapY });
    expectValidPath(res.path, cost, w);
  });

  it('returns null when the goal is walled off', () => {
    const w = 10;
    const cost = openGrid(w, 10);
    block(cost, w, Array.from({ length: 10 }, (_, y) => ({ x: 5, y })));
    expect(new AStar(gridMeta(w, 10), cost).findPath({ x: 0, y: 0 }, { x: 9, y: 9 })).toBeNull();
  });

  it('does not cut diagonally between two blocked corners', () => {
    const cost = openGrid(2, 2);
    block(cost, 2, [{ x: 1, y: 0 }, { x: 0, y: 1 }]);
    expect(new AStar(gridMeta(2, 2), cost).findPath({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it('returns null for a blocked or off-grid endpoint, and [start] when start = goal', () => {
    const cost = openGrid(5, 5);
    block(cost, 5, [{ x: 4, y: 4 }]);
    const astar = new AStar(gridMeta(5, 5), cost);
    expect(astar.findPath({ x: 0, y: 0 }, { x: 4, y: 4 })).toBeNull();
    expect(astar.findPath({ x: 0, y: 0 }, { x: 9, y: 0 })).toBeNull();
    expect(astar.findPath({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual({ path: [{ x: 2, y: 2 }], cost: 0 });
  });

  it('matches brute-force Dijkstra cost on random weighted grids', () => {
    const w = 30;
    const h = 30;
    for (let seed = 1; seed <= 8; seed++) {
      const cost = randomGrid(w, h, 0.25, seed);
      cost[0] = 1;
      cost[w * h - 1] = 1;
      const astar = new AStar(gridMeta(w, h), cost);
      const res = astar.findPath({ x: 0, y: 0 }, { x: w - 1, y: h - 1 });
      const ref = dijkstraCost(cost, w, h, { x: 0, y: 0 }, { x: w - 1, y: h - 1 });
      if (ref === Infinity) {
        expect(res).toBeNull();
      } else {
        expect(res).not.toBeNull();
        expect(res!.cost).toBeCloseTo(ref, 1);
        expectValidPath(res!.path, cost, w);
      }
    }
  });
});

describe('A* on the 100×100 fixture', () => {
  const FIX = join(import.meta.dirname, '..', 'fixtures');
  const buf = (f: string) => {
    const b = readFileSync(join(FIX, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  };
  const grid = parseGrid(
    {
      meta: JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8')) as GridMeta,
      cost: buf('cost.bin'),
      elevation: buf('elevation.bin'),
      sand: buf('sand.bin'),
      stops: JSON.parse(readFileSync(join(FIX, 'stops.json'), 'utf8')) as Stop[],
    },
    'basemap.png',
  );
  const { meta, cost, stops } = grid;
  const astar = new AStar(meta, cost);

  it('routes habitat → every stop → habitat over open cells', () => {
    const res = astarRoute(astar, { start: meta.habitat, stops, constraints: DEFAULT_CONSTRAINTS }, meta);
    expect(res.path[0]).toEqual(meta.habitat);
    expect(res.path.at(-1)).toEqual(meta.habitat);
    expectValidPath(res.path, cost, meta.width);
    expect(res.legs.map((l) => l.toId)).toEqual([...stops.map((s) => s.id), START_ID]);
    for (const [i, leg] of res.legs.entries()) {
      const target = leg.toId === START_ID ? meta.habitat : stops.find((s) => s.id === leg.toId)!.cell;
      expect(res.path[leg.endIdx]).toEqual(target);
      if (i > 0) expect(leg.startIdx).toBe(res.legs[i - 1]!.endIdx);
    }
    expect(res.legs[0]!.startIdx).toBe(0);
    expect(res.legs.at(-1)!.endIdx).toBe(res.path.length - 1);
    expect(res.distanceM).toBeGreaterThan(0);
    expect(res.timeMin).toBeGreaterThan(0);
  });

  it('avoids the blocked cells that a straight line would cross', () => {
    const blocked = (c: Cell) => !Number.isFinite(cost[c.y * meta.width + c.x]!);
    const res = astarRoute(astar, { start: meta.habitat, stops, constraints: DEFAULT_CONSTRAINTS }, meta);
    expect(res.path.some(blocked)).toBe(false);
  });

  // M10: multi-stop routes on the fixture.
  const byId = (id: string) => stops.find((s) => s.id === id)!;
  const route = (list: Stop[]) => astarRoute(astar, { start: meta.habitat, stops: list, constraints: DEFAULT_CONSTRAINTS }, meta);

  /** Legs chain end-to-start, cover the whole path, and each ends on its target. */
  function expectChained(res: RouteResult, list: Stop[]): void {
    expect(res.path[0]).toEqual(meta.habitat);
    expect(res.path.at(-1)).toEqual(meta.habitat);
    expect(res.legs[0]!.startIdx).toBe(0);
    expect(res.legs.at(-1)!.endIdx).toBe(res.path.length - 1);
    for (let i = 0; i + 1 < res.legs.length; i++) expect(res.legs[i]!.endIdx).toBe(res.legs[i + 1]!.startIdx);
    for (const leg of res.legs) {
      expect(res.path[leg.startIdx]).toEqual(leg.fromId === START_ID ? meta.habitat : byId(leg.fromId).cell);
      expect(res.path[leg.endIdx]).toEqual(leg.toId === START_ID ? meta.habitat : byId(leg.toId).cell);
    }
    expect(res.legs.map((l) => l.toId)).toEqual([...list.map((s) => s.id), START_ID]);
    expectValidPath(res.path, cost, meta.width);
  }

  it('0 stops → path is just the habitat, with no legs', () => {
    const res = route([]);
    expect(res.path).toEqual([meta.habitat]);
    expect(res.legs).toEqual([]);
    expect(res.outOfRangeIds).toEqual([]);
    expect(res.distanceM).toBe(0);
  });

  it('2 stops → 3 chained legs: start→A, A→B, B→start', () => {
    const list = [byId('stop-a'), byId('stop-c')];
    const res = route(list);
    expect(res.legs.map((l) => [l.fromId, l.toId])).toEqual([
      [START_ID, 'stop-a'],
      ['stop-a', 'stop-c'],
      ['stop-c', START_ID],
    ]);
    expectChained(res, list);
  });

  it('visits stops in the given order, not reordered', () => {
    const forward = stops;
    const reversed = [...stops].reverse();
    const shuffled = ['stop-c', 'stop-a', 'stop-d', 'stop-b'].map(byId);
    for (const list of [forward, reversed, shuffled]) expectChained(route(list), list);
    // A different order is a different walk, not the same route relabelled.
    expect(route(reversed).path).not.toEqual(route(forward).path);
  });

  it('an unreachable stop goes in outOfRangeIds and the route carries on to the next stop', () => {
    // (69, 25) is open ground with no path from the habitat (walled off by steep cells).
    const island = { ...byId('stop-b'), id: 'island', cell: { x: 69, y: 25 } };
    expect(Number.isFinite(cost[island.cell.y * meta.width + island.cell.x]!)).toBe(true);
    expect(astar.findPath(meta.habitat, island.cell)).toBeNull();

    const res = route([byId('stop-a'), island, byId('stop-d')]);
    expect(res.outOfRangeIds).toEqual(['island']);
    expect(res.legs.map((l) => [l.fromId, l.toId])).toEqual([
      [START_ID, 'stop-a'],
      ['stop-a', 'stop-d'],
      ['stop-d', START_ID],
    ]);
    expectChained(res, [byId('stop-a'), byId('stop-d')]);
  });
});

describe('worker contract', () => {
  const w = 10;
  const meta = gridMeta(w, 10);

  function run(cost: Float32Array, msgs: WorkerIn[]) {
    let state: Parameters<typeof handleMessage>[0] = null;
    const outs = [];
    for (const m of msgs) {
      const res = handleMessage(state, m);
      state = res.state;
      if (res.out) outs.push(res.out);
    }
    return outs;
  }

  it('answers init + route with an A* RouteResult', () => {
    const cost = openGrid(w, 10);
    block(cost, w, Array.from({ length: 9 }, (_, y) => ({ x: 5, y }))); // wall, gap at y = 9
    const outs = run(cost, [
      { type: 'init', meta, cost },
      { type: 'route', req: { start: { x: 0, y: 0 }, stops: [stop('a', { x: 9, y: 0 })], constraints: BIG } },
    ]);
    expect(outs).toHaveLength(1);
    const out = outs[0]!;
    expect(out.type).toBe('route');
    const res = (out as { result: RouteResult }).result;
    expect(res.path).toContainEqual({ x: 5, y: 9 });
    expect(res.outOfRangeIds).toEqual([]);
    expect(res.legs.map((l) => [l.fromId, l.toId])).toEqual([
      [START_ID, 'a'],
      ['a', START_ID],
    ]);
  });

  it('reports a fully blocked stop in outOfRangeIds instead of throwing', () => {
    const cost = openGrid(w, 10);
    block(cost, w, Array.from({ length: 10 }, (_, y) => ({ x: 5, y })));
    const req = { start: { x: 0, y: 0 }, stops: [stop('far', { x: 9, y: 0 })], constraints: BIG };
    const outs = run(cost, [{ type: 'init', meta, cost }, { type: 'route', req }]);
    const res = (outs[0] as { type: 'route'; result: RouteResult }).result;
    expect(outs[0]!.type).toBe('route');
    expect(res.outOfRangeIds).toEqual(['far']);
    expect(res.path).toEqual([{ x: 0, y: 0 }]);
    expect(res.legs).toEqual([]);
    expect(res.distanceM).toBe(0);
  });

  it('skips an unreachable stop and still routes to the reachable ones', () => {
    const cost = openGrid(w, 10);
    block(cost, w, Array.from({ length: 10 }, (_, y) => ({ x: 5, y })));
    const req = {
      start: { x: 0, y: 0 },
      stops: [stop('far', { x: 9, y: 0 }), stop('near', { x: 3, y: 3 })],
      constraints: BIG,
    };
    const res = astarRoute(new AStar(meta, cost), req, meta);
    expect(res.outOfRangeIds).toEqual(['far']);
    expect(res.legs.map((l) => l.toId)).toEqual(['near', START_ID]);
    expect(res.path.at(-1)).toEqual({ x: 0, y: 0 });
  });

  it('flags a reachable stop that blows the oxygen budget', () => {
    const cost = openGrid(w, 10);
    const req = {
      start: { x: 0, y: 0 },
      stops: [stop('a', { x: 9, y: 9 })],
      constraints: { oxygenMin: 0.5, reservePct: 0, maxSlopeDeg: 25 },
    };
    expect(astarRoute(new AStar(meta, cost), req, meta).outOfRangeIds).toEqual(['a']);
  });
});

describe('performance', () => {
  it('finds a corner-to-corner path on a random 600×600 grid in under 1 s', () => {
    const n = 600;
    const cost = randomGrid(n, n, 0.2, 42);
    cost[0] = 1;
    cost[n * n - 1] = 1;
    const meta = gridMeta(n, n);

    const t0 = performance.now();
    const astar = new AStar(meta, cost);
    const t1 = performance.now();
    const res = astar.findPath({ x: 0, y: 0 }, { x: n - 1, y: n - 1 });
    const t2 = performance.now();

    console.log(
      `[M07 timing] 600x600, 20% blocked: init ${(t1 - t0).toFixed(1)} ms, ` +
        `findPath ${(t2 - t1).toFixed(1)} ms, path ${res?.path.length ?? 0} cells`,
    );
    expect(res).not.toBeNull();
    expectValidPath(res!.path, cost, n);
    expect(t2 - t0).toBeLessThan(1000);
  });
});
