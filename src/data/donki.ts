/**
 * Fetches NASA DONKI space-weather data (M35) and caches the last good check
 * in `localStorage`. The rules that read it are in `src/engine/spaceWeather.ts`.
 *
 * The api.nasa.gov key is baked into the client bundle at build time
 * (`VITE_NASA_API_KEY`); without one it falls back to `DEMO_KEY`, which is
 * rate-limited per IP. DONKI's own host (kauai.ccmc.gsfc.nasa.gov) isn't used
 * as a fallback: it didn't answer when M35 was built.
 */
import { ENDPOINTS, SPACE_WEATHER } from '../engine/spaceWeather.ts';
import type { DonkiBundle } from '../engine/spaceWeather.ts';

export const DONKI_BASE = 'https://api.nasa.gov/DONKI/';
export const CACHE_KEY = 'marcia.donki.v1';

type Fetch = (url: string) => Promise<Response>;
/** The part of `Storage` the cache uses, so tests can pass a fake. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function donkiApiKey(): string {
  return import.meta.env?.VITE_NASA_API_KEY || 'DEMO_KEY';
}

/** yyyy-MM-dd in UTC. */
export function utcDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** DONKI URL for one endpoint over the lookback/lookahead window around `now`. */
export function donkiUrl(endpoint: string, now: Date, apiKey: string): string {
  const day = 86_400_000;
  const start = utcDate(now.getTime() - SPACE_WEATHER.lookbackDays * day);
  const end = utcDate(now.getTime() + SPACE_WEATHER.lookaheadDays * day);
  return `${DONKI_BASE}${endpoint}?startDate=${start}&endDate=${end}&api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Fetches all four endpoints. An endpoint that fails comes back `null`; if
 * every one fails (offline, HTTP 429 rate limit) this throws.
 */
export async function fetchDonki(now: Date, fetchFn: Fetch, apiKey = donkiApiKey()): Promise<DonkiBundle> {
  const keys = Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[];
  const errors: string[] = [];
  const results = await Promise.all(
    keys.map(async (k) => {
      try {
        const res = await fetchFn(donkiUrl(ENDPOINTS[k], now, apiKey));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // DONKI answers an empty window with an empty body on some endpoints.
        const text = await res.text();
        const json: unknown = text.trim() === '' ? [] : JSON.parse(text);
        if (!Array.isArray(json)) throw new Error('not a list');
        return json;
      } catch (err) {
        errors.push(`${ENDPOINTS[k]}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }),
  );
  if (results.every((r) => r === null)) throw new Error(`DONKI unavailable (${errors.join('; ')})`);
  const [sep, cme, flr, enlil] = results;
  return { fetchedAt: now.toISOString(), sep, cme, flr, enlil } as DonkiBundle;
}

export function readCache(storage: StorageLike | null): DonkiBundle | null {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as DonkiBundle;
    return typeof b?.fetchedAt === 'string' && Number.isFinite(Date.parse(b.fetchedAt)) ? b : null;
  } catch {
    return null;
  }
}

export function writeCache(storage: StorageLike | null, bundle: DonkiBundle): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(bundle));
  } catch {
    // Storage full or blocked: the check still works, just uncached.
  }
}

export interface DonkiCheck {
  bundle: DonkiBundle;
  /** True when the bundle is an older cached check because the fetch failed. */
  stale: boolean;
  /** Why the fetch failed, when `stale`. */
  error?: string;
}

/**
 * The current DONKI bundle: the cached one if it's under `refetchMin` old,
 * otherwise a fresh fetch (cached on success). If the fetch fails, the last
 * good check comes back marked `stale`; with no cache it throws.
 */
export async function checkDonki(opts: { now: Date; fetch: Fetch; storage: StorageLike | null; force?: boolean }): Promise<DonkiCheck> {
  const cached = readCache(opts.storage);
  const age = cached ? opts.now.getTime() - Date.parse(cached.fetchedAt) : Infinity;
  if (cached && !opts.force && age >= 0 && age < SPACE_WEATHER.refetchMin * 60_000) return { bundle: cached, stale: false };
  try {
    const bundle = await fetchDonki(opts.now, opts.fetch);
    writeCache(opts.storage, bundle);
    return { bundle, stale: false };
  } catch (err) {
    if (!cached) throw err;
    return { bundle: cached, stale: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** `localStorage`, or null where it's missing or blocked. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
