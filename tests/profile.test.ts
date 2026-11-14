import { describe, expect, it } from 'vitest';
import { START_ID } from '../src/contracts.ts';
import type { RouteResult } from '../src/contracts.ts';
import { elevationProfile, formatDistance, formatDuration, indexAtDistance } from '../src/plan/profile.ts';

// 4×1 grid, 10 m cells, elevations 0, 5, 3, 8.
const meta = { width: 4, cellSizeM: 10 };
const elevation = new Float32Array([0, 5, 3, 8]);
const route: Pick<RouteResult, 'path' | 'legs'> = {
  path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }],
  legs: [
    { fromId: START_ID, toId: 'a', startIdx: 0, endIdx: 2 },
    { fromId: 'a', toId: 'b', startIdx: 2, endIdx: 3 },
    { fromId: 'b', toId: START_ID, startIdx: 3, endIdx: 6 },
  ],
};

describe('elevationProfile', () => {
  const p = elevationProfile(route, elevation, meta);

  it('samples elevation.bin along the path with cumulative distance', () => {
    expect(p.elevM).toEqual([0, 5, 3, 8, 3, 5, 0]);
    expect(p.distM).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(p.minM).toBe(0);
    expect(p.maxM).toBe(8);
  });

  it('totals climb and descent', () => {
    expect(p.ascentM).toBe(5 + 5 + 2);
    expect(p.descentM).toBe(2 + 5 + 5);
  });

  it('places stops and the start of the way home', () => {
    expect(p.stops).toEqual([
      { id: 'a', n: 1, distM: 20 },
      { id: 'b', n: 2, distM: 30 },
    ]);
    expect(p.homeStartM).toBe(30);
  });

  it('numbers stops by planned order when the engine skips one', () => {
    const q = elevationProfile(route, elevation, meta, ['a', 'skipped', 'b']);
    expect(q.stops.map((s) => s.n)).toEqual([1, 3]);
  });

  it('counts diagonal steps as √2 cells', () => {
    const q = elevationProfile({ path: [{ x: 0, y: 0 }, { x: 1, y: 1 }], legs: [] }, new Float32Array(4), { width: 2, cellSizeM: 10 });
    expect(q.distM[1]).toBeCloseTo(10 * Math.SQRT2);
    expect(q.homeStartM).toBeNull();
  });
});

describe('helpers', () => {
  it('indexAtDistance finds the nearest sample', () => {
    const d = [0, 10, 20, 30];
    expect(indexAtDistance(d, 0)).toBe(0);
    expect(indexAtDistance(d, 14)).toBe(1);
    expect(indexAtDistance(d, 16)).toBe(2);
    expect(indexAtDistance(d, 99)).toBe(3);
  });

  it('formats distance and time', () => {
    expect(formatDistance(850.4)).toBe('850 m');
    expect(formatDistance(1110.6)).toBe('1.11 km');
    expect(formatDuration(22.2)).toBe('22 min');
    expect(formatDuration(125)).toBe('2 h 05 min');
  });
});
