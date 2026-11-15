import { describe, expect, it } from 'vitest';
import { START_ID } from '../src/contracts.ts';
import type { RouteResult, Stop } from '../src/contracts.ts';
import { bearingDeg, compassTicks, deriveHud, formatHeading, positionAt, relativeBearing } from '../src/walk/hud.ts';
import type { SpaceWeather } from '../src/engine/spaceWeather.ts';

const stop = (id: string, x: number): Stop => ({ id, name: id.toUpperCase(), cell: { x, y: 0 }, goal: '', geologyUnit: '', minerals: [], photo: '', scienceValue: 1 });

// East along row 0 to x=10, then back west to the start. 10 m cells, 50 m/min.
const path = [...Array.from({ length: 11 }, (_, x) => ({ x, y: 0 })), ...Array.from({ length: 10 }, (_, i) => ({ x: 9 - i, y: 0 }))];
const route: Pick<RouteResult, 'path' | 'legs'> = {
  path,
  legs: [
    { fromId: START_ID, toId: 'a', startIdx: 0, endIdx: 4 },
    { fromId: 'a', toId: 'b', startIdx: 4, endIdx: 10 },
    { fromId: 'b', toId: START_ID, startIdx: 10, endIdx: 20 },
  ],
};
const stops = [stop('a', 4), stop('b', 10)];
const constraints = { oxygenMin: 480, reservePct: 20, maxSlopeDeg: 25 };
const hud = (pathIdx: number, oxygenLeftMin = 480) => deriveHud({ route, stops, constraints, meta: { cellSizeM: 10 }, walk: { pathIdx, oxygenLeftMin } });

describe('bearings', () => {
  it('0 is grid north (up), clockwise', () => {
    const o = { x: 5, y: 5 };
    expect(bearingDeg(o, { x: 5, y: 0 })).toBe(0);
    expect(bearingDeg(o, { x: 9, y: 5 })).toBe(90);
    expect(bearingDeg(o, { x: 5, y: 9 })).toBe(180);
    expect(bearingDeg(o, { x: 0, y: 5 })).toBe(270);
    expect(bearingDeg(o, { x: 8, y: 2 })).toBeCloseTo(45);
  });

  it('relativeBearing wraps to the short way round', () => {
    expect(relativeBearing(10, 350)).toBe(20);
    expect(relativeBearing(350, 10)).toBe(-20);
    expect(relativeBearing(180, 0)).toBe(180);
    expect(relativeBearing(90, 90)).toBe(0);
  });

  it('formats headings as three digits', () => {
    expect(formatHeading(7.4)).toBe('007°');
    expect(formatHeading(359.6)).toBe('000°');
  });
});

describe('compassTicks', () => {
  it('centres on the heading and labels the 45° points', () => {
    const t = compassTicks(90, 120, 15);
    expect(t[0]).toEqual({ deg: 30, offsetDeg: -60, label: null });
    expect(t.at(-1)).toEqual({ deg: 150, offsetDeg: 60, label: null });
    expect(t.filter((x) => x.label).map((x) => x.label)).toEqual(['NE', 'E', 'SE']);
  });

  it('wraps through north', () => {
    const t = compassTicks(350, 120, 15);
    const north = t.find((x) => x.label === 'N')!;
    expect(north).toEqual({ deg: 0, offsetDeg: 10, label: 'N' });
    expect(t.every((x) => x.deg >= 0 && x.deg < 360)).toBe(true);
  });
});

describe('deriveHud', () => {
  it('at the start: heading out, first stop next, full margin', () => {
    const h = hud(0);
    expect(h.position).toEqual({ x: 0, y: 0 });
    expect(h.headingDeg).toBe(90);
    expect(h.next).toMatchObject({ kind: 'stop', n: 1, distanceM: 40, etaMin: 0.8, bearingDeg: 90 });
    expect(h.habitatBearingDeg).toBeNull();
    expect(h.oxygen).toMatchObject({ leftMin: 480, reserveMin: 96, fraction: 1, status: 'ok' });
    expect(h.returnMargin).toMatchObject({ marginMin: 384, homeMin: 0, fraction: 1, status: 'ok' });
  });

  it('standing on a stop, the next one is the target', () => {
    expect(hud(4).next).toMatchObject({ kind: 'stop', n: 2, distanceM: 60 });
  });

  it('between cells: interpolated position, distance and way home', () => {
    const h = hud(6.5);
    expect(positionAt(path, 6.5)).toEqual({ x: 6.5, y: 0 });
    expect(h.position).toEqual({ x: 6.5, y: 0 });
    expect(h.next).toMatchObject({ kind: 'stop', n: 2, distanceM: 35 });
    expect(h.habitatBearingDeg).toBe(270);
    // Home by the shorter of retracing (65 m) or finishing (135 m).
    expect(h.returnMargin.homeMin).toBeCloseTo(65 / 50);
  });

  it('after the last stop: heading home', () => {
    const h = hud(12);
    expect(h.headingDeg).toBe(270);
    expect(h.next).toMatchObject({ kind: 'home', distanceM: 80, bearingDeg: 270 });
    expect(h.returnMargin.homeMin).toBeCloseTo(80 / 50);
  });

  it('at the end: arrived, still pointing the way it came', () => {
    const h = hud(20);
    expect(h.next).toEqual({ kind: 'arrived' });
    expect(h.headingDeg).toBe(270);
    expect(h.habitatBearingDeg).toBeNull();
  });

  it('gauge statuses follow the reserve', () => {
    expect(hud(10, 200).returnMargin.status).toBe('ok');
    expect(hud(10, 120).returnMargin).toMatchObject({ status: 'caution' }); // 120 − 96 − 2 = 22 spare
    expect(hud(10, 120).oxygen.status).toBe('caution');
    expect(hud(10, 97).returnMargin.status).toBe('critical'); // 97 − 96 − 2 < 0
    expect(hud(10, 96).oxygen.status).toBe('critical');
    expect(hud(10, 97).returnMargin.fraction).toBe(0);
  });

  it('clamps an out-of-range path index', () => {
    expect(hud(999).next).toEqual({ kind: 'arrived' });
    expect(hud(-5).position).toEqual({ x: 0, y: 0 });
  });
});

describe('walk phase (UI polish)', () => {
  it('is start at the habitat before the first step, walking on the way, done back at the end', () => {
    expect(hud(0).phase).toBe('start');
    expect(hud(5).phase).toBe('walking');
    expect(hud(path.length - 1).phase).toBe('done');
  });

  it('just short of home on the way back: still walking, but the countdown rounds to 0', () => {
    const near = hud(19.9);
    expect(near.phase).toBe('walking');
    expect(Math.round(near.returnMargin.homeMin)).toBe(0);
    expect(hud(12).phase).toBe('walking');
    expect(Math.round(hud(12).returnMargin.homeMin)).toBeGreaterThan(0);
  });
});

describe('storm limits in the HUD', () => {
  const sw = (status: 'block' | 'tighten'): SpaceWeather => ({ status, reasons: [{ status, text: 'demo', eventId: 'x' }], missing: [], fetchedAt: '2026-11-15T00:00:00Z' });
  const stormHud = (pathIdx: number, oxygenLeftMin: number, status: 'block' | 'tighten' = 'tighten') =>
    deriveHud({ route, stops, constraints, spaceWeather: sw(status), meta: { cellSizeM: 10 }, walk: { pathIdx, oxygenLeftMin } });

  it('the oxygen reserve rises by 10 points', () => {
    expect(hud(0).oxygen.reserveMin).toBe(96); // 20% of 480
    expect(stormHud(0, 480).oxygen).toMatchObject({ reserveMin: 144, status: 'ok' }); // 30% of 480
    expect(stormHud(0, 480, 'block').oxygen.reserveMin).toBe(144);
  });

  it('the Return margin is 75% of the spare above the reserve, minus the walk home', () => {
    // Idx 10 is the turn-round point: 100 m (2 min) from home either way.
    const clear = hud(10, 200).returnMargin.marginMin;
    expect(clear).toBeCloseTo(200 - 96 - 2);
    const storm = stormHud(10, 200).returnMargin.marginMin;
    expect(storm).toBeCloseTo(0.75 * (200 - 144) - 2);
    expect(stormHud(10, 200, 'block').returnMargin.marginMin).toBeCloseTo(storm);
    expect(storm).toBeLessThan(clear);
  });

  it('the start margin in a storm is the ring share of the spare', () => {
    expect(stormHud(0, 480).returnMargin.marginMin).toBeCloseTo(0.75 * (480 - 144));
  });

  it('a clear assessment changes nothing', () => {
    const clear = { ...sw('tighten'), status: 'clear' as const, reasons: [] };
    expect(deriveHud({ route, stops, constraints, spaceWeather: clear, meta: { cellSizeM: 10 }, walk: { pathIdx: 10, oxygenLeftMin: 200 } })).toEqual(hud(10, 200));
  });

  it('a spare already below zero is not shrunk further by the ring share', () => {
    // Left 100 under a 30% reserve (144): spare −44, which the ring share must not make −33.
    expect(stormHud(10, 100).returnMargin.marginMin).toBeCloseTo(-44 - 2);
  });
});
