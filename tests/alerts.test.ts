import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { START_ID } from '../src/contracts.ts';
import type { Constraints, GridMeta, RouteResult, Stop } from '../src/contracts.ts';
import { checkAlerts } from '../src/engine/alerts.ts';
import { OFF_ROUTE_CRITICAL_M, OFF_ROUTE_WARN_M, OXYGEN_MARGIN_WARN_MIN, SLOPE_WARN_MARGIN_DEG } from '../src/engine/model.ts';
import { replanRoute } from '../src/engine/replan.ts';
import { AStar } from '../src/engine/astar.ts';
import { slopeDegAt } from '../src/engine/terrain.ts';
import type { Terrain } from '../src/engine/terrain.ts';
import { handleMessage } from '../src/engine/worker.ts';

// East along row 10 for 100 cells of 5 m and back: 1000 m, 20 min, 20 oxygen-minutes.
const path = [...Array.from({ length: 101 }, (_, x) => ({ x, y: 10 })), ...Array.from({ length: 100 }, (_, i) => ({ x: 99 - i, y: 10 }))];
const route: RouteResult = {
  path,
  legs: [
    { fromId: START_ID, toId: 'a', startIdx: 0, endIdx: 100 },
    { fromId: 'a', toId: START_ID, startIdx: 100, endIdx: 200 },
  ],
  distanceM: 1000,
  timeMin: 20,
  energyKJ: 360,
  oxygenUsedMin: 20,
  outOfRangeIds: [],
};
/** 100 min supply, 20 min reserve, 25° limit. */
const constraints: Constraints = { oxygenMin: 100, reservePct: 20, maxSlopeDeg: 25 };
const kinds = (a: ReturnType<typeof checkAlerts>) => a.map((x) => `${x.kind}:${x.severity}`);

/** A plane rising `deg` degrees towards the east. */
function plane(deg: number, width = 40, height = 40, cellSizeM = 5): Terrain {
  const elevation = new Float32Array(width * height);
  const rise = Math.tan((deg * Math.PI) / 180) * cellSizeM;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) elevation[y * width + x] = x * rise;
  return { meta: { width, height, cellSizeM }, elevation };
}

describe('checkAlerts: nothing to report', () => {
  it('on the route with plenty of oxygen', () => {
    expect(checkAlerts({ x: 30, y: 10 }, route, constraints, 100)).toEqual([]);
    expect(checkAlerts({ x: 30.4, y: 10 }, route, constraints, 100, plane(5))).toEqual([]);
  });

  it('ignores a position that is not a number', () => {
    expect(checkAlerts({ x: NaN, y: 10 }, route, constraints, 0)).toEqual([]);
  });
});

describe('off-route', () => {
  const off = (cells: number) => checkAlerts({ x: 30, y: 10 + cells }, route, constraints, 100);

  it('warns past the warning distance and goes critical past the critical one', () => {
    expect(off(OFF_ROUTE_WARN_M / 5)).toEqual([]); // exactly at the threshold: still fine
    expect(kinds(off(OFF_ROUTE_WARN_M / 5 + 1))).toEqual(['off-route:warn']);
    expect(kinds(off(OFF_ROUTE_CRITICAL_M / 5))).toEqual(['off-route:warn']);
    expect(kinds(off(OFF_ROUTE_CRITICAL_M / 5 + 1))).toEqual(['off-route:critical']);
  });

  it('says how far, in metres from the route stats', () => {
    expect(off(6)[0]!.message).toBe('Off route by 30 m. Head back to the line.');
  });
});

describe('slope', () => {
  const at = (deg: number, limit = 25) => checkAlerts({ x: 20, y: 10 }, route, { ...constraints, maxSlopeDeg: limit }, 100, plane(deg));

  it('is skipped without terrain', () => {
    expect(checkAlerts({ x: 20, y: 10 }, route, { ...constraints, maxSlopeDeg: 5 }, 100)).toEqual([]);
  });

  it('warns near the limit and goes critical over it', () => {
    expect(at(25 - SLOPE_WARN_MARGIN_DEG - 1)).toEqual([]);
    expect(kinds(at(25 - SLOPE_WARN_MARGIN_DEG + 0.5))).toEqual(['slope:warn']);
    expect(kinds(at(24.9))).toEqual(['slope:warn']);
    expect(kinds(at(26))).toEqual(['slope:critical']);
    expect(at(26)[0]!.message).toBe('Slope 26° is over your 25° limit.');
  });

  it('uses the crew’s own limit', () => {
    expect(at(12, 25)).toEqual([]);
    expect(kinds(at(12, 10))).toEqual(['slope:critical']);
  });

  it('slopeDegAt reads a plane correctly everywhere, including edges and corners', () => {
    const t = plane(18);
    for (const [x, y] of [[20, 20], [0, 20], [39, 20], [20, 0], [0, 0], [39, 39]] as const) expect(slopeDegAt(t, x, y)).toBeCloseTo(18, 3);
    expect(slopeDegAt(t, -1, 5)).toBeNaN();
    expect(slopeDegAt(t, 5, 40)).toBeNaN();
  });
});

describe('oxygen margin', () => {
  // At x=50 on the way out there are 150 cells = 15 oxygen-minutes ahead; reserve is 20.
  const at = (oxygenLeft: number) => checkAlerts({ x: 50, y: 10 }, route, constraints, oxygenLeft);

  it('warns when finishing would leave a thin margin above the reserve', () => {
    expect(at(20 + 15 + OXYGEN_MARGIN_WARN_MIN)).toEqual([]);
    expect(kinds(at(20 + 15 + OXYGEN_MARGIN_WARN_MIN - 1))).toEqual(['oxygen:warn']);
    expect(at(20 + 15 + 6)[0]!.message).toBe('Oxygen margin is down to 6 min.');
  });

  it('is critical when the route no longer fits, and says replan', () => {
    const a = at(20 + 15 - 4);
    expect(kinds(a)).toEqual(['oxygen:critical']);
    expect(a[0]!.message).toBe('Oxygen is 4 min short for this route. Replan.');
  });

  it('does not urge another replan when the route is already straight home', () => {
    const homeOnly: RouteResult = {
      ...route,
      legs: [{ fromId: 'start', toId: 'start', startIdx: 0, endIdx: route.path.length - 1 }],
    };
    const a = checkAlerts({ x: 50, y: 10 }, homeOnly, constraints, 20 + 15 - 4);
    expect(kinds(a)).toEqual(['oxygen:critical']);
    expect(a[0]!.message).toBe('Oxygen is 4 min short for the walk home. Head back now.');
  });

  it('is critical once into the reserve', () => {
    expect(at(20)[0]).toEqual({ kind: 'oxygen', severity: 'critical', message: 'Into the oxygen reserve: 20 min left. Head home now.' });
  });

  it('where out and home share ground, assumes the longer walk ahead', () => {
    // x=50 is on both legs; reading it as the way out (15 min ahead) is the safe one.
    expect(kinds(at(20 + 5 + OXYGEN_MARGIN_WARN_MIN))).toEqual(['oxygen:warn']);
  });

  it('counts the walk back to the line when off route', () => {
    const onLine = checkAlerts({ x: 50, y: 10 }, route, constraints, 20 + 15 + 0.5);
    const offLine = checkAlerts({ x: 50, y: 20 }, route, constraints, 20 + 15 + 0.5); // 10 cells = 1 min back
    expect(kinds(onLine)).toEqual(['oxygen:warn']);
    expect(kinds(offLine)).toEqual(['oxygen:critical', 'off-route:critical']);
  });
});

describe('several at once', () => {
  it('one alert per kind, critical first', () => {
    const a = checkAlerts({ x: 20, y: 14 }, route, { ...constraints, maxSlopeDeg: 10 }, 20 + 18 + 5, plane(12));
    expect(kinds(a)).toEqual(['slope:critical', 'oxygen:warn', 'off-route:warn']);
  });
});

describe('on real routes', () => {
  const PUBLIC = join(import.meta.dirname, '..', 'public', 'data', 'jezero');
  const meta = JSON.parse(readFileSync(join(PUBLIC, 'meta.json'), 'utf8')) as GridMeta;
  const stops = JSON.parse(readFileSync(join(PUBLIC, 'stops.json'), 'utf8')) as Stop[];
  const bin = (f: string) => {
    const b = readFileSync(join(PUBLIC, f));
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  const cost = bin('cost.bin');
  const terrain: Terrain = { meta, elevation: bin('elevation.bin') };
  const full: Constraints = { oxygenMin: 480, reservePct: 20, maxSlopeDeg: meta.maxSlopeDeg };
  const { state } = handleMessage(null, { type: 'init', meta, cost });
  const planned = (() => {
    const out = handleMessage(state, { type: 'route', req: { start: meta.habitat, stops, constraints: full } }).out;
    if (out?.type !== 'route') throw new Error('no route');
    return out.result;
  })();

  it('a well-supplied walk along the planned Jezero route raises no oxygen or off-route alerts', () => {
    for (let i = 0; i < planned.path.length; i += 7) {
      const left = 480 - (i / (planned.path.length - 1)) * planned.oxygenUsedMin;
      const a = checkAlerts(planned.path[i]!, planned, full, left, terrain);
      expect(a.filter((x) => x.kind !== 'slope')).toEqual([]);
    }
  });

  it('runtime slope agrees with the grid: the route never stands on ground over the grid limit', () => {
    let steepest = 0;
    for (const c of planned.path) steepest = Math.max(steepest, slopeDegAt(terrain, c.x, c.y));
    expect(steepest).toBeLessThanOrEqual(meta.maxSlopeDeg + 0.5);
    expect(steepest).toBeGreaterThan(5); // the delta front is a real climb
  });

  it('a stricter crew limit flags the steep parts of the same route', () => {
    const strict = { ...full, maxSlopeDeg: 10 };
    const flagged = planned.path.filter((c) => checkAlerts(c, planned, strict, 480, terrain).some((a) => a.kind === 'slope' && a.severity === 'critical'));
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.length).toBeLessThan(planned.path.length);
  });

  it('a short supply goes critical mid-walk, and a replan clears it', () => {
    const short: Constraints = { ...full, oxygenMin: 150 }; // 30 min reserve; the route needs ~121
    const mid = planned.legs[0]!.endIdx; // at Wildcat Ridge
    const left = 150 - (mid / (planned.path.length - 1)) * planned.oxygenUsedMin - 25; // 25 min lost somewhere
    const before = checkAlerts(planned.path[mid]!, planned, short, left, terrain);
    expect(before.find((a) => a.kind === 'oxygen')).toMatchObject({ severity: 'critical' });
    expect(before.find((a) => a.kind === 'oxygen')!.message).toMatch(/short for this route\. Replan\.$/);

    const replanned = replanRoute(new AStar(meta, cost), { from: planned.path[mid]!, stops: stops.slice(1), constraints: short, oxygenLeftMin: left }, meta);
    expect(replanned.outOfRangeIds.length).toBeGreaterThan(0);
    const after = checkAlerts(planned.path[mid]!, replanned, short, left, terrain);
    expect(after.filter((a) => a.kind === 'oxygen' && a.severity === 'critical')).toEqual([]);
    expect(after.filter((a) => a.kind === 'off-route')).toEqual([]);
  });

  it('is fast enough to run every frame', () => {
    const t = performance.now();
    for (let i = 0; i < 200; i++) checkAlerts(planned.path[(i * 13) % planned.path.length]!, planned, full, 300, terrain);
    expect((performance.now() - t) / 200).toBeLessThan(2); // ms per call
  });
});
