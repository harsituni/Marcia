/**
 * M06: download the HiRISE DTM + ortho for the EVA site and clip them to the
 * box in data/site.json on a 5 m equirectangular grid. Cross-platform
 * (Windows, macOS, Linux); run with `npm run fetch:clip`.
 *
 * Outputs (git-ignored):
 *   data/raw/elev_5m.tif   DTM, bilinear
 *   data/raw/ortho_5m.tif  ortho image, average
 *   data/raw/ti_5m.tif     thermal inertia (optional, best effort)
 * Sources are downloaded (resumable) into data/raw/src/.
 * See data/raw/README.md for sources, CRS and QGIS notes.
 *
 * Requires GDAL >= 3.2 (gdalinfo, gdalwarp, gdaltransform) with a JPEG2000
 * driver. GDAL is looked up in $GDAL_BIN, then PATH, then common install
 * locations for the OS.
 *
 * Flags: --skip-ti  don't download or clip the optional thermal inertia map.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, delimiter, join, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SITE_JSON = join(ROOT, 'data', 'site.json');
const RAW_DIR = join(ROOT, 'data', 'raw');
const SRC_DIR = join(RAW_DIR, 'src');

const MARS_R = 3396190;
const CELL_M = 5;

// Sources. Do not substitute Jezero_C or ESP_045994 products.
const DTM_BASE =
  'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/mars2020_trn/HiRISE/DTM_MOLAtopography_DeltaGeoid_Jezero_DL_Edited_affine_1m_Eqc_latTs0_lon0';
const ORTHO_BASE =
  'https://hirise.lpl.arizona.edu/PDS/DTM/PSP/ORB_002300_002399/PSP_002387_1985_PSP_003798_1985/PSP_002387_1985_RED_A_01_ORTHO';
const TI_URL = 'https://zenodo.org/records/4931348/files/Jezero_Thermal_Inertia_v1.tiff';

const SKIP_TI = process.argv.includes('--skip-ti');
const EXE = process.platform === 'win32' ? '.exe' : '';

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function step(msg: string): void {
  console.log(`==> ${msg}`);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- GDAL lookup

interface Gdal {
  /** Directory holding the GDAL executables, or '' when they're on PATH. */
  bin: string;
  env: NodeJS.ProcessEnv;
}

const hasGdal = (dir: string) => existsSync(join(dir, `gdalwarp${EXE}`));

/** Sub-directories of `dir` whose names start with `prefix`, newest-looking first. */
function dirsStartingWith(dir: string, prefix: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d) => join(dir, d.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Candidate GDAL bin directories for this OS, with the install root for data paths. */
function osCandidates(): { bin: string; root: string }[] {
  const out: { bin: string; root: string }[] = [];
  const conda = process.env.CONDA_PREFIX;
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? join(`${process.env.SystemDrive ?? 'C:'}${sep}`, 'Program Files');
    for (const root of dirsStartingWith(programFiles, 'QGIS')) out.push({ bin: join(root, 'bin'), root });
    const osgeo = join(`${process.env.SystemDrive ?? 'C:'}${sep}`, 'OSGeo4W');
    out.push({ bin: join(osgeo, 'bin'), root: osgeo });
    if (conda) out.push({ bin: join(conda, 'Library', 'bin'), root: join(conda, 'Library') });
  } else if (process.platform === 'darwin') {
    for (const app of dirsStartingWith(join(sep, 'Applications'), 'QGIS')) {
      if (app.endsWith('.app')) out.push({ bin: join(app, 'Contents', 'MacOS', 'bin'), root: join(app, 'Contents') });
    }
    out.push({ bin: join(sep, 'opt', 'homebrew', 'bin'), root: join(sep, 'opt', 'homebrew') });
    out.push({ bin: join(sep, 'usr', 'local', 'bin'), root: join(sep, 'usr', 'local') });
  } else {
    out.push({ bin: join(sep, 'usr', 'bin'), root: join(sep, 'usr') });
    out.push({ bin: join(sep, 'usr', 'local', 'bin'), root: join(sep, 'usr', 'local') });
    if (conda) out.push({ bin: join(conda, 'bin'), root: conda });
  }
  return out;
}

/** PROJ/GDAL data dirs for bundled installs (QGIS, OSGeo4W, conda) that don't set them. */
function dataEnv(root: string, bin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
  const firstExisting = (paths: string[]) => paths.find((p) => existsSync(p));
  if (!env.PROJ_DATA && !env.PROJ_LIB) {
    const proj = firstExisting([join(root, 'share', 'proj'), join(root, 'Resources', 'proj')]);
    if (proj) env.PROJ_DATA = env.PROJ_LIB = proj;
  }
  if (!env.GDAL_DATA) {
    const gdal = firstExisting([
      join(root, 'apps', 'gdal', 'share', 'gdal'),
      join(root, 'share', 'gdal'),
      join(root, 'Resources', 'gdal'),
    ]);
    if (gdal) env.GDAL_DATA = gdal;
  }
  return env;
}

function installHint(): string {
  switch (process.platform) {
    case 'win32':
      return 'Install QGIS (bundles GDAL): winget install OSGeo.QGIS  (or OSGeo4W / conda install -c conda-forge gdal)';
    case 'darwin':
      return 'Install GDAL: brew install gdal  (or the QGIS .app / conda install -c conda-forge gdal)';
    default:
      return 'Install GDAL: sudo apt install gdal-bin  (or your distro equivalent / conda install -c conda-forge gdal)';
  }
}

function findGdal(): Gdal {
  const explicit = process.env.GDAL_BIN;
  if (explicit) {
    if (hasGdal(explicit)) return { bin: explicit, env: dataEnv(resolve(explicit, '..'), explicit) };
    fail(`GDAL_BIN is set to "${explicit}" but gdalwarp${EXE} isn't there. Fix or unset GDAL_BIN.\n${installHint()}\nSee data/raw/README.md.`);
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && hasGdal(dir)) return { bin: '', env: process.env };
  }
  for (const { bin, root } of osCandidates()) {
    if (hasGdal(bin)) {
      console.log(`Using GDAL from ${bin}`);
      return { bin, env: dataEnv(root, bin) };
    }
  }
  fail(`GDAL not found (looked in GDAL_BIN, PATH and the usual install locations).\n${installHint()}\nSee data/raw/README.md.`);
}

// ---------------------------------------------------------------- processes

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(gdal: Gdal, tool: string, args: string[], input?: string): Promise<RunResult> {
  const cmd = gdal.bin ? join(gdal.bin, `${tool}${EXE}`) : `${tool}${EXE}`;
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { env: gdal.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', rej);
    child.on('close', (code) =>
      res({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
    );
    // Plain ASCII bytes on stdin: no BOM or code-page surprises.
    child.stdin.end(input === undefined ? undefined : Buffer.from(input, 'ascii'));
  });
}

/** Runs a GDAL tool, echoes its warnings, and throws on a non-zero exit. */
async function runOk(gdal: Gdal, tool: string, args: string[], input?: string): Promise<string> {
  const r = await run(gdal, tool, args, input);
  if (r.stderr.trim()) process.stderr.write(r.stderr);
  if (r.code !== 0) throw new Error(`${tool} failed (exit ${r.code}): ${args.join(' ')}`);
  return r.stdout;
}

// ---------------------------------------------------------------- downloads

// Some hosts (Zenodo) answer 403 to fetch's default `User-Agent: node`.
const UA = { 'User-Agent': 'marcia-fetch-clip' };

/** An HTTP error that retrying won't fix (4xx other than 408/429). */
class PermanentHttpError extends Error {}

async function remoteSize(url: string): Promise<number | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD', headers: UA });
      if (!res.ok) return null;
      const len = Number(res.headers.get('content-length'));
      return Number.isFinite(len) && len > 0 ? len : null;
    } catch {
      await sleep(2000 * attempt);
    }
  }
  return null;
}

const fileSize = (p: string) => (existsSync(p) ? statSync(p).size : 0);

/**
 * Downloads `url` to `dest`, resuming from `<dest>.part` with HTTP Range and
 * retrying on connection resets. Skips files whose size matches Content-Length.
 */
async function saveResumable(url: string, dest: string): Promise<void> {
  const name = basename(dest);
  const expected = await remoteSize(url);
  if (existsSync(dest) && (expected === null || fileSize(dest) === expected)) {
    console.log(`  have ${name}`);
    return;
  }
  const part = `${dest}.part`;
  const maxAttempts = 8;
  for (let attempt = 1; ; attempt++) {
    const have = fileSize(part);
    if (expected !== null && have === expected) break;
    console.log(have > 0 ? `  resuming ${name} at ${have} bytes` : `  downloading ${name}`);
    try {
      const res = await fetch(url, { headers: have > 0 ? { ...UA, Range: `bytes=${have}-` } : UA });
      if (res.status === 416 && expected === null) break; // nothing left to fetch
      if (!res.ok || !res.body) {
        await res.body?.cancel();
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        throw retryable ? new Error(`HTTP ${res.status}`) : new PermanentHttpError(`HTTP ${res.status} for ${url}`);
      }
      // 206 → append; 200 → the server ignored Range, so start over.
      const fh = await open(part, res.status === 206 ? 'a' : 'w');
      try {
        const reader = res.body.getReader();
        let written = res.status === 206 ? have : 0;
        let nextReport = expected ? Math.floor((10 * written) / expected) / 10 : 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await fh.write(value);
          written += value.byteLength;
          if (expected && written / expected >= nextReport) {
            process.stdout.write(`\r  ${name}: ${Math.floor((100 * written) / expected)}%`);
            nextReport += 0.1;
          }
        }
        if (expected) process.stdout.write('\n');
      } finally {
        await fh.close();
      }
      if (expected === null || fileSize(part) === expected) break;
      throw new Error(`connection closed at ${fileSize(part)} of ${expected} bytes`);
    } catch (err) {
      if (err instanceof PermanentHttpError) throw new Error(`download failed for ${name}: ${err.message}`);
      if (attempt >= maxAttempts) throw new Error(`download failed for ${name} after ${attempt} attempts: ${errMsg(err)}`);
      console.log(`\n  ${name}: ${errMsg(err)}; retrying (${attempt}/${maxAttempts - 1})`);
      await sleep(5000);
    }
  }
  const got = fileSize(part);
  if (expected !== null && got !== expected) throw new Error(`size mismatch for ${name}: got ${got}, expected ${expected}`);
  renameSync(part, dest);
}

// ---------------------------------------------------------------- GDAL helpers

interface Info {
  coordinateSystem?: { wkt?: string };
  cornerCoordinates: { upperLeft: [number, number]; lowerRight: [number, number] };
  bands: { noDataValue?: number }[];
}

async function getInfo(gdal: Gdal, path: string): Promise<Info | null> {
  const r = await run(gdal, 'gdalinfo', ['-json', '-nomd', path]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.stdout) as Info;
  } catch {
    return null;
  }
}

/** Percentage of non-nodata cells in band 1 (computed from all pixels). */
async function validPercent(gdal: Gdal, path: string): Promise<number> {
  const txt = await runOk(gdal, 'gdalinfo', ['-stats', path]);
  const m = /STATISTICS_VALID_PERCENT=([0-9.eE+-]+)/.exec(txt);
  if (!m) throw new Error(`gdalinfo did not report STATISTICS_VALID_PERCENT for ${path}`);
  return Number(m[1]);
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  step('Checking tools');
  const gdal = findGdal();
  const version = (await runOk(gdal, 'gdalinfo', ['--version'])).trim();
  const vm = /GDAL (\d+)\.(\d+)/.exec(version);
  if (!vm) fail(`Could not parse GDAL version: ${version}`);
  const [major, minor] = [Number(vm[1]), Number(vm[2])];
  if (major < 3 || (major === 3 && minor < 2)) fail(`GDAL >= 3.2 required, found: ${version}`);
  console.log(version);
  const formats = await runOk(gdal, 'gdalinfo', ['--formats']);
  if (!/JP2OpenJPEG|JP2KAK|JP2ECW|JP2MrSID/.test(formats)) {
    fail(`This GDAL build has no JPEG2000 driver (JP2OpenJPEG etc.).\n${installHint()}`);
  }

  // ---- site box
  step(`Reading ${SITE_JSON}`);
  if (!existsSync(SITE_JSON)) fail('data/site.json not found (M04).');
  const site = JSON.parse(readFileSync(SITE_JSON, 'utf8')) as {
    bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
    habitat?: { lon: number; lat: number };
  };
  const { minLon: W, minLat: S, maxLon: E, maxLat: N } = site.bounds;
  if (!(W < E && S < N)) fail('site.json bounds are invalid (need minLon<maxLon, minLat<maxLat).');
  const hab = site.habitat;
  if (hab && !(hab.lon > W && hab.lon < E && hab.lat > S && hab.lat < N)) fail('site.json habitat is outside the site bounds.');
  console.log(`W/S/E/N = ${W} / ${S} / ${E} / ${N}`);

  // Target grid: equirectangular, true scale at the box's middle latitude.
  const midLat = (S + N) / 2;
  const siteGeo = `+proj=longlat +R=${MARS_R} +no_defs`;
  const targetSrs = `+proj=eqc +lat_ts=${midLat} +lat_0=0 +lon_0=0 +R=${MARS_R} +units=m +no_defs`;
  const deg = Math.PI / 180;
  const k = MARS_R * Math.cos(midLat * deg);
  const xMin = W * deg * k;
  const yMax = N * deg * MARS_R;
  const cols = Math.round((E * deg * k - xMin) / CELL_M);
  const rows = Math.round((yMax - S * deg * MARS_R) / CELL_M);
  // Snap the far edges so cells are exactly 5 m.
  const te = [xMin, yMax - rows * CELL_M, xMin + cols * CELL_M, yMax].map(String);
  console.log(`Target: ${targetSrs}`);
  console.log(`Grid: ${cols} x ${rows} cells @ ${CELL_M} m`);

  // ---- downloads
  step(`Downloading sources into ${SRC_DIR}`);
  mkdirSync(SRC_DIR, { recursive: true });
  const src = (url: string) => join(SRC_DIR, basename(new URL(url).pathname));
  const dtmTif = src(`${DTM_BASE}.tif`);
  const orthoJp2 = src(`${ORTHO_BASE}.JP2`);
  const orthoLbl = src(`${ORTHO_BASE}.LBL`);
  const tiSrc = src(TI_URL);
  try {
    await saveResumable(`${DTM_BASE}.tif`, dtmTif);
    await saveResumable(`${DTM_BASE}.xml`, src(`${DTM_BASE}.xml`));
    await saveResumable(`${ORTHO_BASE}.LBL`, orthoLbl);
    await saveResumable(`${ORTHO_BASE}.JP2`, orthoJp2);
  } catch (err) {
    fail(errMsg(err));
  }
  let haveTi = false;
  if (!SKIP_TI) {
    try {
      await saveResumable(TI_URL, tiSrc);
      haveTi = true;
    } catch (err) {
      console.warn(`WARNING: optional thermal inertia download failed, skipping: ${errMsg(err)}`);
    }
  }

  // ---- coverage: the whole site box (edges densified) must lie inside each source's extent
  const steps = 8;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const lon = W + ((E - W) * i) / steps;
    const lat = S + ((N - S) * i) / steps;
    pts.push(`${lon} ${S}`, `${lon} ${N}`, `${W} ${lat}`, `${E} ${lat}`);
  }
  async function checkCoverage(label: string, path: string, info: Info): Promise<void> {
    const wkt = info.coordinateSystem?.wkt;
    if (!wkt) throw new Error(`${label} has no CRS: ${path}`);
    const wktFile = `${path}.srs.wkt`;
    writeFileSync(wktFile, wkt);
    const out = (await runOk(gdal, 'gdaltransform', ['-s_srs', siteGeo, '-t_srs', wktFile], pts.join('\n') + '\n'))
      .split(/\r?\n/)
      .filter((l) => l.trim());
    if (out.length !== pts.length) throw new Error(`gdaltransform returned ${out.length} points for ${label}, expected ${pts.length}`);
    const { upperLeft: ul, lowerRight: lr } = info.cornerCoordinates;
    const [minX, maxX] = [Math.min(ul[0], lr[0]), Math.max(ul[0], lr[0])];
    const [minY, maxY] = [Math.min(ul[1], lr[1]), Math.max(ul[1], lr[1])];
    for (const line of out) {
      const [x, y] = line.trim().split(/\s+/).map(Number) as [number, number];
      if (!(x >= minX && x <= maxX && y >= minY && y <= maxY)) {
        throw new Error(
          `${label}: site box is not fully inside the source extent (point ${x},${y} outside X[${minX},${maxX}] Y[${minY},${maxY}])`,
        );
      }
    }
    console.log(`  ${label} covers the site box`);
  }

  step('Checking coverage');
  const dtmInfo = await getInfo(gdal, dtmTif);
  if (!dtmInfo) fail(`gdalinfo could not open ${dtmTif}`);
  // Prefer the PDS label (GDAL reads the georeferencing from it); fall back to the JP2's own GeoJP2/GML box.
  let orthoSrc = '';
  let orthoInfo: Info | null = null;
  for (const cand of [orthoLbl, orthoJp2]) {
    const inf = await getInfo(gdal, cand);
    if (inf?.coordinateSystem?.wkt) {
      orthoSrc = cand;
      orthoInfo = inf;
      break;
    }
  }
  if (!orthoInfo) fail('gdalinfo could not open the ortho with a CRS via the .LBL or the .JP2.');
  console.log(`  ortho opened via ${basename(orthoSrc)}`);
  try {
    await checkCoverage('DTM', dtmTif, dtmInfo);
    await checkCoverage('ortho', orthoSrc, orthoInfo);
  } catch (err) {
    fail(errMsg(err));
  }
  if (haveTi) {
    try {
      const tiInfo = await getInfo(gdal, tiSrc);
      if (!tiInfo) throw new Error(`gdalinfo could not open ${tiSrc}`);
      await checkCoverage('thermal inertia', tiSrc, tiInfo);
    } catch (err) {
      console.warn(`WARNING: optional thermal inertia skipped: ${errMsg(err)}`);
      haveTi = false;
    }
  }

  // ---- clip
  async function clip(from: string, to: string, resampling: string, extra: string[]): Promise<void> {
    await runOk(gdal, 'gdalwarp', [
      '-overwrite',
      '-t_srs', targetSrs,
      '-te', ...te,
      '-ts', String(cols), String(rows),
      '-r', resampling,
      '-wm', '1024',
      '-multi', '-wo', 'NUM_THREADS=ALL_CPUS',
      '-co', 'COMPRESS=DEFLATE', '-co', 'TILED=YES',
      ...extra,
      from, to,
    ]);
    console.log(`  wrote ${to}`);
  }

  step(`Clipping to ${RAW_DIR}`);
  const elevOut = join(RAW_DIR, 'elev_5m.tif');
  const orthoOut = join(RAW_DIR, 'ortho_5m.tif');
  const tiOut = join(RAW_DIR, 'ti_5m.tif');
  try {
    await clip(dtmTif, elevOut, 'bilinear', ['-ot', 'Float32', '-dstnodata', '-3.4028234663852886e+38']);
    // HiRISE orthos use 0 as fill; treat it as nodata if the source doesn't declare one.
    const orthoExtra = orthoInfo.bands[0]?.noDataValue === undefined ? ['-srcnodata', '0', '-dstnodata', '0'] : ['-dstnodata', '0'];
    await clip(orthoSrc, orthoOut, 'average', orthoExtra);
  } catch (err) {
    fail(errMsg(err));
  }
  if (haveTi) {
    try {
      await clip(tiSrc, tiOut, 'bilinear', ['-ot', 'Float32', '-dstnodata', '-9999']);
    } catch (err) {
      console.warn(`WARNING: optional thermal inertia clip failed: ${errMsg(err)}`);
      haveTi = false;
    }
  }

  // ---- validate
  step('Validating outputs');
  try {
    const ev = await validPercent(gdal, elevOut);
    if (ev < 100) fail(`elev_5m.tif has nodata cells (${ev}% valid): the site box is not fully inside the DTM's valid data.`);
    console.log('  elev_5m.tif: no nodata cells');
    const ov = await validPercent(gdal, orthoOut);
    if (ov < 100) fail(`ortho_5m.tif has nodata cells (${ov}% valid): the site box is not fully inside the ortho's valid data.`);
    console.log('  ortho_5m.tif: no nodata cells');
    if (haveTi) {
      const tv = await validPercent(gdal, tiOut);
      if (tv < 100) console.warn(`WARNING: ti_5m.tif is ${tv}% valid (optional layer, not fatal).`);
      else console.log('  ti_5m.tif: no nodata cells');
    }
  } catch (err) {
    fail(errMsg(err));
  }
  step('Done. Open data/raw/*.tif in QGIS (see data/raw/README.md).');
}

main().catch((err: unknown) => fail(errMsg(err)));
