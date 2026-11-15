import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DATA_FILES } from '../src/contracts.ts';
import type { GridMeta } from '../src/contracts.ts';
import { JEZERO_BOUNDS, parseSites } from '../src/data/sites.ts';
import {
  VERTICAL_EXAGGERATION,
  cellToLonLat,
  displayHeight,
  elevationAt,
  minElevation,
} from '../src/view3d/geo.ts';
import { buildTerrainMesh, meshStride, sampleCoords } from '../src/view3d/mesh.ts';

const PUBLIC = join(import.meta.dirname, '..', 'public');

describe('view3d geo (M33)', () => {
  const meta = { width: 100, height: 50 };
  const bounds = JEZERO_BOUNDS;

  it('maps the NW cell towards maxLat / minLon and the SE towards minLat / maxLon', () => {
    const nw = cellToLonLat({ x: 0, y: 0 }, meta, bounds);
    const se = cellToLonLat({ x: 99, y: 49 }, meta, bounds);
    expect(nw.lat).toBeGreaterThan(se.lat);
    expect(nw.lon).toBeLessThan(se.lon);
    expect(nw.lon).toBeGreaterThan(bounds.minLon);
    expect(nw.lon).toBeLessThan(bounds.maxLon);
    expect(se.lat).toBeGreaterThan(bounds.minLat);
    expect(se.lat).toBeLessThan(bounds.maxLat);
  });

  it('lifts the local minimum to ellipsoid height 0 and exaggerates relief', () => {
    expect(displayHeight(-2500, -2560)).toBe(60 * VERTICAL_EXAGGERATION);
    expect(displayHeight(-2560, -2560)).toBe(0);
  });

  it('samples elevation bilinearly', () => {
    const elevation = new Float32Array([0, 10, 20, 30]);
    const m = { width: 2, height: 2 };
    expect(elevationAt(elevation, m, 0, 0)).toBe(0);
    expect(elevationAt(elevation, m, 0.5, 0.5)).toBe(15);
    expect(minElevation(elevation)).toBe(0);
  });
});

describe('view3d mesh (M33)', () => {
  it('picks a stride that keeps each axis under the cap and always includes the far edge', () => {
    expect(meshStride(600, 200)).toBe(4);
    expect(sampleCoords(10, 3)).toEqual([0.5, 3.5, 6.5, 9.5]);
  });

  it('builds a textured mesh from the Jezero elevation grid', () => {
    const dir = join(PUBLIC, 'data', 'jezero');
    const meta = JSON.parse(readFileSync(join(dir, DATA_FILES.meta), 'utf8')) as GridMeta;
    const buf = readFileSync(join(dir, DATA_FILES.elevation));
    const elev = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

    const sites = parseSites(JSON.parse(readFileSync(join(PUBLIC, 'data', 'sites.json'), 'utf8')));
    const bounds = sites.find((s) => s.id === 'jezero')!.bounds;

    const mesh = buildTerrainMesh(elev, meta, bounds, { maxAxis: 50 });
    expect(mesh.cols).toBeLessThanOrEqual(50);
    expect(mesh.rows).toBeLessThanOrEqual(50);
    expect(mesh.lon.length).toBe(mesh.cols * mesh.rows);
    expect(mesh.indices.length).toBe((mesh.cols - 1) * (mesh.rows - 1) * 6);
    expect(mesh.u[0]).toBe(0);
    expect(mesh.v[0]).toBe(0);
    expect(mesh.u[mesh.cols - 1]).toBe(1);

    const hab = cellToLonLat(meta.habitat, meta, bounds);
    expect(hab.lon).toBeGreaterThan(bounds.minLon);
    expect(hab.lon).toBeLessThan(bounds.maxLon);
    expect(hab.lat).toBeGreaterThan(bounds.minLat);
    expect(hab.lat).toBeLessThan(bounds.maxLat);

    for (let i = 0; i < mesh.lon.length; i++) {
      expect(mesh.lon[i]!).toBeGreaterThanOrEqual(bounds.minLon);
      expect(mesh.lon[i]!).toBeLessThanOrEqual(bounds.maxLon);
      expect(mesh.lat[i]!).toBeGreaterThanOrEqual(bounds.minLat);
      expect(mesh.lat[i]!).toBeLessThanOrEqual(bounds.maxLat);
    }
  });
});
