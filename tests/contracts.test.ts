import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_FILES, START_ID } from '../src/contracts.ts';
import type { GridMeta, RouteRequest, Stop } from '../src/contracts.ts';
import { parseGrid } from '../src/data/grid.ts';
import { checkAlerts } from '../src/engine/alerts.ts';
import { lineCells, mockRing, mockRoute } from '../src/engine/mockRouter.ts';
import { handleMessage } from '../src/engine/worker.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const buf = (f: string) => {
  const b = readFileSync(join(FIX, f));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const meta = JSON.parse(readFileSync(join(FIX, DATA_FILES.meta), 'utf8')) as GridMeta;
const stops = JSON.parse(readFileSync(join(FIX, DATA_FILES.stops), 'utf8')) as Stop[];
const grid = parseGrid(
  { meta, stops, cost: buf(DATA_FILES.cost), elevation: buf(DATA_FILES.elevation), sand: buf(DATA_FILES.sand) },
  'fixtures/basemap.png',
);
const constraints = { oxygenMin: 480, reservePct: 20, maxSlopeDeg: 25 };

describe('fixtures', () => {
  it('match meta and the file formats', () => {
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(100);
    expect(grid.cost).toHaveLength(10_000);
    expect(grid.elevation).toHaveLength(10_000);
    expect(grid.sand).toHaveLength(10_000);
    expect(grid.cost.some((c) => c === Infinity)).toBe(true);
    expect([...grid.sand].every((v) => v === 0 || v === 1)).toBe(true);
  });

  it('have 4 stops on passable cells with photos', () => {
    expect(stops).toHaveLength(4);
    for (const s of stops) {
      expect(Number.isFinite(grid.cost[s.cell.y * meta.width + s.cell.x])).toBe(true);
      expect([1, 2, 3]).toContain(s.scienceValue);
      expect(readFileSync(join(FIX, s.photo)).subarray(1, 4).toString()).toBe('PNG');
    }
  });

  it('parseGrid rejects a wrong-sized file', () => {
    expect(() => parseGrid({ ...grid, cost: new ArrayBuffer(8), elevation: buf(DATA_FILES.elevation), sand: buf(DATA_FILES.sand) }, '')).toThrow(/cost/);
  });
});

describe('mockRoute', () => {
  const req: RouteRequest = { start: meta.habitat, stops, constraints };
  const r = mockRoute(req, meta);

  it('starts and ends at start, with one leg per hop', () => {
    expect(r.path[0]).toEqual(meta.habitat);
    expect(r.path.at(-1)).toEqual(meta.habitat);
    expect(r.legs.map((l) => [l.fromId, l.toId])).toEqual([
      [START_ID, 'stop-a'],
      ['stop-a', 'stop-b'],
      ['stop-b', 'stop-c'],
      ['stop-c', 'stop-d'],
      ['stop-d', START_ID],
    ]);
  });

  it('legs are contiguous and hit each stop', () => {
    r.legs.forEach((leg, i) => {
      if (i > 0) expect(leg.startIdx).toBe(r.legs[i - 1]!.endIdx);
      const stop = stops.find((s) => s.id === leg.toId);
      if (stop) expect(r.path[leg.endIdx]).toEqual(stop.cell);
    });
    expect(r.legs.at(-1)!.endIdx).toBe(r.path.length - 1);
  });

  it('path steps are 8-connected', () => {
    for (let i = 1; i < r.path.length; i++) {
      const p = r.path[i - 1]!;
      const q = r.path[i]!;
      expect(Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y))).toBe(1);
    }
  });

  it('stats are consistent', () => {
    expect(r.distanceM).toBeGreaterThan(0);
    expect(r.timeMin).toBeCloseTo(r.distanceM / 50);
    expect(r.oxygenUsedMin).toBeCloseTo(r.timeMin);
    expect(r.energyKJ).toBeCloseTo(r.timeMin * 18);
    expect(r.outOfRangeIds).toEqual([]);
  });

  it('flags stops beyond the oxygen budget', () => {
    // stop-a is ~2.6 min each way; 10 min with a 20% reserve leaves 8 usable.
    const ok = mockRoute({ ...req, stops: [stops[0]!], constraints: { ...constraints, oxygenMin: 10 } }, meta);
    expect(ok.outOfRangeIds).toEqual([]);
    const tight = mockRoute({ ...req, constraints: { ...constraints, oxygenMin: 5 } }, meta);
    expect(tight.outOfRangeIds).toEqual(stops.map((s) => s.id));
  });

  it('handles no stops', () => {
    const empty = mockRoute({ ...req, stops: [] }, meta);
    expect(empty.path).toEqual([meta.habitat]);
    expect(empty.distanceM).toBe(0);
  });
});

describe('lineCells / mockRing', () => {
  it('lineCells includes both ends', () => {
    expect(lineCells({ x: 0, y: 0 }, { x: 3, y: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
  });

  it('mockRing stays in the grid', () => {
    const ring = mockRing(meta.habitat, 60, meta);
    expect(ring.polygon.length).toBeGreaterThan(8);
    for (const c of ring.polygon) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(meta.height - 1);
    }
  });
});

describe('worker protocol', () => {
  it('errors before init, routes after', () => {
    const before = handleMessage(null, { type: 'ring', oxygenLeftMin: 60 });
    expect(before.out?.type).toBe('error');

    const { state } = handleMessage(null, { type: 'init', meta, cost: grid.cost });
    expect(state).not.toBeNull();

    const route = handleMessage(state, { type: 'route', req: { start: meta.habitat, stops, constraints } });
    expect(route.out?.type).toBe('route');

    const replan = handleMessage(state, { type: 'replan', from: { x: 40, y: 22 }, stops: stops.slice(1), constraints, oxygenLeftMin: 200 });
    expect(replan.out?.type === 'route' && replan.out.result.path[0]).toEqual({ x: 40, y: 22 });

    expect(handleMessage(state, { type: 'ring', oxygenLeftMin: 60 }).out?.type).toBe('ring');
  });

  it('rejects a cost array of the wrong size', () => {
    expect(handleMessage(null, { type: 'init', meta, cost: new Float32Array(5) }).out?.type).toBe('error');
  });
});

describe('checkAlerts', () => {
  it('has the agreed signature (stub until M26)', () => {
    const r = mockRoute({ start: meta.habitat, stops, constraints }, meta);
    expect(checkAlerts(meta.habitat, r, constraints, 300)).toEqual([]);
  });
});
