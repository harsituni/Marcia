/**
 * M36: which EVA site a pipeline script works on.
 *
 * Every script in scripts/ takes `--site <id>` (default `jezero`) and reads
 * `data/sites/<id>/site.json`. Per site:
 *
 *   data/sites/<id>/site.json   box, habitat, source URLs, credits
 *   data/raw/<id>/              clipped rasters (git-ignored)
 *   data/raw/<id>/src/          downloaded sources (git-ignored)
 *   public/data/<id>/           the app's DATA_FILES
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const DEFAULT_SITE = 'jezero';

export interface SiteSources {
  /** HiRISE DTM (GeoTIFF or PDS .IMG), plus any sidecar files to download next to it. */
  dtm: { url: string; sidecars?: string[] };
  /** HiRISE ortho image and its PDS label. */
  ortho: { jp2: string; lbl: string };
  /** THEMIS thermal inertia GeoTIFF, or null where none exists for the site. */
  thermalInertia: string | null;
  /** Geologic map with aeolian-bedform units (the sand mask), or null where none exists. */
  geology: { url: string; layer: string } | null;
}

export interface SiteCredit {
  label: string;
  url: string;
}

export interface SiteConfig {
  id: string;
  name: string;
  description: string;
  center: { lon: number; lat: number };
  sizeM: { width: number; height: number };
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number };
  habitat: { lon: number; lat: number };
  sources: SiteSources;
  /** Data credits shown in the app (sites.json) and the mission brief. */
  credits: SiteCredit[];
}

/** `--site <id>` or `--site=<id>`; the default site when absent. */
export function siteIdFromArgs(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--site') {
      const v = argv[i + 1];
      if (!v || v.startsWith('-')) throw new Error('--site needs an id, e.g. --site gale');
      return checkId(v);
    }
    if (a.startsWith('--site=')) return checkId(a.slice('--site='.length));
  }
  return DEFAULT_SITE;
}

function checkId(id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad site id '${id}': use lowercase letters, digits and dashes`);
  return id;
}

export interface SitePaths {
  siteJson: string;
  rawDir: string;
  srcDir: string;
  outDir: string;
}

export function sitePaths(id: string, root = ROOT): SitePaths {
  const rawDir = join(root, 'data', 'raw', id);
  return {
    siteJson: join(root, 'data', 'sites', id, 'site.json'),
    rawDir,
    srcDir: join(rawDir, 'src'),
    outDir: join(root, 'public', 'data', id),
  };
}

/** Local download path for a source URL. */
export function srcFile(paths: SitePaths, url: string): string {
  return join(paths.srcDir, basename(new URL(url).pathname));
}

export function loadSite(id: string, root = ROOT): { site: SiteConfig; paths: SitePaths } {
  const paths = sitePaths(id, root);
  if (!existsSync(paths.siteJson)) throw new Error(`${paths.siteJson} not found (unknown site '${id}')`);
  const site = JSON.parse(readFileSync(paths.siteJson, 'utf8')) as SiteConfig;
  if (site.id !== id) throw new Error(`${paths.siteJson} has id '${site.id}', expected '${id}'`);
  return { site, paths };
}

/** Every site id under data/sites/, Jezero (the app's default) first. */
export function listSiteIds(root = ROOT): string[] {
  const dir = join(root, 'data', 'sites');
  const ids = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'site.json')))
    .map((d) => d.name)
    .sort();
  return [...ids.filter((id) => id === DEFAULT_SITE), ...ids.filter((id) => id !== DEFAULT_SITE)];
}

/** The `public/data/sites.json` entries (shape: `SiteInfo` in src/data/sites.ts). */
export function sitesIndex(root = ROOT) {
  return listSiteIds(root).map((id) => {
    const { site } = loadSite(id, root);
    return {
      id: site.id,
      name: site.name,
      description: site.description,
      slopeOnly: site.sources.geology === null || site.sources.thermalInertia === null,
      bounds: site.bounds,
      credits: site.credits,
      // #82: which optional map layers this site has, so the app greys out the rest and never requests them.
      layers: siteLayers(site.id, site.sources.geology !== null && site.sources.thermalInertia !== null, root),
    };
  });
}

/** Optional layers a site has: sand when it has sand data, geology / CRISM when their legend files were exported. */
export function siteLayers(id: string, hasSand: boolean, root = ROOT): { sand: boolean; geology: boolean; crism: boolean } {
  const dir = join(root, 'public', 'data', id);
  return { sand: hasSand, geology: existsSync(join(dir, 'geology.json')), crism: existsSync(join(dir, 'crism.json')) };
}

/** Rewrites `public/data/sites.json` from every data/sites/<id>/site.json. */
export function writeSitesIndex(root = ROOT): string {
  const out = join(root, 'public', 'data', 'sites.json');
  writeFileSync(out, JSON.stringify(sitesIndex(root), null, 2) + '\n');
  return out;
}

/** Site from the command line, for a script's `main`. */
export function siteFromArgv(argv = process.argv.slice(2)): { site: SiteConfig; paths: SitePaths } {
  const r = loadSite(siteIdFromArgs(argv));
  console.log(`==> Site: ${r.site.id} (${r.site.name})`);
  return r;
}
