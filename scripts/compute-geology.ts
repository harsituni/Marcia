/**
 * M30: geologic-unit overlay for Plan mode.
 *
 *   public/data/<id>/geology.png   one pixel per grid cell, coloured by unit, transparent where unmapped
 *   public/data/<id>/geology.json  legend: [{ name, kind, color, cells }] for the units on the grid
 *
 * Source: the Stack et al. (2020) photogeologic map of Jezero crater
 * (fetched by `npm run fetch:clip`; see data/raw/README.md). Each polygon is
 * either a bedrock unit (`BedrkUName`) or a surface unit that covers bedrock
 * (`SurfUName`). Bedrock is burned first and surface units on top, so a cell
 * shows what is at the surface. A cell counts when its centre is inside a
 * polygon (gdal_rasterize without -at).
 *
 * The raster is built on a copy of elev_5m.tif and must match it in size,
 * geotransform and CRS, or the script fails. A site with no geologic map
 * (M36: Gale) gets no geology layer; nothing is invented.
 *
 * Run with `npm run compute:geology -- --site <id>` after `npm run fetch:clip`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEOLOGY_LAYER, unitWhere } from './compute-sand.ts';
import { findGdal, geologyZip, runOk } from './fetch-clip.ts';
import { siteFromArgv } from './site.ts';

export interface GeologyUnit {
  /** 1-based value in the raster (0 = unmapped). */
  value: number;
  name: string;
  kind: 'bedrock' | 'surface';
  /** CSS hex colour used in geology.png. */
  color: string;
  /** Grid cells showing this unit. */
  cells: number;
}

/** Bedrock units of the Stack et al. (2020) map (`BedrkUName`). */
export const BEDROCK_UNITS = [
  'Crater rim blocky', 'Crater rim breccia', 'Crater rim layered', 'Crater rim rough',
  'Margin fractured', 'Nili Planum fractured', 'Neretva Vallis layered',
  'Crater floor fractured 1', 'Crater floor fractured 2', 'Crater floor fractured rough',
  'Delta blocky', 'Delta layered rough', 'Delta thickly layered', 'Delta thinly layered',
  'Delta truncated curvilinear layered',
] as const;

/** Surface units of the same map (`SurfUName`), drawn over bedrock. */
export const SURFACE_UNITS = [
  'Undifferentiated smooth', 'Minor Cover Us', 'Moderate Cover Us', 'Talus',
  'Aeolian bedforms, large', 'Aeolian bedforms, small',
] as const;

/** Display palette (styling only, not data), one colour per unit in BEDROCK_UNITS then SURFACE_UNITS. */
/**
 * M34: Paul Tol's colour-blind-safe "muted" scheme (10 colours). The units on
 * the Jezero grid each get a different colour; tests/colorblind.test.ts checks
 * they stay apart under simulated protan, deutan and tritan vision. Units not on
 * any site's grid reuse colours; the same test catches a clash if one appears.
 */
const UNIT_COLORS: Record<string, string> = {
  'Crater floor fractured 1': '#332288',
  'Crater floor fractured 2': '#AA4499',
  'Delta blocky': '#117733',
  'Delta thinly layered': '#44AA99',
  'Delta truncated curvilinear layered': '#88CCEE',
  'Undifferentiated smooth': '#DDDDDD',
  'Moderate Cover Us': '#882255',
  Talus: '#999933',
  'Aeolian bedforms, large': '#DDCC77',
  'Aeolian bedforms, small': '#CC6677',
};
const PALETTE = [
  '#CC6677', '#332288', '#DDCC77', '#117733', '#88CCEE', '#882255', '#44AA99', '#999933', '#AA4499', '#DDDDDD',
];

export const ALL_UNITS: { name: string; kind: GeologyUnit['kind']; color: string }[] = [
  ...BEDROCK_UNITS.map((name) => ({ name, kind: 'bedrock' as const })),
  ...SURFACE_UNITS.map((name) => ({ name, kind: 'surface' as const })),
].map((u, i) => ({ ...u, color: UNIT_COLORS[u.name] ?? PALETTE[i % PALETTE.length]! }));

/** `hex` → "r g b" for a gdaldem colour file. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Units present in `raster` (values 1..ALL_UNITS.length), with cell counts; absent units are dropped. */
export function legendFor(raster: Uint8Array): GeologyUnit[] {
  const counts = new Array<number>(ALL_UNITS.length + 1).fill(0);
  for (const v of raster) counts[v] = (counts[v] ?? 0) + 1;
  return ALL_UNITS.map((u, i) => ({ value: i + 1, ...u, cells: counts[i + 1] ?? 0 })).filter((u) => u.cells > 0);
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
}

async function main(): Promise<void> {
  const { site, paths } = siteFromArgv();
  if (!site.sources.geology) {
    console.log(`==> ${site.id} has no geologic map: no geology layer written.`);
    return;
  }
  if (site.sources.geology.layer !== GEOLOGY_LAYER) fail(`site.json geology layer is not ${GEOLOGY_LAYER}; unit names are for Stack et al. (2020) only.`);
  const ELEV = join(paths.rawDir, 'elev_5m.tif');
  const ZIP = geologyZip(site, paths)!;
  for (const f of [ELEV, ZIP]) if (!existsSync(f)) fail(`${f} not found. Run \`npm run fetch:clip\` first.`);
  const outDir = resolve('public', 'data', site.id);
  mkdirSync(outDir, { recursive: true });

  const gdal = findGdal();
  const info = async (p: string) => JSON.parse(await runOk(gdal, 'gdalinfo', ['-json', p])) as Info;
  const elev = await info(ELEV);
  const [width, height] = elev.size;
  const gt = elev.geoTransform;
  const shp = `/vsizip/${ZIP}/${GEOLOGY_LAYER}.shp`;

  const tmp = mkdtempSync(join(tmpdir(), 'marcia-geology-'));
  try {
    const wkt = join(tmp, 'elev.wkt');
    writeFileSync(wkt, elev.coordinateSystem?.wkt ?? '');
    const tif = join(tmp, 'geology.tif');
    await runOk(gdal, 'gdal_create', [
      '-q', '-of', 'GTiff', '-outsize', String(width), String(height), '-bands', '1', '-ot', 'Byte', '-burn', '0',
      '-a_srs', wkt,
      '-a_ullr', String(gt[0]), String(gt[3]), String(gt[0]! + width * gt[1]!), String(gt[3]! + height * gt[5]!),
      tif,
    ]);
    console.log(`==> Rasterizing ${ALL_UNITS.length} units (bedrock, then surface on top)`);
    for (const [i, u] of ALL_UNITS.entries()) {
      const where = u.kind === 'bedrock' ? unitWhere([u.name]).replace('SurfUName', 'BedrkUName') : unitWhere([u.name]);
      await runOk(gdal, 'gdal_rasterize', ['-q', '-burn', String(i + 1), '-l', GEOLOGY_LAYER, '-where', where, shp, tif]);
    }

    const g = await info(tif);
    if (JSON.stringify(g.size) !== JSON.stringify(elev.size) || JSON.stringify(g.geoTransform) !== JSON.stringify(gt) || g.coordinateSystem?.wkt !== elev.coordinateSystem?.wkt)
      fail('geology raster is not on the elevation grid');
    console.log(`  on grid: size ${g.size.join(' x ')}, geotransform [${gt.join(', ')}], CRS identical`);

    const raw = join(tmp, 'geology.bin');
    await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Byte', tif, raw]);
    const cells = new Uint8Array(readFileSync(raw));
    if (cells.length !== width * height) fail(`read ${cells.length} cells, expected ${width * height}`);
    const legend = legendFor(cells);
    const mapped = legend.reduce((s, u) => s + u.cells, 0);
    console.log(`  mapped ${mapped} of ${cells.length} cells; ${legend.length} units present`);
    for (const u of legend) console.log(`    ${u.color} ${u.kind.padEnd(7)} ${u.name}: ${u.cells}`);

    const colors = join(tmp, 'colors.txt');
    writeFileSync(colors, ['nv 0 0 0 0', '0 0 0 0 0', ...ALL_UNITS.map((u, i) => `${i + 1} ${hexToRgb(u.color).join(' ')} 255`)].join('\n') + '\n');
    const png = join(outDir, 'geology.png');
    await runOk(gdal, 'gdaldem', ['color-relief', '-q', '-alpha', '-exact_color_entry', '-of', 'PNG', tif, colors, png]);
    rmSync(`${png}.aux.xml`, { force: true });
    const p = await info(png);
    if (JSON.stringify(p.size) !== JSON.stringify(elev.size)) fail(`geology.png is ${p.size.join('x')}, expected ${width}x${height}`);
    writeFileSync(join(outDir, 'geology.json'), JSON.stringify({ source: 'Stack et al. (2020), doi:10.1007/s11214-020-00739-x', units: legend }, null, 2) + '\n');
    console.log(`==> Wrote ${png} (${p.size.join(' x ')}) and geology.json`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
