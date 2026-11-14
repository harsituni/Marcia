/**
 * M16: export the real grid files in the M01 formats.
 *
 *   data/raw/{elev,slope,sand,soft}_5m.tif  →  public/data/{meta.json, cost.bin, elevation.bin, sand.bin}
 *
 * Run with `npm run export:grid` after `npm run fetch:clip`,
 * `npm run compute:slope` and `npm run compute:sand`. GDAL only reads the
 * rasters; everything else is plain TypeScript.
 *
 * Formats (src/contracts.ts, DATA_FILES / GridMeta): row-major, index =
 * y * width + x, y = 0 is the north row. cost.bin and elevation.bin are
 * Float32 little-endian (Infinity = blocked in cost.bin), sand.bin is Uint8
 * 1/0, meta.json is a GridMeta. `public/data/stops.json` is not touched; the
 * script only reports where each stop lands.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GridMeta, Stop } from '../src/contracts.ts';
import { DATA_FILES } from '../src/contracts.ts';
import { MAX_SLOPE_DEG, SAND_COST_MULT, SOFT_COST_MULT } from '../src/engine/model.ts';
import { findGdal, runOk } from './fetch-clip.ts';
import type { Gdal } from './fetch-clip.ts';

export interface CostConsts {
  maxSlopeDeg: number;
  sandMult: number;
  softMult: number;
}

export const DEFAULT_COST_CONSTS: CostConsts = {
  maxSlopeDeg: MAX_SLOPE_DEG,
  sandMult: SAND_COST_MULT,
  softMult: SOFT_COST_MULT,
};

/**
 * Cost per cell, same formula as the fixture grid (scripts/make-fixtures.ts)
 * plus a soft-ground term:
 *
 *   slope > maxSlopeDeg  →  Infinity (blocked)
 *   otherwise            →  (1 + 3·(slope / maxSlopeDeg)²) × (sand ? sandMult : 1) × (soft && !sand ? softMult : 1)
 *
 * A cell exactly at `maxSlopeDeg` is still walkable. A non-finite slope is
 * treated as blocked.
 */
export function buildCost(
  slope: Float32Array,
  sand: Uint8Array,
  soft: Uint8Array,
  consts: CostConsts = DEFAULT_COST_CONSTS,
): Float32Array {
  const n = slope.length;
  if (sand.length !== n || soft.length !== n) throw new Error(`length mismatch: slope ${n}, sand ${sand.length}, soft ${soft.length}`);
  const out = new Float32Array(n);
  const { maxSlopeDeg, sandMult, softMult } = consts;
  for (let i = 0; i < n; i++) {
    const s = slope[i]!;
    if (!Number.isFinite(s) || s > maxSlopeDeg) {
      out[i] = Infinity;
      continue;
    }
    const isSand = sand[i] === 1;
    const isSoft = soft[i] === 1 && !isSand;
    out[i] = (1 + 3 * (s / maxSlopeDeg) ** 2) * (isSand ? sandMult : 1) * (isSoft ? softMult : 1);
  }
  return out;
}

/** Lon/lat (degrees, east-positive) → grid cell on an eqc grid with `lat_ts`, via its geotransform. */
export function lonLatToCell(lon: number, lat: number, latTsDeg: number, radiusM: number, gt: number[]): { x: number; y: number } {
  const d = Math.PI / 180;
  const ex = radiusM * lon * d * Math.cos(latTsDeg * d);
  const ny = radiusM * lat * d;
  return { x: Math.floor((ex - gt[0]!) / gt[1]!), y: Math.floor((ny - gt[3]!) / gt[5]!) };
}

/** Little-endian bytes of a Float32Array, whatever the machine's byte order. */
function float32LE(a: Float32Array): Buffer {
  const buf = Buffer.alloc(a.length * 4);
  for (let i = 0; i < a.length; i++) buf.writeFloatLE(a[i]!, i * 4);
  return buf;
}

// ---------------------------------------------------------------- CLI

const ROOT = resolve(import.meta.dirname, '..');
const RAW = join(ROOT, 'data', 'raw');
const OUT = join(ROOT, 'public', 'data');
const SITE = join(ROOT, 'data', 'site.json');
const MARS_R = 3396190;

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface Info {
  size: [number, number];
  geoTransform: number[];
  coordinateSystem?: { wkt?: string };
  bands: { type: string; noDataValue?: number }[];
}

async function main(): Promise<void> {
  console.log('==> Checking tools');
  const gdal: Gdal = findGdal();
  console.log((await runOk(gdal, 'gdalinfo', ['--version'])).trim());

  const inputs = {
    elev: { file: join(RAW, 'elev_5m.tif'), type: 'Float32', hint: 'npm run fetch:clip' },
    slope: { file: join(RAW, 'slope_5m.tif'), type: 'Float32', hint: 'npm run compute:slope' },
    sand: { file: join(RAW, 'sand_5m.tif'), type: 'Byte', hint: 'npm run compute:sand' },
    soft: { file: join(RAW, 'soft_5m.tif'), type: 'Byte', hint: 'npm run compute:sand' },
  } as const;
  for (const { file, hint } of Object.values(inputs)) if (!existsSync(file)) fail(`${file} not found. Run \`${hint}\` first.`);

  const info = async (p: string) => JSON.parse(await runOk(gdal, 'gdalinfo', ['-json', p])) as Info;
  const elevInfo = await info(inputs.elev.file);
  const [W, H] = elevInfo.size;
  const gt = elevInfo.geoTransform;
  const n = W * H;
  if (!(gt[1]! > 0 && gt[1] === -gt[5]! && gt[2] === 0 && gt[4] === 0)) fail(`grid cells are not square/north-up: [${gt.join(', ')}]`);
  const cellSizeM = gt[1]!;

  console.log('==> Reading rasters');
  const tmp = mkdtempSync(join(tmpdir(), 'marcia-export-'));
  const raw: Record<string, Float32Array | Uint8Array> = {};
  try {
    for (const [name, { file, type }] of Object.entries(inputs)) {
      const i = await info(file);
      if (JSON.stringify(i.size) !== JSON.stringify(elevInfo.size) || JSON.stringify(i.geoTransform) !== JSON.stringify(gt) || i.coordinateSystem?.wkt !== elevInfo.coordinateSystem?.wkt) {
        fail(`${file} is not on the elevation grid (size/geotransform/CRS differ).`);
      }
      const bin = join(tmp, `${name}.bin`);
      await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', type, file, bin]);
      const b = readFileSync(bin);
      const arr = type === 'Float32' ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Uint8Array(b);
      if (arr.length !== n) fail(`${name}: read ${arr.length} values, expected ${n}`);
      const nodata = i.bands[0]?.noDataValue;
      for (let k = 0; k < n; k++) {
        const v = arr[k]!;
        if (Number.isNaN(v) || v === nodata || (type === 'Byte' && v > 1)) fail(`${name}: invalid value ${v} at cell ${k % W},${Math.floor(k / W)}`);
      }
      raw[name] = type === 'Float32' ? Float32Array.from(arr) : Uint8Array.from(arr);
      console.log(`  ${name.padEnd(5)} ${W} x ${H} ${type}, no NaN/nodata`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const elev = raw.elev as Float32Array;
  const slope = raw.slope as Float32Array;
  const sand = raw.sand as Uint8Array;
  const soft = raw.soft as Uint8Array;

  console.log('==> Building cost');
  const cost = buildCost(slope, sand, soft);
  let blocked = 0;
  let sandN = 0;
  let softOnly = 0;
  let cMin = Infinity;
  let cMax = -Infinity;
  for (let k = 0; k < n; k++) {
    const c = cost[k]!;
    if (c === Infinity) blocked++;
    else {
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
    }
    sandN += sand[k]!;
    if (soft[k] && !sand[k]) softOnly++;
  }
  const pct = (x: number) => `${((100 * x) / n).toFixed(2)}%`;
  console.log(`  maxSlopeDeg ${MAX_SLOPE_DEG}, sand ×${SAND_COST_MULT}, soft (off sand) ×${SOFT_COST_MULT}`);
  console.log(`  blocked ${blocked} cells = ${pct(blocked)}; finite cost min ${cMin.toFixed(4)} max ${cMax.toFixed(4)}`);
  console.log(`  sand ${pct(sandN)}, soft-only ${pct(softOnly)}`);

  console.log('==> Habitat');
  const site = JSON.parse(readFileSync(SITE, 'utf8')) as {
    bounds: { minLat: number; maxLat: number };
    habitat: { lon: number; lat: number };
  };
  const latTs = (site.bounds.minLat + site.bounds.maxLat) / 2;
  const habitat = lonLatToCell(site.habitat.lon, site.habitat.lat, latTs, MARS_R, gt);
  if (habitat.x < 0 || habitat.y < 0 || habitat.x >= W || habitat.y >= H) fail(`habitat cell ${habitat.x},${habitat.y} is outside the grid`);
  const habCost = cost[habitat.y * W + habitat.x]!;
  console.log(`  site.json habitat ${site.habitat.lon}E ${site.habitat.lat}N → cell (${habitat.x}, ${habitat.y}), cost ${habCost.toFixed(4)}`);
  if (habCost === Infinity) fail(`habitat cell (${habitat.x}, ${habitat.y}) is blocked (slope ${slope[habitat.y * W + habitat.x]!.toFixed(2)}°). Not moving it; decide in data/site.json.`);

  console.log(`==> Writing ${OUT}`);
  mkdirSync(OUT, { recursive: true });
  const meta: GridMeta = { width: W, height: H, cellSizeM, maxSlopeDeg: MAX_SLOPE_DEG, habitat };
  const files: [string, Buffer | string][] = [
    [DATA_FILES.meta, JSON.stringify(meta, null, 2) + '\n'],
    [DATA_FILES.cost, float32LE(cost)],
    [DATA_FILES.elevation, float32LE(elev)],
    [DATA_FILES.sand, Buffer.from(sand.buffer, sand.byteOffset, sand.byteLength)],
  ];
  for (const [name, data] of files) {
    const p = join(OUT, name);
    writeFileSync(p, data);
    console.log(`  ${name.padEnd(14)} ${statSync(p).size} bytes`);
  }

  console.log('==> Stops in public/data/stops.json (report only, not modified)');
  const stopsPath = join(OUT, DATA_FILES.stops);
  if (!existsSync(stopsPath)) console.log('  (no stops.json)');
  else {
    const stops = JSON.parse(readFileSync(stopsPath, 'utf8')) as Stop[];
    for (const s of stops) {
      const { x, y } = s.cell;
      const inside = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < W && y < H;
      if (!inside) {
        console.log(`  ${s.id.padEnd(14)} cell (${x}, ${y})  OUTSIDE the ${W}x${H} grid`);
        continue;
      }
      const c = cost[y * W + x]!;
      const state = c === Infinity ? `BLOCKED (slope ${slope[y * W + x]!.toFixed(1)}°)` : 'ok';
      console.log(`  ${s.id.padEnd(14)} cell (${x}, ${y})  cost ${c === Infinity ? 'Infinity' : c.toFixed(4)}  ${state}`);
    }
  }
  console.log('==> Done.');
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
