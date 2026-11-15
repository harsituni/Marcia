/**
 * Grid ↔ lon/lat for the 3D view (M33).
 *
 * Sites are small eqc boxes (`data/sites/<id>/site.json`). Grid cell (0,0) is
 * the NW corner: x grows east, y grows south. Lon/lat are planetocentric
 * degrees (east-positive), same as the site files.
 */
import type { Cell, GridMeta } from '../contracts.ts';

/** Lon/lat box of one EVA site (degrees). */
export interface SiteBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/** IAU Mars 2000 mean radius, metres (matches site.json). */
export const MARS_RADIUS_M = 3_396_190;

/** How much to stretch relief in the mesh so a ~100 m scarp reads in a 3 km box. */
export const VERTICAL_EXAGGERATION = 3;

/** Lon/lat (and absolute elevation) of a grid cell centre. */
export function cellToLonLat(
  cell: Cell,
  meta: Pick<GridMeta, 'width' | 'height'>,
  bounds: SiteBounds,
): { lon: number; lat: number } {
  const fx = (cell.x + 0.5) / meta.width;
  const fy = (cell.y + 0.5) / meta.height;
  return {
    lon: bounds.minLon + fx * (bounds.maxLon - bounds.minLon),
    lat: bounds.maxLat - fy * (bounds.maxLat - bounds.minLat),
  };
}

/** Elevation at a (possibly fractional) cell, bilinear when off-integer. */
export function elevationAt(
  elevation: Float32Array,
  meta: Pick<GridMeta, 'width' | 'height'>,
  x: number,
  y: number,
): number {
  const { width, height } = meta;
  const x0 = Math.min(Math.max(Math.floor(x), 0), width - 1);
  const y0 = Math.min(Math.max(Math.floor(y), 0), height - 1);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = Math.min(Math.max(x - x0, 0), 1);
  const ty = Math.min(Math.max(y - y0, 0), 1);
  const z00 = elevation[y0 * width + x0]!;
  const z10 = elevation[y0 * width + x1]!;
  const z01 = elevation[y1 * width + x0]!;
  const z11 = elevation[y1 * width + x1]!;
  const z0 = z00 + (z10 - z00) * tx;
  const z1 = z01 + (z11 - z01) * tx;
  return z0 + (z1 - z0) * ty;
}

/** Height above the ellipsoid for the mesh: local min + exaggerated relief. */
export function displayHeight(elevM: number, minElevM: number, exaggerate = VERTICAL_EXAGGERATION): number {
  return minElevM + (elevM - minElevM) * exaggerate;
}

/** Finite min of an elevation grid (or 0 if empty). */
export function minElevation(elevation: Float32Array): number {
  let min = Infinity;
  for (let i = 0; i < elevation.length; i++) {
    const v = elevation[i]!;
    if (Number.isFinite(v) && v < min) min = v;
  }
  return Number.isFinite(min) ? min : 0;
}
