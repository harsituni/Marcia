/**
 * M12: sand and soft-ground masks on the elevation grid.
 *
 *   data/raw/<id>/sand_5m.tif    PRIMARY sand mask: mapped aeolian bedforms (Byte, 1/0)
 *   data/raw/<id>/soft_5m.tif    SECONDARY soft ground: THEMIS TI < SOFT_GROUND_TI_MAX (Byte, 1/0)
 *   data/raw/<id>/smooth_5m.tif  optional: smooth / "Us" mantle units (Byte, 1/0; not used yet)
 *
 * A site with no geologic map or thermal inertia in its site.json (M36: Gale)
 * has no sand data: the script says so and writes nothing, and export:grid
 * uses slope-only cost. It never invents a sand layer.
 *
 * Run with `npm run compute:sand -- --site <id>` after `npm run fetch:clip`, which downloads
 * the Stack et al. (2020) photogeologic map shapefile and clips the THEMIS TI
 * map onto the elevation grid as ti_5m.tif.
 *
 * - Sand: polygons of the map's aeolian-bedform units (Ab-l / Ab-s; in the
 *   shapefile's `SurfUName` field they're spelled out, see SAND_UNITS) are
 *   rasterized onto a copy of the elevation grid. GDAL reprojects the
 *   shapefile (eqc, lat_ts = 0) onto the grid's CRS. A cell counts when its
 *   centre is inside a polygon (gdal_rasterize without -at).
 * - Soft ground: `softGroundMask` on ti_5m.tif. Kept separate from sand; M16
 *   decides the cost weights.
 *
 * Every output must match elev_5m.tif in size, geotransform and CRS, and hold
 * only 0/1, or the script fails.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOFT_GROUND_TI_MAX } from '../src/engine/model.ts';
import { findGdal, geologyZip, runOk } from './fetch-clip.ts';
import type { Gdal } from './fetch-clip.ts';
import { siteFromArgv } from './site.ts';
import type { SiteConfig } from './site.ts';

/** True when the site has the data for a sand mask; otherwise its cost is slope-only. */
export function hasSandData(site: Pick<SiteConfig, 'sources'>): boolean {
  return site.sources.geology !== null && site.sources.thermalInertia !== null;
}

/** Shapefile layer inside the Stack et al. (2020) zip (Online Resource 3); Jezero's site.json names it too. */
export const GEOLOGY_LAYER = 'M2020_JEZ_geology_edited_equi0_allquads_v6_archive';

/** `SurfUName` values of the aeolian bedform units (Ab-l, Ab-s in Stack et al. 2020, §4.1). */
export const SAND_UNITS = ['Aeolian bedforms, large', 'Aeolian bedforms, small'] as const;

/** `SurfUName` values of the smooth / "Us" mantle units (exported, not used yet). */
export const SMOOTH_UNITS = ['Undifferentiated smooth', 'Minor Cover Us', 'Moderate Cover Us'] as const;

/** Nodata value fetch-clip writes into ti_5m.tif. */
export const TI_NODATA = -9999;

/**
 * 1 where `ti < thresholdTI`, else 0. Nodata (`TI_NODATA`, NaN, ±Infinity or
 * any value ≤ 0, which isn't a physical thermal inertia) is 0. A value exactly
 * equal to the threshold is 0.
 */
export function softGroundMask(ti: Float32Array, thresholdTI: number = SOFT_GROUND_TI_MAX): Uint8Array {
  const out = new Uint8Array(ti.length);
  for (let i = 0; i < ti.length; i++) {
    const v = ti[i]!;
    out[i] = Number.isFinite(v) && v !== TI_NODATA && v > 0 && v < thresholdTI ? 1 : 0;
  }
  return out;
}

/** OGR SQL `WHERE` clause matching any of `units` in the `SurfUName` field. */
export function unitWhere(units: readonly string[]): string {
  return `SurfUName IN (${units.map((u) => `'${u.replace(/'/g, "''")}'`).join(', ')})`;
}

// ---------------------------------------------------------------- CLI

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface Info {
  size: [number, number];
  geoTransform: number[];
  coordinateSystem?: { wkt?: string };
  bands: { type: string; minimum?: number; maximum?: number; metadata?: Record<string, Record<string, string>> }[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(2)}%`;

async function main(): Promise<void> {
  const { site, paths } = siteFromArgv();
  if (!hasSandData(site)) {
    console.log(`==> ${site.id} has no geologic sand map or thermal inertia: slope-only cost, no sand layer written.`);
    return;
  }
  const RAW_DIR = paths.rawDir;
  const ELEV = join(RAW_DIR, 'elev_5m.tif');
  const TI = join(RAW_DIR, 'ti_5m.tif');
  const SAND = join(RAW_DIR, 'sand_5m.tif');
  const SOFT = join(RAW_DIR, 'soft_5m.tif');
  const SMOOTH = join(RAW_DIR, 'smooth_5m.tif');
  const GEOLOGY_ZIP = geologyZip(site, paths)!;
  if (site.sources.geology!.layer !== GEOLOGY_LAYER) fail(`site.json geology layer is not ${GEOLOGY_LAYER}; SAND_UNITS are for the Stack et al. (2020) map only.`);
  console.log('==> Checking tools');
  const gdal = findGdal();
  console.log((await runOk(gdal, 'gdalinfo', ['--version'])).trim());
  for (const f of [ELEV, TI]) if (!existsSync(f)) fail(`${f} not found. Run \`npm run fetch:clip\` first (M06).`);
  if (!existsSync(GEOLOGY_ZIP)) fail(`${GEOLOGY_ZIP} not found. Run \`npm run fetch:clip\` to download the geology map.`);

  const info = async (path: string, stats = false): Promise<Info> =>
    JSON.parse(await runOk(gdal, 'gdalinfo', ['-json', ...(stats ? ['-stats'] : []), path])) as Info;
  const elev = await info(ELEV);
  const [width, height] = elev.size;
  const gt = elev.geoTransform;
  const n = width * height;
  const onGrid = (i: Info) => same(i.size, elev.size) && same(i.geoTransform, gt) && i.coordinateSystem?.wkt === elev.coordinateSystem?.wkt;

  const ti = await info(TI);
  if (!onGrid(ti)) fail('ti_5m.tif is not on the elevation grid; re-run `npm run fetch:clip`.');

  const tmp = mkdtempSync(join(tmpdir(), 'marcia-sand-'));
  try {
    const wkt = join(tmp, 'elev.wkt');
    writeFileSync(wkt, elev.coordinateSystem?.wkt ?? '');
    const geology = `/vsizip/${GEOLOGY_ZIP}/${GEOLOGY_LAYER}.shp`;

    /** Empty Byte raster (all 0, no nodata) on exactly the elevation grid. */
    const blankGrid = async (out: string) => {
      rmSync(out, { force: true });
      await runOk(gdal, 'gdal_create', [
        '-q', '-of', 'GTiff', '-outsize', String(width), String(height), '-bands', '1', '-ot', 'Byte', '-burn', '0',
        '-a_srs', wkt,
        '-a_ullr', String(gt[0]), String(gt[3]), String(gt[0]! + width * gt[1]!), String(gt[3]! + height * gt[5]!),
        '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES',
        out,
      ]);
    };
    /** Burns 1 into `out` wherever a polygon matching `where` covers the cell centre. */
    const rasterizeUnits = async (out: string, where: string) => {
      await blankGrid(out);
      await runOk(gdal, 'gdal_rasterize', ['-q', '-burn', '1', '-l', GEOLOGY_LAYER, '-where', where, geology, out]);
    };
    const readBytes = async (tif: string): Promise<Uint8Array> => {
      const raw = join(tmp, `${basename(tif)}.bin`);
      await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Byte', tif, raw]);
      return new Uint8Array(readFileSync(raw));
    };

    console.log('==> Geology map coverage of the site box');
    const coverTif = join(tmp, 'cover.tif');
    await rasterizeUnits(coverTif, '1 = 1');
    let covered = 0;
    for (const v of await readBytes(coverTif)) covered += v;
    console.log(`  map polygons cover ${((100 * covered) / n).toFixed(3)}% of cells (${covered} of ${n})`);
    if (covered === 0) fail('the geology map does not overlap the site box (check data/site.json / the shapefile CRS).');
    if (covered < n) console.warn(`WARNING: ${n - covered} cells are outside every map polygon; they count as not sand.`);

    console.log(`==> Sand (primary): ${SAND_UNITS.join(' + ')}`);
    await rasterizeUnits(SAND, unitWhere(SAND_UNITS));
    console.log(`==> Smooth / Us units (optional, not used yet): ${SMOOTH_UNITS.join(' + ')}`);
    await rasterizeUnits(SMOOTH, unitWhere(SMOOTH_UNITS));

    console.log(`==> Soft ground (secondary): THEMIS TI < ${SOFT_GROUND_TI_MAX}`);
    const tiRaw = join(tmp, 'ti.bin');
    await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Float32', TI, tiRaw]);
    const buf = readFileSync(tiRaw);
    const tiArr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (tiArr.length !== n) fail(`read ${tiArr.length} TI cells, expected ${n}`);
    const soft = softGroundMask(tiArr, SOFT_GROUND_TI_MAX);
    // Write the mask through a VRT that carries the elevation grid's georeferencing.
    const softRaw = join(tmp, 'soft.raw');
    writeFileSync(softRaw, soft);
    const softVrt = join(tmp, 'soft.vrt');
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    writeFileSync(
      softVrt,
      `<VRTDataset rasterXSize="${width}" rasterYSize="${height}">\n` +
        `  <SRS>${esc(elev.coordinateSystem?.wkt ?? '')}</SRS>\n` +
        `  <GeoTransform>${gt.map(String).join(', ')}</GeoTransform>\n` +
        `  <VRTRasterBand dataType="Byte" band="1" subClass="VRTRawRasterBand">\n` +
        `    <SourceFilename relativeToVRT="1">soft.raw</SourceFilename>\n` +
        `    <ImageOffset>0</ImageOffset><PixelOffset>1</PixelOffset><LineOffset>${width}</LineOffset>\n` +
        `  </VRTRasterBand>\n</VRTDataset>\n`,
    );
    await runOk(gdal, 'gdal_translate', ['-q', '-of', 'GTiff', '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES', softVrt, SOFT]);

    console.log('==> Checking alignment with elev_5m.tif');
    console.log(`  elev   size ${elev.size.join(' x ')}, geotransform [${gt.join(', ')}]`);
    const counts: Record<string, Uint8Array> = {};
    for (const out of [SAND, SOFT, SMOOTH]) {
      const i = await info(out, true);
      const name = basename(out);
      if (!onGrid(i)) fail(`${name}: size, geotransform or CRS differs from elev_5m.tif`);
      const band = i.bands[0];
      if (!band || band.type !== 'Byte') fail(`${name}: band is ${band?.type}, expected Byte`);
      if ((band.minimum ?? 0) < 0 || (band.maximum ?? 0) > 1) fail(`${name}: values outside 0..1`);
      const bytes = await readBytes(out);
      let ones = 0;
      for (const v of bytes) ones += v;
      counts[name] = bytes;
      console.log(`  ${name.padEnd(14)} size ${i.size.join(' x ')}, geotransform identical, CRS identical, Byte 0/1: ${ones} cells = ${pct(ones, n)}`);
    }

    const sand = counts[basename(SAND)]!;
    let sandN = 0;
    let softN = 0;
    let both = 0;
    for (let k = 0; k < n; k++) {
      sandN += sand[k]!;
      softN += soft[k]!;
      if (sand[k] && soft[k]) both++;
    }
    console.log('==> Sand vs soft ground (computed by us)');
    console.log(`  sand (mapped bedforms): ${pct(sandN, n)} of cells`);
    console.log(`  soft (TI < ${SOFT_GROUND_TI_MAX}):          ${pct(softN, n)} of cells`);
    console.log(`  mapped bedforms that are also TI < ${SOFT_GROUND_TI_MAX}: ${sandN ? pct(both, sandN) : 'n/a'}`);
    console.log(`  TI < ${SOFT_GROUND_TI_MAX} cells that are mapped bedforms: ${softN ? pct(both, softN) : 'n/a'}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log('==> Done.');
}

// Run only as a CLI, so tests (and M16) can import the helpers above.
const isMain =
  (import.meta as { main?: boolean }).main ??
  resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
