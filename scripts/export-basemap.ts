/**
 * M20: basemap PNG covering exactly the grid.
 *
 *   data/raw/src/PSP_002387_1985_RED_A_01_ORTHO.{LBL,JP2}  →  public/data/basemap.png
 *
 * Run with `npm run export:basemap` after `npm run fetch:clip`. The full-res
 * HiRISE ortho (not the 5 m clip, for sharpness) is warped onto the extent and
 * CRS of data/raw/elev_5m.tif at 1500 × 1500 px (2 m/px; 1200 × 1200 if the
 * PNG would exceed 3 MB), contrast-stretched between its 2nd and 98th
 * percentiles, and written as an 8-bit greyscale PNG. Row 0 of the PNG is the
 * north edge, like the grid (src/contracts.ts).
 *
 * The script fails unless the warped extent matches elev_5m.tif to 0.01 m,
 * the PNG has the requested size, and no row or column is entirely nodata.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_FILES } from '../src/contracts.ts';
import { findGdal, run, runOk } from './fetch-clip.ts';
import type { Gdal } from './fetch-clip.ts';

export interface Extent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Extent of a north-up raster from its GDAL geotransform and size. */
export function extentFromGeoTransform(gt: number[], width: number, height: number): Extent {
  const [x0, dx, rx, y0, ry, dy] = gt as [number, number, number, number, number, number];
  if (rx !== 0 || ry !== 0) throw new Error('rotated geotransforms are not supported');
  const xs = [x0, x0 + width * dx];
  const ys = [y0, y0 + height * dy];
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Largest absolute difference between two extents' edges. */
export function extentDiff(a: Extent, b: Extent): number {
  return Math.max(Math.abs(a.minX - b.minX), Math.abs(a.minY - b.minY), Math.abs(a.maxX - b.maxX), Math.abs(a.maxY - b.maxY));
}

/**
 * The p-th percentile (0–100, nearest rank) of `values`, ignoring `skip`
 * (the nodata value). NaN if nothing is left.
 */
export function percentile(values: ArrayLike<number>, p: number, skip?: number): number {
  const kept: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i] !== skip) kept.push(values[i]!);
  if (kept.length === 0) return NaN;
  kept.sort((a, b) => a - b);
  const k = Math.min(kept.length - 1, Math.max(0, Math.ceil((p / 100) * kept.length) - 1));
  return kept[k]!;
}

// ---------------------------------------------------------------- CLI

const ROOT = resolve(import.meta.dirname, '..');
const ELEV = join(ROOT, 'data', 'raw', 'elev_5m.tif');
const SRC = join(ROOT, 'data', 'raw', 'src');
const ORTHO_CANDIDATES = ['PSP_002387_1985_RED_A_01_ORTHO.LBL', 'PSP_002387_1985_RED_A_01_ORTHO.JP2'].map((f) => join(SRC, f));
const OUT_DIR = join(ROOT, 'public', 'data');
const OUT = join(OUT_DIR, DATA_FILES.basemap);
const MAX_BYTES = 3 * 1024 * 1024;

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface Info {
  size: [number, number];
  geoTransform?: number[];
  coordinateSystem?: { wkt?: string };
  bands: { type: string; noDataValue?: number }[];
}

async function main(): Promise<void> {
  console.log('==> Checking tools');
  const base = findGdal();
  // No .aux.xml sidecars next to the inputs or the PNG.
  const gdal: Gdal = { ...base, env: { ...base.env, GDAL_PAM_ENABLED: 'NO' } };
  console.log((await runOk(gdal, 'gdalinfo', ['--version'])).trim());
  if (!existsSync(ELEV)) fail(`${ELEV} not found. Run \`npm run fetch:clip\` first.`);

  const info = async (p: string) => JSON.parse(await runOk(gdal, 'gdalinfo', ['-json', '-nomd', p])) as Info;
  const elev = await info(ELEV);
  const gt = elev.geoTransform!;
  const [W, H] = elev.size;
  const ext = extentFromGeoTransform(gt, W, H);
  console.log(`  grid ${W} x ${H}, extent X ${ext.minX}..${ext.maxX}  Y ${ext.minY}..${ext.maxY}`);

  // Ortho: prefer the PDS label (it carries the map projection), else the JP2.
  let ortho = '';
  let orthoInfo: Info | null = null;
  for (const c of ORTHO_CANDIDATES) {
    if (!existsSync(c)) continue;
    const r = await run(gdal, 'gdalinfo', ['-json', '-nomd', c]);
    if (r.code !== 0) continue;
    const i = JSON.parse(r.stdout) as Info;
    if (i.coordinateSystem?.wkt) {
      ortho = c;
      orthoInfo = i;
      break;
    }
  }
  if (!orthoInfo) fail('HiRISE ortho not found or has no CRS in data/raw/src. Run `npm run fetch:clip` first.');
  console.log(`  source ${ortho} (${orthoInfo.size.join(' x ')} px)`);

  const tmp = mkdtempSync(join(tmpdir(), 'marcia-basemap-'));
  try {
    const wkt = join(tmp, 'grid.wkt');
    writeFileSync(wkt, elev.coordinateSystem?.wkt ?? '');
    let px = 1500;
    for (;;) {
      console.log(`==> Warping to ${px} x ${px} px (${((ext.maxX - ext.minX) / px).toFixed(2)} m/px)`);
      const warped = join(tmp, `warped_${px}.tif`);
      const srcNodata = orthoInfo.bands[0]?.noDataValue === undefined ? ['-srcnodata', '0'] : [];
      await runOk(gdal, 'gdalwarp', [
        '-q', '-overwrite',
        '-t_srs', wkt,
        '-te', String(ext.minX), String(ext.minY), String(ext.maxX), String(ext.maxY),
        '-ts', String(px), String(px),
        '-r', 'average',
        ...srcNodata, '-dstnodata', '0',
        '-wm', '1024', '-multi', '-wo', 'NUM_THREADS=ALL_CPUS',
        ortho, warped,
      ]);

      const wi = await info(warped);
      const wext = extentFromGeoTransform(wi.geoTransform!, wi.size[0], wi.size[1]);
      const d = extentDiff(ext, wext);
      console.log(`  warped extent X ${wext.minX}..${wext.maxX}  Y ${wext.minY}..${wext.maxY}  (max edge difference ${d.toExponential(2)} m)`);
      if (d > 0.01) fail(`warped extent differs from elev_5m.tif by ${d} m`);
      if (!(wi.geoTransform![5]! < 0)) fail('warped raster is not north-up');
      console.log(`  orientation: y step ${wi.geoTransform![5]} < 0 → row 0 is the north edge (matches the grid in contracts.ts)`);

      // Contrast stretch between the 2nd and 98th percentile of the valid pixels.
      const rawTif = join(tmp, `warped_${px}.bin`);
      await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Float32', warped, rawTif]);
      const rb = readFileSync(rawTif);
      const vals = new Float32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4);
      const p2 = percentile(vals, 2, 0);
      const p98 = percentile(vals, 98, 0);
      if (!(p98 > p2)) fail(`no contrast to stretch (p2 ${p2}, p98 ${p98})`);
      console.log(`  stretch p2 ${p2} → 1, p98 ${p98} → 255 (0 stays nodata)`);

      mkdirSync(OUT_DIR, { recursive: true });
      await runOk(gdal, 'gdal_translate', [
        '-q', '-of', 'PNG', '-ot', 'Byte',
        // -exponent 1 = the same linear stretch, but clipped to [p2, p98]; without it
        // values below p2 extrapolate below 1 and get clamped to 0 (= nodata).
        '-scale', String(p2), String(p98), '1', '255', '-exponent', '1',
        '-co', 'WORLDFILE=NO',
        warped, OUT,
      ]);
      const bytes = statSync(OUT).size;
      if (bytes > MAX_BYTES && px > 1200) {
        console.log(`  ${bytes} bytes > 3 MB, dropping to 1200 x 1200`);
        px = 1200;
        continue;
      }

      console.log('==> Checking the PNG');
      const pi = await info(OUT);
      if (pi.size[0] !== px || pi.size[1] !== px) fail(`PNG is ${pi.size.join(' x ')}, expected ${px} x ${px}`);
      const pngRaw = join(tmp, 'png.bin');
      await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Byte', OUT, pngRaw]);
      const pv = new Uint8Array(readFileSync(pngRaw));
      let zeros = 0;
      const rowZeros = new Uint32Array(px);
      const colZeros = new Uint32Array(px);
      for (let y = 0; y < px; y++) {
        for (let x = 0; x < px; x++) {
          if (pv[y * px + x] === 0) {
            zeros++;
            rowZeros[y]!++;
            colZeros[x]!++;
          }
        }
      }
      const blackRows = rowZeros.filter((z) => z === px).length;
      const blackCols = colZeros.filter((z) => z === px).length;
      console.log(`  ${OUT}`);
      console.log(`  size ${pi.size.join(' x ')} px, ${pi.bands.length} band(s) ${pi.bands[0]?.type}, ${bytes} bytes (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`  pixels == 0: ${((100 * zeros) / pv.length).toFixed(3)}%; all-black rows ${blackRows}, all-black columns ${blackCols}`);
      if (blackRows > 0 || blackCols > 0) fail('the PNG has all-black (nodata) rows or columns; the ortho does not cover the whole grid');
      if (px !== 1500) console.log('  NOTE: exported at 1200 x 1200 to stay under 3 MB');
      break;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log('==> Done.');
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
