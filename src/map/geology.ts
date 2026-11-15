/** M30: geologic-unit overlay files written by `npm run compute:geology` (Jezero only). */
export const GEOLOGY_FILES = { image: 'geology.png', legend: 'geology.json' } as const;

export interface GeologyLegendUnit {
  name: string;
  kind: 'bedrock' | 'surface';
  color: string;
  cells: number;
}

export interface GeologyLegend {
  source: string;
  units: GeologyLegendUnit[];
}

/** Validates geology.json; returns null for anything malformed (the layer is then shown as unavailable). */
export function parseGeologyLegend(json: unknown): GeologyLegend | null {
  if (!json || typeof json !== 'object') return null;
  const { source, units } = json as Record<string, unknown>;
  if (typeof source !== 'string' || !Array.isArray(units)) return null;
  const ok = units.every(
    (u) =>
      u && typeof u === 'object' &&
      typeof (u as GeologyLegendUnit).name === 'string' &&
      ((u as GeologyLegendUnit).kind === 'bedrock' || (u as GeologyLegendUnit).kind === 'surface') &&
      /^#[0-9a-f]{6}$/i.test((u as GeologyLegendUnit).color) &&
      typeof (u as GeologyLegendUnit).cells === 'number',
  );
  return ok ? { source, units: units as GeologyLegendUnit[] } : null;
}

/** Fetches a site's geology legend; null when the site has no geology layer (404) or the file is bad. */
export async function loadGeologyLegend(siteUrl: string): Promise<GeologyLegend | null> {
  try {
    const res = await fetch(`${siteUrl.replace(/\/$/, '')}/${GEOLOGY_FILES.legend}`);
    return res.ok ? parseGeologyLegend(await res.json()) : null;
  } catch {
    return null;
  }
}
