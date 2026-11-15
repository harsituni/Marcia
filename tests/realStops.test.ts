import { existsSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Stop } from '../src/contracts.ts';

const ROOT = join(import.meta.dirname, '..');
const DATA = join(ROOT, 'public', 'data', 'jezero');
const stops = JSON.parse(readFileSync(join(DATA, 'stops.json'), 'utf8')) as Stop[];
const site = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', 'jezero', 'site.json'), 'utf8')) as {
  sizeM: { width: number; height: number };
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number };
  habitat: { lon: number; lat: number };
};

// Real grid (M06/M16): the site at 5 m cells.
const CELL_M = 5;
const W = site.sizeM.width / CELL_M;
const H = site.sizeM.height / CELL_M;

describe('public/data/jezero/stops.json (M21)', () => {
  it('has 3–5 stops with unique ids', () => {
    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(stops.length).toBeLessThanOrEqual(5);
    expect(new Set(stops.map((s) => s.id)).size).toBe(stops.length);
  });

  it('every stop matches the Stop type', () => {
    for (const s of stops) {
      expect(Object.keys(s).sort()).toEqual(['cell', 'geologyUnit', 'goal', 'id', 'minerals', 'name', 'photo', 'scienceValue']);
      expect(typeof s.id).toBe('string');
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.goal.length).toBeGreaterThan(0);
      expect(s.geologyUnit.length).toBeGreaterThan(0);
      expect(Array.isArray(s.minerals) && s.minerals.length > 0 && s.minerals.every((m) => typeof m === 'string')).toBe(true);
      expect([1, 2, 3]).toContain(s.scienceValue);
      expect(Number.isInteger(s.cell.x) && Number.isInteger(s.cell.y)).toBe(true);
    }
  });

  it('cells are inside the 600 × 600 site grid', () => {
    expect([W, H]).toEqual([600, 600]);
    for (const s of stops) {
      expect(s.cell.x).toBeGreaterThanOrEqual(0);
      expect(s.cell.y).toBeGreaterThanOrEqual(0);
      expect(s.cell.x).toBeLessThan(W);
      expect(s.cell.y).toBeLessThan(H);
    }
  });

  it('no stop sits on the habitat', () => {
    const b = site.bounds;
    const hx = Math.floor(((site.habitat.lon - b.minLon) / (b.maxLon - b.minLon)) * W);
    const hy = Math.floor(((b.maxLat - site.habitat.lat) / (b.maxLat - b.minLat)) * H);
    for (const s of stops) expect(Math.hypot(s.cell.x - hx, s.cell.y - hy)).toBeGreaterThan(10);
  });

  it('every photo is a JPEG in public/data/photos', () => {
    for (const s of stops) {
      const file = normalize(join(DATA, s.photo));
      expect(file.startsWith(join(ROOT, 'public', 'data', 'photos'))).toBe(true);
      expect(existsSync(file)).toBe(true);
      const head = readFileSync(file).subarray(0, 3);
      expect([...head]).toEqual([0xff, 0xd8, 0xff]);
    }
  });
});
