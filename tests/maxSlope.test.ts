import { describe, expect, it } from 'vitest';
import type { GridMeta, RouteResult, Stop } from '../src/contracts.ts';
import { handleMessage, limitCost, slopeGrid } from '../src/engine/worker.ts';
import type { WorkerIn } from '../src/engine/worker.ts';

const W = 30;
const H = 30;
const CELL = 5;
const meta: GridMeta = { width: W, height: H, cellSizeM: CELL, maxSlopeDeg: 25, habitat: { x: 3, y: 5 } };
const cost = new Float32Array(W * H).fill(1);

/** Flat ground with a ~20° ridge across columns 12..18, rows 0..21; rows 22+ are a flat way round. */
const RAMP_DEG = 20;
const elevation = new Float32Array(W * H);
for (let y = 0; y < 22; y++)
  for (let x = 0; x < W; x++) elevation[y * W + x] = Math.max(0, 3 - Math.abs(x - 15)) * CELL * Math.tan((RAMP_DEG * Math.PI) / 180);

const stop: Stop = { id: 's1', name: 'Far side', cell: { x: 27, y: 5 }, goal: '', geologyUnit: '', minerals: [], photo: '', scienceValue: 'high' } as unknown as Stop;

function routeAt(limit: number, withElevation = true): RouteResult {
  const init: WorkerIn = withElevation ? { type: 'init', meta, cost, elevation } : { type: 'init', meta, cost };
  const { state } = handleMessage(null, init);
  const { out } = handleMessage(state, { type: 'route', req: { start: meta.habitat, stops: [stop], constraints: { oxygenMin: 100000, reservePct: 0, maxSlopeDeg: limit } } });
  if (out?.type !== 'route') throw new Error(`no route: ${JSON.stringify(out)}`);
  return out.result;
}

describe('max slope limit (job 2)', () => {
  it('slopeGrid sees the ridge at about the ramp angle', () => {
    const s = slopeGrid(meta, elevation);
    expect(s[5 * W + 14]).toBeCloseTo(RAMP_DEG, 0);
    expect(s[25 * W + 14]).toBe(0);
  });

  it('limitCost blocks only cells over the limit and keeps the habitat open', () => {
    const s = new Float32Array(W * H).fill(30);
    const c = limitCost(meta, cost, s, 20);
    expect(c[0]).toBe(Infinity);
    expect(c[meta.habitat.y * W + meta.habitat.x]).toBe(1);
  });

  it('25° (the baked limit) gives the same route as before', () => {
    expect(routeAt(25).path).toEqual(routeAt(25, false).path);
  });

  it('dropping the limit below the ramp detours around it', () => {
    const d25 = routeAt(25);
    const d20 = routeAt(20);
    const d15 = routeAt(15);
    console.log(`distance at 25°: ${d25.distanceM.toFixed(0)} m, 20°: ${d20.distanceM.toFixed(0)} m, 15°: ${d15.distanceM.toFixed(0)} m`);
    const slope = slopeGrid(meta, elevation);
    expect(d15.distanceM).toBeGreaterThan(d25.distanceM);
    for (const c of d15.path) expect(slope[c.y * W + c.x]!).toBeLessThanOrEqual(15);
    expect(d15.path.some((c) => c.y >= 22)).toBe(true);
  });
});
