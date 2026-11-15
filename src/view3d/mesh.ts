/**
 * Build a textured terrain mesh from `elevation.bin` (M33).
 *
 * Output is lon/lat/height samples plus UVs and triangle indices — Cesium (or
 * anything else) turns those into Cartesian positions on the Mars ellipsoid.
 * Large grids are downsampled so a 600×600 site stays interactive.
 */
import type { GridMeta } from '../contracts.ts';
import {
  VERTICAL_EXAGGERATION,
  cellToLonLat,
  displayHeight,
  minElevation,
} from './geo.ts';
import type { SiteBounds } from './geo.ts';

/** Cap on samples per axis (600 → ~200 with the default). */
export const MAX_MESH_AXIS = 200;

export interface TerrainMesh {
  /** Sample count along x (west→east). */
  cols: number;
  /** Sample count along y (north→south). */
  rows: number;
  /** Lon degrees, length cols*rows, row-major. */
  lon: Float64Array;
  /** Lat degrees, length cols*rows, row-major. */
  lat: Float64Array;
  /** Height above ellipsoid (m), with vertical exaggeration applied. */
  height: Float64Array;
  /** Texture U in [0,1], west→east. */
  u: Float32Array;
  /** Texture V in [0,1], north→south (V=0 at north / image top). */
  v: Float32Array;
  /** Triangle indices into the sample arrays (CCW when viewed from above). */
  indices: Uint32Array;
  minElevM: number;
  exaggerate: number;
}

/** Stride so each axis has at most `maxAxis` samples (always includes the far edge). */
export function meshStride(size: number, maxAxis = MAX_MESH_AXIS): number {
  if (size <= 1) return 1;
  return Math.max(1, Math.ceil((size - 1) / (maxAxis - 1)));
}

/** Grid of sample coordinates (cell centres) for one axis. */
export function sampleCoords(size: number, stride: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < size; i += stride) out.push(i + 0.5);
  const last = size - 0.5;
  if (out.length === 0 || out[out.length - 1]! !== last) out.push(last);
  return out;
}

/**
 * Build the mesh. `elevation` is row-major Float32, same layout as `elevation.bin`.
 */
export function buildTerrainMesh(
  elevation: Float32Array,
  meta: Pick<GridMeta, 'width' | 'height'>,
  bounds: SiteBounds,
  opts: { maxAxis?: number; exaggerate?: number } = {},
): TerrainMesh {
  const { width, height } = meta;
  const n = width * height;
  if (elevation.length !== n) throw new Error(`elevation has ${elevation.length} cells, meta says ${n}`);

  const maxAxis = opts.maxAxis ?? MAX_MESH_AXIS;
  const exaggerate = opts.exaggerate ?? VERTICAL_EXAGGERATION;
  const minElevM = minElevation(elevation);

  const xs = sampleCoords(width, meshStride(width, maxAxis));
  const ys = sampleCoords(height, meshStride(height, maxAxis));
  const cols = xs.length;
  const rows = ys.length;
  const count = cols * rows;

  const lon = new Float64Array(count);
  const lat = new Float64Array(count);
  const heightA = new Float64Array(count);
  const u = new Float32Array(count);
  const v = new Float32Array(count);

  for (let row = 0; row < rows; row++) {
    const y = ys[row]!;
    for (let col = 0; col < cols; col++) {
      const x = xs[col]!;
      const i = row * cols + col;
      const ll = cellToLonLat({ x, y }, meta, bounds);
      lon[i] = ll.lon;
      lat[i] = ll.lat;
      // Nearest whole cell for the height sample (centres land on integers + 0.5).
      const cx = Math.min(Math.max(Math.floor(x), 0), width - 1);
      const cy = Math.min(Math.max(Math.floor(y), 0), height - 1);
      const elev = elevation[cy * width + cx]!;
      heightA[i] = displayHeight(Number.isFinite(elev) ? elev : minElevM, minElevM, exaggerate);
      u[i] = col / Math.max(1, cols - 1);
      v[i] = row / Math.max(1, rows - 1);
    }
  }

  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const a = row * cols + col;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // CCW from above: a-c-b and b-c-d (y grows south, so c is "down").
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  return { cols, rows, lon, lat, height: heightA, u, v, indices, minElevM, exaggerate };
}
