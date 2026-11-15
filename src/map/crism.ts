/** M30: CRISM overlay files written by `npm run compute:crism` (Jezero only). */
export const CRISM_FILES = { image: 'crism.png', legend: 'crism.json' } as const;

export interface CrismCategory {
  name: string;
  color: string;
  classes: string[];
  cells: number;
}

export interface CrismLegend {
  source: string;
  note: string;
  categories: CrismCategory[];
}

/** Validates crism.json; returns null when the layer is unavailable or malformed. */
export function parseCrismLegend(json: unknown): CrismLegend | null {
  if (!json || typeof json !== 'object') return null;
  const { source, note, categories } = json as Record<string, unknown>;
  if (typeof source !== 'string' || typeof note !== 'string' || !Array.isArray(categories)) return null;
  const valid = categories.every(
    (category) =>
      category &&
      typeof category === 'object' &&
      typeof (category as CrismCategory).name === 'string' &&
      /^#[0-9a-f]{6}$/i.test((category as CrismCategory).color) &&
      Array.isArray((category as CrismCategory).classes) &&
      (category as CrismCategory).classes.every((name) => typeof name === 'string') &&
      Number.isInteger((category as CrismCategory).cells) &&
      (category as CrismCategory).cells >= 0,
  );
  return valid ? { source, note, categories: categories as CrismCategory[] } : null;
}

/** Fetches a site's CRISM legend; null when it has no map or the file is bad. */
export async function loadCrismLegend(siteUrl: string): Promise<CrismLegend | null> {
  try {
    const response = await fetch(`${siteUrl.replace(/\/$/, '')}/${CRISM_FILES.legend}`);
    return response.ok ? parseCrismLegend(await response.json()) : null;
  } catch {
    return null;
  }
}
