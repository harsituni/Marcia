import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Cell, GridMeta, RingResult, RouteResult, Stop } from '../src/contracts.ts';
import { parseGrid } from '../src/data/grid.ts';
import { AStar, astarRoute } from '../src/engine/astar.ts';
import { OXYGEN_MIN_PER_MIN, WALK_SPEED_M_PER_MIN } from '../src/engine/model.ts';
import { HomeField, ringMask, ringPolygon } from '../src/engine/ring.ts';
import { handleMessage } from '../src/engine/worker.ts';

const CELL = 5;
const meta = (w: number, h: number, habitat: Cell): GridMeta => ({ width: w, height: h, cellSizeM: CELL, maxSlopeDeg: 25, habitat });
const open = (w: number, h: number) => new Float32Array(w * h).fill(1);
/** Oxygen minutes needed to walk `cells` straight cells home. */
const budgetFor = (cells: number) => ((cells * CELL) / WALK_SPEED_M_PER_MIN) * OXYGEN_MIN_PER_MIN;

/** Ray-casting point-in-polygon. */
function inside(p: Cell, poly: Cell[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function stop(id: string, cell: Cell): Stop {
  return { id, name: id, cell, goal: '', geologyUnit: '', minerals: [], photo: '', scienceValue: 1 };
}

describe('HomeField (Dijkstra from the habitat)', () => {
  it('gives straight and diagonal walking minutes on an open grid', () => {
    const f = new HomeField(meta(21, 21, { x: 10, y: 10 }), open(21, 21), { x: 10, y: 10 });
    expect(f.minutesFrom({ x: 10, y: 10 })).toBe(0);
    expect(f.minutesFrom({ x: 20, y: 10 })).toBeCloseTo(budgetFor(10), 5);
    expect(f.minutesFrom({ x: 15, y: 15 })).toBeCloseTo(budgetFor(5 * Math.SQRT2), 5);
    expect(f.minutesFrom({ x: 30, y: 0 })).toBe(Infinity); // off grid
  });

  it('matches the A* path length home for every fixture stop', () => {
    const FIX = join(import.meta.dirname, '..', 'fixtures');
    const b = (f: string) => {
      const x = readFileSync(join(FIX, f));
      return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer;
    };
    const m = JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8')) as GridMeta;
    const grid = parseGrid(
      { meta: m, cost: b('cost.bin'), elevation: b('elevation.bin'), sand: b('sand.bin'), stops: JSON.parse(readFileSync(join(FIX, 'stops.json'), 'utf8')) },
      'x',
    );
    const f = new HomeField(m, grid.cost, m.habitat);
    const astar = new AStar(m, grid.cost);
    for (const s of grid.stops) {
      const p = astar.findPath(s.cell, m.habitat)!;
      let len = 0;
      for (let i = 1; i < p.path.length; i++) len += Math.hypot(p.path[i]!.x - p.path[i - 1]!.x, p.path[i]!.y - p.path[i - 1]!.y);
      // Same cheapest-path cost; length can differ only between equal-cost ties.
      expect(f.minutesFrom(s.cell)).toBeCloseTo((len * m.cellSizeM) / WALK_SPEED_M_PER_MIN, 1);
    }
  });
});

describe('ringPolygon', () => {
  const W = 101;
  const H = 101;
  const hab = { x: 50, y: 50 };

  it('on an open grid is an octagon of the expected radius (8-direction walking)', () => {
    const R = 30;
    const f = new HomeField(meta(W, H, hab), open(W, H), hab);
    const { polygon } = ringPolygon(f, budgetFor(R));
    expect(polygon.length).toBeGreaterThanOrEqual(8);
    expect(polygon.length).toBeLessThanOrEqual(200);
    expect(polygon[0]).not.toEqual(polygon.at(-1)); // closed, first point not repeated
    // Along the axes the reach is exactly R cells (outline at the cell border, R + 0.5).
    const xs = polygon.map((p) => p.x);
    const ys = polygon.map((p) => p.y);
    expect(Math.max(...xs) - hab.x).toBeCloseTo(R + 0.5, 0);
    expect(hab.x - Math.min(...xs)).toBeCloseTo(R + 0.5, 0);
    expect(Math.max(...ys) - hab.y).toBeCloseTo(R + 0.5, 0);
    expect(hab.y - Math.min(...ys)).toBeCloseTo(R + 0.5, 0);
    // Every vertex lies between the octagon's inner and outer radius (±1 cell).
    for (const p of polygon) {
      const r = Math.hypot(p.x - hab.x, p.y - hab.y);
      expect(r).toBeGreaterThanOrEqual(R * Math.cos(Math.PI / 8) - 1);
      expect(r).toBeLessThanOrEqual(R + 1.5);
    }
    expect(inside(hab, polygon)).toBe(true);
  });

  it('does not leak through a wall', () => {
    const cost = open(W, H);
    for (let y = 0; y < H; y++) cost[y * W + 60] = Infinity; // wall at x = 60, ten cells east
    const f = new HomeField(meta(W, H, hab), cost, hab);
    const { polygon } = ringPolygon(f, budgetFor(30));
    expect(Math.max(...polygon.map((p) => p.x))).toBeLessThanOrEqual(59.5);
    expect(inside({ x: 70, y: 50 }, polygon)).toBe(false);
    expect(Math.min(...polygon.map((p) => p.x))).toBeCloseTo(hab.x - 30.5, 0); // still full reach westward
  });

  it('never includes blocked cells in the reachable mask, and keeps edge blocks outside the outline', () => {
    const cost = open(W, H);
    // A 6×6 block straddling the ring edge east of the habitat.
    for (let y = 47; y < 53; y++) for (let x = 77; x < 83; x++) cost[y * W + x] = Infinity;
    // Scattered blocked cells.
    for (let i = 0; i < W * H; i += 37) cost[i] = Infinity;
    cost[hab.y * W + hab.x] = 1;
    const f = new HomeField(meta(W, H, hab), cost, hab);
    const mask = ringMask(f, budgetFor(30));
    for (let i = 0; i < W * H; i++) if (cost[i] === Infinity) expect(mask[i]).toBe(0);
    const { polygon } = ringPolygon(f, budgetFor(30));
    expect(inside({ x: 80, y: 50 }, polygon)).toBe(false);
  });

  it('budget 0 → just the habitat cell; negative or blocked habitat → empty', () => {
    const f = new HomeField(meta(W, H, hab), open(W, H), hab);
    const one = ringPolygon(f, 0).polygon;
    expect(one).toHaveLength(4);
    expect(one).toEqual(expect.arrayContaining([{ x: 49.5, y: 49.5 }, { x: 50.5, y: 50.5 }]));
    expect(ringPolygon(f, -1).polygon).toEqual([]);
    const blocked = open(W, H);
    blocked[hab.y * W + hab.x] = Infinity;
    expect(ringPolygon(new HomeField(meta(W, H, hab), blocked, hab), 100).polygon).toEqual([]);
  });

  it('simplifies big rings to at most 200 points', () => {
    const cost = open(W, H);
    for (let i = 0; i < W * H; i += 7) cost[i] = Infinity; // ragged outline
    cost[hab.y * W + hab.x] = 1;
    const { polygon } = ringPolygon(new HomeField(meta(W, H, hab), cost, hab), budgetFor(45));
    expect(polygon.length).toBeGreaterThan(3);
    expect(polygon.length).toBeLessThanOrEqual(200);
  });
});

describe('worker + outOfRangeIds', () => {
  const W = 41;
  const hab = { x: 20, y: 20 };
  const m = meta(W, W, hab);

  it('answers `ring` from the Dijkstra field (habitat inside, not the mock circle)', () => {
    const cost = open(W, W);
    const { state } = handleMessage(null, { type: 'init', meta: m, cost });
    const out = handleMessage(state, { type: 'ring', oxygenLeftMin: budgetFor(10) }).out as { type: 'ring'; result: RingResult };
    expect(out.type).toBe('ring');
    expect(inside(hab, out.result.polygon)).toBe(true);
    expect(Math.max(...out.result.polygon.map((p) => p.x)) - hab.x).toBeCloseTo(10.5, 0);
  });

  it('flags a stop beyond the budget, using the cached field (same result as per-stop A*)', () => {
    const cost = open(W, W);
    const stops = [stop('near', { x: 25, y: 20 }), stop('far', { x: 40, y: 40 })];
    // Out 5 + back 5 = 10 cells; far: needs much more.
    const constraints = { oxygenMin: budgetFor(12), reservePct: 0, maxSlopeDeg: 25 };
    const { state } = handleMessage(null, { type: 'init', meta: m, cost });
    const viaWorker = (handleMessage(state, { type: 'route', req: { start: hab, stops, constraints } }).out as { type: 'route'; result: RouteResult }).result;
    const viaAStar = astarRoute(new AStar(m, cost), { start: hab, stops, constraints }, m);
    expect(viaWorker.outOfRangeIds).toContain('far');
    expect(viaWorker.outOfRangeIds).not.toContain('near');
    expect(viaWorker.outOfRangeIds).toEqual(viaAStar.outOfRangeIds);
  });
});

describe('performance', () => {
  it('Dijkstra over a random 600×600 grid takes under 1 s', () => {
    const n = 600;
    let a = 7;
    const rnd = () => ((a = (a * 1103515245 + 12345) >>> 0) / 4294967296);
    const cost = new Float32Array(n * n);
    for (let i = 0; i < cost.length; i++) cost[i] = rnd() < 0.2 ? Infinity : 1 + 3 * rnd();
    const hab = { x: 300, y: 300 };
    cost[hab.y * n + hab.x] = 1;
    const t0 = performance.now();
    const f = new HomeField(meta(n, n, hab), cost, hab);
    const t1 = performance.now();
    const ring = ringPolygon(f, 60);
    const t2 = performance.now();
    console.log(`[M18 timing] 600x600 Dijkstra ${(t1 - t0).toFixed(1)} ms, ring threshold+trace ${(t2 - t1).toFixed(1)} ms, ${ring.polygon.length} points`);
    expect(t1 - t0).toBeLessThan(1000);
  });
});
