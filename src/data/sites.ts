/**
 * EVA sites (M36). `public/data/sites.json` lists them; each site's
 * DATA_FILES live in `public/data/<id>/`. `export:grid` writes the index from
 * `data/sites/<id>/site.json`.
 */

export interface SiteCredit {
  label: string;
  url: string;
}

/** Lon/lat box of one EVA site (degrees, east-positive). Used by the 3D view (M33). */
export interface SiteBounds {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

/** One entry in `sites.json`. */
export interface SiteInfo {
  id: string;
  name: string;
  description: string;
  /** True when the site has no sand / thermal-inertia data: cost is slope only. */
  slopeOnly: boolean;
  /** Site lon/lat box from `data/sites/<id>/site.json` (M33 3D georef). */
  bounds: SiteBounds;
  credits: SiteCredit[];
}

export const SITES_FILE = 'sites.json';
export const DEFAULT_SITE_ID = 'jezero';

/** Jezero box from `data/sites/jezero/site.json` — used when `sites.json` can't load. */
export const JEZERO_BOUNDS: SiteBounds = {
  minLon: 77.37832,
  maxLon: 77.43168,
  minLat: 18.43969,
  maxLat: 18.49031,
};

/** Used until `sites.json` loads, and if it can't. */
export const FALLBACK_SITES: SiteInfo[] = [
  {
    id: DEFAULT_SITE_ID,
    name: 'Jezero Crater western delta',
    description: '',
    slopeOnly: false,
    bounds: JEZERO_BOUNDS,
    credits: [],
  },
];

function parseBounds(raw: unknown, label: string): SiteBounds {
  const b = raw as Partial<SiteBounds> | null;
  if (
    !b ||
    typeof b.minLon !== 'number' ||
    typeof b.maxLon !== 'number' ||
    typeof b.minLat !== 'number' ||
    typeof b.maxLat !== 'number' ||
    !(b.maxLon > b.minLon) ||
    !(b.maxLat > b.minLat)
  ) {
    throw new Error(`${label}: bad bounds`);
  }
  return { minLon: b.minLon, maxLon: b.maxLon, minLat: b.minLat, maxLat: b.maxLat };
}

/** Checks the shape of `sites.json`; throws on anything unusable. */
export function parseSites(json: unknown): SiteInfo[] {
  if (!Array.isArray(json) || json.length === 0) throw new Error('sites.json: expected a non-empty list');
  const ids = new Set<string>();
  return json.map((s: Partial<SiteInfo>, i) => {
    if (typeof s?.id !== 'string' || !/^[a-z0-9-]+$/.test(s.id)) throw new Error(`sites.json[${i}]: bad id`);
    if (ids.has(s.id)) throw new Error(`sites.json: duplicate id ${s.id}`);
    ids.add(s.id);
    if (typeof s.name !== 'string') throw new Error(`sites.json[${i}]: missing name`);
    return {
      id: s.id,
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      slopeOnly: s.slopeOnly === true,
      bounds: parseBounds(s.bounds, `sites.json[${i}]`),
      credits: Array.isArray(s.credits) ? s.credits.filter((c) => typeof c?.label === 'string' && typeof c?.url === 'string') : [],
    };
  });
}

/** Data directory of one site, under the app's data root (e.g. `/data`). */
export function siteDataUrl(dataRoot: string, id: string): string {
  return `${dataRoot.replace(/\/$/, '')}/${id}`;
}
