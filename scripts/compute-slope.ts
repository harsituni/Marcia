/**
 * M09: slope in degrees on the same grid as the clipped DEM.
 *
 *   data/raw/elev_5m.tif  →  data/raw/slope_5m.tif  (Float32 GeoTIFF, degrees)
 *
 * Run with `npm run compute:slope` after `npm run fetch:clip`. The raster is
 * made by `gdaldem slope -compute_edges`; the grid is eqc in metres, so no
 * `-s` scale is needed. Afterwards the script checks that size, geotransform
 * and CRS match elev_5m.tif exactly and that no cell is nodata.
 *
 * `hornSlopeDeg` is the same maths in plain TypeScript, for unit tests and for
 * any later step (M16) that needs slope without GDAL.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGdal, runOk } from './fetch-clip.ts';
import type { Gdal } from './fetch-clip.ts';

/**
 * Slope in degrees with Horn's 3×3 method, matching `gdaldem slope
 * -compute_edges`. Row-major, `index = y * width + x`. Cells outside the grid
 * are linearly extrapolated from the two nearest rows/columns (2·edge − inner),
 * as GDAL does, so a plane has the same slope at the edges as inside. A cell
 * is NaN if its value or any value in its window is not finite.
 */
export function hornSlopeDeg(elev: Float32Array, width: number, height: number, cellSizeM: number): Float32Array {
  if (elev.length !== width * height) throw new Error(`elev has ${elev.length} cells, expected ${width * height}`);
  const out = new Float32Array(width * height);
  const toDeg = 180 / Math.PI;
  const k = 1 / (8 * cellSizeM);
  const clampX = (x: number) => (x < 0 ? 0 : x >= width ? width - 1 : x);
  const clampY = (y: number) => (y < 0 ? 0 : y >= height ? height - 1 : y);
  const raw = (x: number, y: number) => elev[y * width + x]!;
  // Window value at (x, y), at most one cell outside the grid, following
  // gdaldem's -compute_edges: a missing row/column is extrapolated as
  // 2·edge − inner. On the first and last rows GDAL instead repeats the edge
  // column (so corners extrapolate vertically only). A one-cell-wide axis has
  // no inner cell and repeats the edge.
  let rowEdge = false;
  const at = (x: number, y: number): number => {
    if (rowEdge) x = clampX(x);
    const qx = clampX(x);
    const qy = clampY(y);
    if (qy !== y) {
      const ry = clampY(2 * qy - y);
      return 2 * raw(qx, qy) - raw(qx, ry);
    }
    if (qx !== x) {
      const rx = clampX(2 * qx - x);
      return 2 * raw(qx, qy) - raw(rx, qy);
    }
    return raw(x, y);
  };
  for (let y = 0; y < height; y++) {
    rowEdge = y === 0 || y === height - 1;
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      const z = edge ? at : (cx: number, cy: number) => elev[cy * width + cx]!;
      const a = z(x - 1, y - 1);
      const b = z(x, y - 1);
      const c = z(x + 1, y - 1);
      const d = z(x - 1, y);
      const f = z(x + 1, y);
      const g = z(x - 1, y + 1);
      const h = z(x, y + 1);
      const i = z(x + 1, y + 1);
      const dzdx = (c + 2 * f + i - (a + 2 * d + g)) * k;
      const dzdy = (g + 2 * h + i - (a + 2 * b + c)) * k;
      const finite = Number.isFinite(dzdx) && Number.isFinite(dzdy) && Number.isFinite(elev[y * width + x]!);
      out[y * width + x] = finite ? Math.atan(Math.hypot(dzdx, dzdy)) * toDeg : NaN;
    }
  }
  return out;
}

// ---------------------------------------------------------------- CLI

const ROOT = resolve(import.meta.dirname, '..');
const RAW_DIR = join(ROOT, 'data', 'raw');
const ELEV = join(RAW_DIR, 'elev_5m.tif');
const SLOPE = join(RAW_DIR, 'slope_5m.tif');

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface StatsInfo {
  size: [number, number];
  geoTransform: number[];
  coordinateSystem?: { wkt?: string };
  bands: {
    type: string;
    minimum?: number;
    maximum?: number;
    mean?: number;
    noDataValue?: number;
    metadata?: Record<string, Record<string, string>>;
  }[];
}

async function statsInfo(gdal: Gdal, path: string): Promise<StatsInfo> {
  return JSON.parse(await runOk(gdal, 'gdalinfo', ['-json', '-stats', path])) as StatsInfo;
}

async function main(): Promise<void> {
  console.log('==> Checking tools');
  const gdal = findGdal();
  console.log((await runOk(gdal, 'gdalinfo', ['--version'])).trim());
  if (!existsSync(ELEV)) fail(`${ELEV} not found. Run \`npm run fetch:clip\` first (M06).`);

  console.log(`==> gdaldem slope → ${SLOPE}`);
  await runOk(gdal, 'gdaldem', [
    'slope', ELEV, SLOPE,
    '-compute_edges',
    '-of', 'GTiff',
    '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES',
  ]);

  console.log('==> Checking alignment with elev_5m.tif');
  const elev = await statsInfo(gdal, ELEV);
  const slope = await statsInfo(gdal, SLOPE);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(elev.size, slope.size)) fail(`size differs: elev ${elev.size.join('x')} vs slope ${slope.size.join('x')}`);
  if (!same(elev.geoTransform, slope.geoTransform)) {
    fail(`geotransform differs: elev [${elev.geoTransform.join(', ')}] vs slope [${slope.geoTransform.join(', ')}]`);
  }
  if (elev.coordinateSystem?.wkt !== slope.coordinateSystem?.wkt) fail('CRS differs between elev_5m.tif and slope_5m.tif');
  console.log(`  elev  size ${elev.size.join(' x ')}, geotransform [${elev.geoTransform.join(', ')}]`);
  console.log(`  slope size ${slope.size.join(' x ')}, geotransform [${slope.geoTransform.join(', ')}]`);
  console.log('  size, geotransform and CRS identical');

  const band = slope.bands[0];
  if (!band) fail('slope_5m.tif has no band');
  if (band.type !== 'Float32') fail(`slope_5m.tif is ${band.type}, expected Float32`);
  const valid = Number(band.metadata?.['']?.STATISTICS_VALID_PERCENT);
  if (!(valid === 100)) fail(`slope_5m.tif has nodata cells (${valid}% valid)`);
  const r = (v: number | undefined) => (v === undefined ? '?' : v.toFixed(3));
  console.log(`  slope_5m.tif: Float32, no nodata cells; min ${r(band.minimum)}° max ${r(band.maximum)}° mean ${r(band.mean)}°`);
  console.log('==> Done.');
}

// Run only as a CLI, so tests can import `hornSlopeDeg`.
const isMain =
  (import.meta as { main?: boolean }).main ??
  resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
