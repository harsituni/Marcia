/**
 * M30: CRISM mineral categories for the Jezero grid.
 *
 * Downloads Zenodo's RGB class map into data/raw/jezero/src/ (git-ignored),
 * reprojects it onto elev_5m.tif with nearest-neighbour sampling, then writes
 * public/data/jezero/crism.png and crism.json. Other sites have no CRISM map.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGdal, runOk } from './fetch-clip.ts';
import { siteFromArgv } from './site.ts';

export const CRISM_SOURCE_URL = 'https://zenodo.org/api/records/5575824/files/jezeroFinal.tif/content';
export const CRISM_CITATION =
  'Parente, M., Saranathan, A. M., Itoh, Y., Tarnas, J. D., Seelos, F. P., & Mustard, J. F. (2021). Map of the dominant mineralogy over and around the Mars2020 landing ellipse with correspondent spectral signatures [Data set]. Zenodo. https://doi.org/10.5281/zenodo.5575824. Licensed CC BY 4.0.';

export const CRISM_CATEGORIES = [
  {
    value: 1,
    name: 'Olivine and olivine mixtures',
    color: '#e76f51',
    classes: ['Olivine', 'Olivine+ Smectite', 'Olv. Smect + 2.2µm'],
  },
  {
    value: 2,
    name: 'Carbonates',
    color: '#e9c46a',
    classes: ['Mg-Carbonate', 'Carb. + 2.2µm'],
  },
  {
    value: 3,
    name: 'Smectites',
    color: '#2a9d8f',
    classes: ['Fe/Mg-Smectite', 'Mg-Smectite 2'],
  },
  {
    value: 4,
    name: 'Pyroxenes',
    color: '#f4a261',
    classes: ['High Ca. Pyroxene', 'Low Ca. Pyroxene'],
  },
  {
    value: 5,
    name: 'Kaolinite',
    color: '#8d5a3b',
    classes: ['Kaolinite'],
  },
] as const;

const SOURCE_CLASSES: { category: number; colors: readonly (readonly [number, number, number])[] }[] = [
  { category: 1, colors: [[255, 0, 0], [153, 0, 0]] },
  { category: 2, colors: [[0, 255, 0], [0, 153, 0]] },
  { category: 3, colors: [[0, 255, 255], [0, 153, 153]] },
  { category: 1, colors: [[255, 128, 114], [153, 77, 68]] },
  { category: 1, colors: [[128, 128, 0], [77, 77, 0]] },
  { category: 2, colors: [[255, 215, 0], [153, 129, 0]] },
  { category: 4, colors: [[255, 128, 0], [153, 77, 0]] },
  { category: 4, colors: [[218, 165, 32], [130, 99, 19]] },
  { category: 5, colors: [[139, 69, 19], [83, 41, 11]] },
  { category: 3, colors: [[0, 0, 255], [0, 0, 153]] },
];

/** Source RGB prototype colours are nearest-neighbour resampled and grouped by mineral family. */
export function classifyRgb(red: number, green: number, blue: number): number {
  if ((red <= 16 && green <= 16 && blue <= 16) || (red >= 240 && green >= 240 && blue >= 240)) return 0;
  let bestDistance = Infinity;
  let bestCategory = 0;
  for (const sourceClass of SOURCE_CLASSES) {
    for (const color of sourceClass.colors) {
      const dr = red - color[0];
      const dg = green - color[1];
      const db = blue - color[2];
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestCategory = sourceClass.category;
      }
    }
  }
  return bestCategory;
}

export function classifyRgbRaster(red: Uint8Array, green: Uint8Array, blue: Uint8Array): Uint8Array {
  if (red.length !== green.length || red.length !== blue.length) throw new Error('CRISM RGB bands have different sizes');
  const classes = new Uint8Array(red.length);
  for (let i = 0; i < classes.length; i++) classes[i] = classifyRgb(red[i]!, green[i]!, blue[i]!);
  return classes;
}

export function legendFor(classes: Uint8Array) {
  const counts = new Uint32Array(CRISM_CATEGORIES.length + 1);
  for (const value of classes) {
    if (value >= counts.length) throw new Error(`Unknown CRISM category value ${value}`);
    counts[value] = counts[value]! + 1;
  }
  return CRISM_CATEGORIES.map((category) => ({
    name: category.name,
    color: category.color,
    classes: [...category.classes],
    cells: counts[category.value]!,
  })).filter((category) => category.cells > 0);
}

interface RasterInfo {
  size: [number, number];
  geoTransform: number[];
  coordinateSystem?: { wkt?: string };
  bands: { type: string }[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

async function downloadSource(path: string): Promise<void> {
  if (existsSync(path) && readFileSync(path).byteLength > 0) return;
  console.log(`==> Downloading CRISM source to ${path}`);
  const response = await fetch(CRISM_SOURCE_URL, { headers: { 'User-Agent': 'marcia-compute-crism' } });
  if (!response.ok) throw new Error(`CRISM download failed: HTTP ${response.status}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

async function main(): Promise<void> {
  const { site, paths } = siteFromArgv();
  if (site.id !== 'jezero') {
    console.log(`==> No CRISM map for ${site.name}; no CRISM files written.`);
    return;
  }

  const elevationPath = join(paths.rawDir, 'elev_5m.tif');
  if (!existsSync(elevationPath)) fail(`${elevationPath} not found. Run \`npm run fetch:clip\` first.`);
  mkdirSync(paths.srcDir, { recursive: true });
  const sourcePath = join(paths.srcDir, 'jezeroFinal.tif');
  await downloadSource(sourcePath);

  const gdal = findGdal();
  const info = async (path: string) => JSON.parse(await runOk(gdal, 'gdalinfo', ['-json', path])) as RasterInfo;
  const elevation = await info(elevationPath);
  const [width, height] = elevation.size;
  const transform = elevation.geoTransform;
  const wkt = elevation.coordinateSystem?.wkt;
  if (!wkt || width !== 600 || height !== 600 || transform[1] !== 5 || transform[5] !== -5 || transform[2] !== 0 || transform[4] !== 0)
    fail('Jezero elevation raster must be a north-up 600 x 600, 5 m grid with a CRS.');

  const sourceInfo = await info(sourcePath);
  if (sourceInfo.bands.length !== 3 || sourceInfo.bands.some((band) => band.type !== 'Byte'))
    fail('CRISM source must be a 3-band Byte RGB raster.');

  const xMin = transform[0]!;
  const yMax = transform[3]!;
  const xMax = xMin + width * transform[1]!;
  const yMin = yMax + height * transform[5]!;
  const outDir = resolve('public', 'data', site.id);
  mkdirSync(outDir, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), 'marcia-crism-'));
  try {
    const warped = join(temp, 'crism-grid.tif');
    await runOk(gdal, 'gdalwarp', [
      '-q', '-overwrite', '-of', 'GTiff', '-r', 'near', '-srcnodata', '0 0 0', '-dstnodata', '0 0 0',
      '-t_srs', wkt, '-te', String(xMin), String(yMin), String(xMax), String(yMax), '-ts', String(width), String(height),
      '-co', 'COMPRESS=DEFLATE', sourcePath, warped,
    ]);
    const warpedInfo = await info(warped);
    if (!same(warpedInfo.size, elevation.size) || !same(warpedInfo.geoTransform, transform) || warpedInfo.coordinateSystem?.wkt !== wkt)
      fail('CRISM raster is not exactly on the elevation grid.');

    const bands = [1, 2, 3].map((band) => join(temp, `crism-${band}.bin`));
    for (let i = 0; i < bands.length; i++)
      await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Byte', '-b', String(i + 1), warped, bands[i]!]);
    const classes = classifyRgbRaster(
      new Uint8Array(readFileSync(bands[0]!)),
      new Uint8Array(readFileSync(bands[1]!)),
      new Uint8Array(readFileSync(bands[2]!)),
    );
    if (classes.length !== width * height) fail(`CRISM raster has ${classes.length} cells, expected ${width * height}.`);

    const classSeed = join(temp, 'crism-classes-seed.tif');
    await runOk(gdal, 'gdal_create', [
      '-q', '-of', 'GTiff', '-outsize', String(width), String(height), '-bands', '1', '-ot', 'Byte', '-burn', '0',
      '-a_srs', wkt, '-a_ullr', String(xMin), String(yMax), String(xMax), String(yMin), classSeed,
    ]);
    const classRaw = join(temp, 'crism-classes.bin');
    await runOk(gdal, 'gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Byte', classSeed, classRaw]);
    writeFileSync(classRaw, classes);
    const classRaster = join(temp, 'crism-classes.tif');
    await runOk(gdal, 'gdal_translate', ['-q', '-of', 'GTiff', '-ot', 'Byte', classRaw, classRaster]);
    const classInfo = await info(classRaster);
    if (!same(classInfo.size, elevation.size) || !same(classInfo.geoTransform, transform) || classInfo.coordinateSystem?.wkt !== wkt)
      fail('CRISM class raster is not exactly on the elevation grid.');

    const legend = legendFor(classes);
    const colors = join(temp, 'colors.txt');
    const rgb = (hex: string) => {
      const value = Number.parseInt(hex.slice(1), 16);
      return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
    };
    writeFileSync(
      colors,
      ['nv 0 0 0 0', '0 0 0 0 0', ...CRISM_CATEGORIES.map((category) => `${category.value} ${rgb(category.color).join(' ')} 220`)].join('\n') + '\n',
    );
    const imagePath = join(outDir, 'crism.png');
    await runOk(gdal, 'gdaldem', ['color-relief', '-q', '-alpha', '-exact_color_entry', '-of', 'PNG', classRaster, colors, imagePath]);
    const imageInfo = await info(imagePath);
    if (!same(imageInfo.size, elevation.size)) fail(`crism.png is ${imageInfo.size.join('x')}, expected ${width}x${height}.`);
    const output = {
      source: CRISM_CITATION,
      note: 'Source prototype attributions are preliminary; high- and medium-confidence tones are grouped together.',
      categories: legend,
    };
    writeFileSync(join(outDir, 'crism.json'), JSON.stringify(output, null, 2) + '\n');
    console.log(`==> Wrote ${imagePath} (${width} x ${height}); ${legend.reduce((sum, item) => sum + item.cells, 0)} mineral cells in ${legend.length} categories.`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const isMain =
  (import.meta as { main?: boolean }).main ??
  resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
