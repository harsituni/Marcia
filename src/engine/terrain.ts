import type { GridMeta } from '../contracts.ts';

/** What the slope check needs from the loaded grid (`GridData` fits as is). */
export interface Terrain {
  meta: Pick<GridMeta, 'width' | 'height' | 'cellSizeM'>;
  /** `elevation.bin`: Float32, row-major, metres. */
  elevation: Float32Array;
}

/**
 * Ground slope at one cell, in degrees: Horn's 3×3 method, the same one the
 * slope raster behind `cost.bin` uses (`scripts/compute-slope.ts`). A
 * neighbour outside the grid is extrapolated as 2·edge − inner, so a plane has
 * the same slope at the edges. NaN if the cell is off the grid or any value
 * in its window isn't finite.
 */
export function slopeDegAt(terrain: Terrain, x: number, y: number): number {
  const { width, height, cellSizeM } = terrain.meta;
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (!(cx >= 0 && cy >= 0 && cx < width && cy < height)) return NaN;
  const raw = (px: number, py: number) => terrain.elevation[py * width + px]!;
  const clampX = (px: number) => Math.min(width - 1, Math.max(0, px));
  const clampY = (py: number) => Math.min(height - 1, Math.max(0, py));
  const z = (px: number, py: number): number => {
    const qx = clampX(px);
    const qy = clampY(py);
    // Outside by one cell: mirror the inner neighbour through the edge.
    return 2 * raw(qx, qy) - raw(clampX(2 * qx - px), clampY(2 * qy - py));
  };
  const a = z(cx - 1, cy - 1);
  const b = z(cx, cy - 1);
  const c = z(cx + 1, cy - 1);
  const d = z(cx - 1, cy);
  const f = z(cx + 1, cy);
  const g = z(cx - 1, cy + 1);
  const h = z(cx, cy + 1);
  const i = z(cx + 1, cy + 1);
  const k = 1 / (8 * cellSizeM);
  const dzdx = (c + 2 * f + i - (a + 2 * d + g)) * k;
  const dzdy = (g + 2 * h + i - (a + 2 * b + c)) * k;
  if (!Number.isFinite(dzdx) || !Number.isFinite(dzdy) || !Number.isFinite(raw(cx, cy))) return NaN;
  return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
}
