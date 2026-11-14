/**
 * M12: soft-sand mask from thermal inertia, on the elevation grid.
 *
 *   data/raw/ti_5m.tif  →  data/raw/sand_5m.tif  (Byte GeoTIFF, 1 = sand, 0 = not)
 *
 * Run with `npm run compute:sand` after `npm run fetch:clip` (which resamples
 * the Zenodo Jezero thermal-inertia map onto the elevation grid as ti_5m.tif).
 *
 * The mask itself is computed by `sandMask` below, so the threshold lives in
 * one place and M16 can reuse it when writing `sand.bin`. GDAL is only used to
 * read ti_5m.tif and to write the GeoTIFF with the same georeferencing. The
 * script fails unless sand_5m.tif matches elev_5m.tif in size, geotransform and
 * CRS.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGdal, runOk } from './fetch-clip.ts';
import type { Gdal } from './fetch-clip.ts';

/**
 * Cells with thermal inertia (J m⁻² K⁻¹ s⁻½) strictly below this count as
 * soft sand. Low thermal inertia means loose / fine-grained material.
 *
 * Estimate, chosen from the site TI distribution (not a published cut-off):
 * TI over the M04 box is unimodal, 154–282 with median ≈ 227, and has no
 * separate low-TI cluster. 200 sits just under the 20th percentile (≈ 204), so
 * roughly the lowest sixth of the site is flagged. Tune it here only.
 */
export const SAND_TI_MAX = 200;

/** Nodata value fetch-clip writes into ti_5m.tif. */
export const TI_NODATA = -9999;

/**
 * 1 where `ti < thresholdTI`, else 0. Nodata (`TI_NODATA`, NaN, ±Infinity or
 * any value ≤ 0, which isn't a physical thermal inertia) is 0, never sand.
 * A value exactly equal to the threshold is not sand.
 */
export function sandMask(ti: Float32Array, thresholdTI: number = SAND_TI_MAX): Uint8Array {
  const out = new Uint8Array(ti.length);
  for (let i = 0; i < ti.length; i++) {
    const v = ti[i]!;
    out[i] = Number.isFinite(v) && v !== TI_NODATA && v > 0 && v < thresholdTI ? 1 : 0;
  }
  return out;
}

// ---------------------------------------------------------------- CLI

const ROOT = resolve(import.meta.dirname, '..');
const RAW_DIR = join(ROOT, 'data', 'raw');
const ELEV = join(RAW_DIR, 'elev_5m.tif');
const TI = join(RAW_DIR, 'ti_5m.tif');
const SAND = join(RAW_DIR, 'sand_5m.tif');

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface Info {
  size: [number, number];
  geoTransform: number[];
  coordinateSystem?: { wkt?: string };
  bands: { type: string; minimum?: number; maximum?: number; mean?: number; metadata?: Record<string, Record<string, string>> }[];
}

async function info(gdal: Gdal, path: string, stats = false): Promise<Info> {
  return JSON.parse(await runOk(gdal, 'gdalinfo', ['-json', ...(stats ? ['-stats'] : []), path])) as Info;
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function main(): Promise<void> {
  console.log('==> Checking tools');
  const gdal = findGdal();
  console.log((await runOk(gdal, 'gdalinfo', ['--version'])).trim());
  for (const f of [ELEV, TI]) if (!existsSync(f)) fail(`${f} not found. Run \`npm run fetch:clip\` first (M06).`);

  const elev = await info(gdal, ELEV);
  const ti = await info(gdal, TI, true);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(ti.size, elev.size) || !same(ti.geoTransform, elev.geoTransform) || ti.coordinateSystem?.wkt !== elev.coordinateSystem?.wkt) {
    fail('ti_5m.tif is not on the elevation grid; re-run `npm run fetch:clip`.');
  }
  const tiValid = Number(ti.bands[0]?.metadata?.['']?.STATISTICS_VALID_PERCENT);
  console.log(`  ti_5m.tif on the elevation grid, ${tiValid}% valid`);

  const [width, height] = elev.size;
  const tmp = mkdtempSync(join(tmpdir(), 'marcia-sand-'));
  try {
    // Read TI as raw Float32 (machine byte order, same as Float32Array).
    const tiRaw = join(tmp, 'ti.bin');
    await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Float32', TI, tiRaw]);
    const buf = readFileSync(tiRaw);
    const tiArr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (tiArr.length !== width * height) fail(`read ${tiArr.length} TI cells, expected ${width * height}`);

    console.log(`==> sandMask (TI < ${SAND_TI_MAX})`);
    const mask = sandMask(tiArr, SAND_TI_MAX);
    let sand = 0;
    for (const v of mask) sand += v;
    console.log(`  ${sand} of ${mask.length} cells flagged as sand (${((100 * sand) / mask.length).toFixed(2)}%)`);

    // Wrap the raw mask in a VRT carrying elev's georeferencing, then write a GeoTIFF.
    const maskRaw = join(tmp, 'sand.bin');
    writeFileSync(maskRaw, mask);
    const vrt = join(tmp, 'sand.vrt');
    writeFileSync(
      vrt,
      `<VRTDataset rasterXSize="${width}" rasterYSize="${height}">\n` +
        `  <SRS>${xmlEscape(elev.coordinateSystem?.wkt ?? '')}</SRS>\n` +
        `  <GeoTransform>${elev.geoTransform.map(String).join(', ')}</GeoTransform>\n` +
        `  <VRTRasterBand dataType="Byte" band="1" subClass="VRTRawRasterBand">\n` +
        `    <SourceFilename relativeToVRT="1">sand.bin</SourceFilename>\n` +
        `    <ImageOffset>0</ImageOffset><PixelOffset>1</PixelOffset><LineOffset>${width}</LineOffset>\n` +
        `  </VRTRasterBand>\n` +
        `</VRTDataset>\n`,
    );
    console.log(`==> Writing ${SAND}`);
    await runOk(gdal, 'gdal_translate', ['-q', '-of', 'GTiff', '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', vrt, SAND]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('==> Checking alignment with elev_5m.tif');
  const out = await info(gdal, SAND, true);
  if (!same(out.size, elev.size)) fail(`size differs: elev ${elev.size.join('x')} vs sand ${out.size.join('x')}`);
  if (!same(out.geoTransform, elev.geoTransform)) fail('geotransform differs between elev_5m.tif and sand_5m.tif');
  if (out.coordinateSystem?.wkt !== elev.coordinateSystem?.wkt) fail('CRS differs between elev_5m.tif and sand_5m.tif');
  const band = out.bands[0];
  if (!band || band.type !== 'Byte') fail(`sand_5m.tif band is ${band?.type}, expected Byte`);
  if (!(band.minimum !== undefined && band.minimum >= 0 && band.maximum !== undefined && band.maximum <= 1)) {
    fail(`sand_5m.tif values out of 0..1 (min ${band.minimum}, max ${band.maximum})`);
  }
  console.log(`  elev size ${elev.size.join(' x ')}, geotransform [${elev.geoTransform.join(', ')}]`);
  console.log(`  sand size ${out.size.join(' x ')}, geotransform [${out.geoTransform.join(', ')}]`);
  console.log('  size, geotransform and CRS identical');
  // gdalinfo -json rounds `mean` to 3 decimals; the metadata keeps full precision.
  const mean = Number(band.metadata?.['']?.STATISTICS_MEAN ?? band.mean);
  console.log(`  sand_5m.tif: Byte, values ${band.minimum}..${band.maximum}, mean ${mean.toFixed(6)} (= ${(mean * 100).toFixed(2)}% sand)`);
  console.log('==> Done.');
}

// Run only as a CLI, so tests (and M16) can import `sandMask`.
const isMain =
  (import.meta as { main?: boolean }).main ??
  resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
