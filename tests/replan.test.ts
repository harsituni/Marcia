import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { START_ID } from '../src/contracts.ts';
import type { Cell, Constraints, GridMeta, Stop } from '../src/contracts.ts';
import { AStar } from '../src/engine/astar.ts';
import { OXYGEN_MIN_PER_MIN, WALK_SPEED_M_PER_MIN } from '../src/engine/model.ts';
import { replanRoute } from '../src/engine/replan.ts';
import { handleMessage } from '../src/engine/worker.ts';

// Open 60 × 20 grid, 5 m cells: 10 cells = 50 m = 1 oxygen-minute.
const CELL = 5;
const habitat = { x: 0, y: 10 };
const meta: GridMeta = { width: 60, height: 20, cellSizeM: CELL, maxSlopeDeg: 25, habitat };
const open = () => new Float32Array(meta.width * meta.height).fill(1);
const stop = (id: string, x: number, y: number, scienceValue: 1 | 2 | 3): Stop => ({ id, name: id, cell: { x, y }, goal: '', geologyUnit: '', minerals: [], photo: '', scienceValue });
/** No reserve, so the budget is exactly the oxygen left. */
const constraints: Constraints = { oxygenMin: 100, reservePct: 0, maxSlopeDeg: 25 };
const minutes = (cells: number) => ((cells * CELL) / WALK_SPEED_M_PER_MIN) * OXYGEN_MIN_PER_MIN;
const plan = (from: Cell, stops: Stop[], oxygenLeftMin: number, c = constraints, cost = open()) =>
  replanRoute(new AStar(meta, cost), { from, stops, constraints: c, oxygenLeftMin }, meta);

describe('replanRoute', () => {
  const from = { x: 20, y: 10 };
  // East along row 10: a at x=30, b at x=40, c at x=50.
  const a = stop('a', 30, 10, 2);
  const b = stop('b', 40, 10, 1);
  const c = stop('c', 50, 10, 3);

  it('keeps every stop when the oxygen covers the whole plan, and ends at the habitat', () => {
    const r = plan(from, [a, b, c], minutes(30 + 50));
    expect(r.outOfRangeIds).toEqual([]);
    expect(r.legs.map((l) => [l.fromId, l.toId])).toEqual([
      [START_ID, 'a'],
      ['a', 'b'],
      ['b', 'c'],
      ['c', START_ID],
    ]);
    expect(r.path[0]).toEqual(from);
    expect(r.path.at(-1)).toEqual(habitat);
    expect(r.distanceM).toBe(80 * CELL);
    expect(r.oxygenUsedMin).toBeCloseTo(minutes(80));
    r.legs.forEach((l, i) => i > 0 && expect(l.startIdx).toBe(r.legs[i - 1]!.endIdx));
    expect(r.path[r.legs[0]!.endIdx]).toEqual(a.cell);
  });

  it('drops the lowest science value first', () => {
    // b (value 1) sits between a and c, so dropping it saves nothing: the plan still needs 80 cells.
    // Next lowest is a (value 2), which also saves nothing. Then c (value 3).
    const r = plan(from, [a, b, c], minutes(79));
    expect(r.outOfRangeIds).toEqual(['a', 'b', 'c']);
    expect(r.legs.map((l) => l.toId)).toEqual([START_ID]);
    expect(r.path.at(-1)).toEqual(habitat);

    // With the low-value stop out on a detour, dropping just that one is enough.
    const detour = stop('detour', 30, 0, 1); // 10 cells north of the row
    const r2 = plan(from, [detour, c], minutes(30 + 50 + 1));
    expect(r2.outOfRangeIds).toEqual(['detour']);
    expect(r2.legs.map((l) => l.toId)).toEqual(['c', START_ID]);
  });

  it('never drops a higher-value stop while a lower-value one is still in the plan', () => {
    const far3 = stop('far3', 55, 10, 3);
    const near1 = stop('near1', 25, 10, 1);
    const mid2 = stop('mid2', 40, 0, 2);
    for (let oxygen = 0; oxygen <= 30; oxygen += 0.5) {
      const dropped = new Set(plan(from, [near1, mid2, far3], oxygen).outOfRangeIds);
      if (dropped.has('far3')) expect(dropped.has('mid2') && dropped.has('near1')).toBe(true);
      if (dropped.has('mid2')) expect(dropped.has('near1')).toBe(true);
    }
  });

  it('among equal values, drops the one that saves the most walking', () => {
    const onTheWay = stop('on-the-way', 30, 10, 1);
    const bigDetour = stop('big-detour', 35, 0, 1);
    const r = plan(from, [onTheWay, bigDetour, c], minutes(30 + 50 + 2));
    expect(r.outOfRangeIds).toEqual(['big-detour']);
  });

  it('the budget is the oxygen left minus the reserve on the full supply', () => {
    const reserve20: Constraints = { oxygenMin: 100, reservePct: 20, maxSlopeDeg: 25 }; // 20 min reserve
    const need = minutes(80); // 8 min
    expect(plan(from, [a, b, c], need + 20, reserve20).outOfRangeIds).toEqual([]);
    expect(plan(from, [a, b, c], need + 19.9, reserve20).outOfRangeIds).not.toEqual([]);
  });

  it('always returns the way home, even with no oxygen to spare', () => {
    const r = plan(from, [a, b, c], 0);
    expect(r.outOfRangeIds).toEqual(['a', 'b', 'c']);
    expect(r.legs).toEqual([{ fromId: START_ID, toId: START_ID, startIdx: 0, endIdx: 20 }]);
    expect(r.path).toHaveLength(21);
    expect(r.oxygenUsedMin).toBeCloseTo(minutes(20));
  });

  it('drops a stop with no walkable path and keeps the rest', () => {
    const cost = open();
    // Wall off the cell around stop a.
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) cost[(10 + dy) * meta.width + 30 + dx] = Infinity;
    const r = plan(from, [a, c], 999, constraints, cost);
    expect(r.outOfRangeIds).toEqual(['a']);
    expect(r.legs.map((l) => l.toId)).toEqual(['c', START_ID]);
    for (const cell of r.path) expect(Number.isFinite(cost[cell.y * meta.width + cell.x])).toBe(true);
  });

  it('rounds a between-cells position, and standing on the habitat with nothing left is no walk', () => {
    expect(plan({ x: 19.6, y: 10.2 }, [], 50).path[0]).toEqual({ x: 20, y: 10 });
    const r = plan(habitat, [], 50);
    expect(r.path).toEqual([habitat]);
    expect(r.legs).toEqual([]);
    expect(r.distanceM).toBe(0);
  });

  it('with no way home, returns just the current position', () => {
    const cost = open();
    for (let y = 0; y < meta.height; y++) cost[y * meta.width + 10] = Infinity; // wall between crew and habitat
    const r = plan(from, [a], 999, constraints, cost);
    expect(r.path).toEqual([from]);
    expect(r.legs).toEqual([]);
    expect(r.outOfRangeIds).toEqual(['a']);
    expect(r.distanceM).toBe(0);
  });
});

describe('worker replan on the fixtures', () => {
  const FIX = join(import.meta.dirname, '..', 'fixtures');
  const fmeta = JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8')) as GridMeta;
  const stops = JSON.parse(readFileSync(join(FIX, 'stops.json'), 'utf8')) as Stop[];
  const buf = readFileSync(join(FIX, 'cost.bin'));
  const cost = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { state } = handleMessage(null, { type: 'init', meta: fmeta, cost });
  const c: Constraints = { oxygenMin: 60, reservePct: 20, maxSlopeDeg: 25 };
  const replan = (oxygenLeftMin: number) => {
    const out = handleMessage(state, { type: 'replan', from: stops[0]!.cell, stops: stops.slice(1), constraints: c, oxygenLeftMin }).out;
    if (out?.type !== 'route') throw new Error('expected a route');
    return out.result;
  };

  it('answers `replan` with a route from the current position to the habitat', () => {
    const r = replan(60);
    expect(r.path[0]).toEqual(stops[0]!.cell);
    expect(r.path.at(-1)).toEqual(fmeta.habitat);
    expect(r.outOfRangeIds).toEqual([]);
    expect(r.legs.map((l) => l.toId)).toEqual(['stop-b', 'stop-c', 'stop-d', START_ID]);
  });

  it('drops stops as the oxygen runs down, lowest science value first, and always fits what it keeps', () => {
    const value = new Map(stops.map((s) => [s.id, s.scienceValue]));
    let prevDropped = 0;
    for (let oxygen = 40; oxygen >= 12; oxygen -= 1) {
      const r = replan(oxygen);
      const dropped = r.outOfRangeIds;
      const kept = stops.slice(1).filter((s) => !dropped.includes(s.id));
      // Whatever is kept is worth at least as much as anything dropped.
      const minKept = Math.min(4, ...kept.map((s) => s.scienceValue));
      for (const id of dropped) expect(value.get(id)!).toBeLessThanOrEqual(minKept);
      if (kept.length > 0) expect(r.oxygenUsedMin).toBeLessThanOrEqual(oxygen - 12 + 1e-6);
      expect(dropped.length).toBeGreaterThanOrEqual(prevDropped);
      prevDropped = dropped.length;
    }
    expect(prevDropped).toBe(3);
  });
});
