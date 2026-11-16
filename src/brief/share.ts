/**
 * Mission-brief share links (M37). The whole plan rides in the URL hash as
 * compact base64url JSON, so there's no backend:
 *
 *   https://…/Marcia/#brief=<base64url(JSON)>
 *
 * Opening the link restores the site, stops, constraints and the space-weather
 * snapshot, reruns the route and opens the brief.
 */
import type { Cell, Constraints, ScienceValue } from '../contracts.ts';
import type { SpaceWeatherStatus } from '../engine/spaceWeather.ts';

export const SHARE_VERSION = 1;
export const BRIEF_HASH = 'brief';

/** Space weather as it was when the plan was made. */
export interface SpaceWeatherSnapshot {
  status: SpaceWeatherStatus;
  reason: string;
  eventIds: string[];
  /** ISO time of the DONKI fetch. */
  fetchedAt: string;
  /** True when the historical-storm demo was on. */
  demo: boolean;
}

export interface SharedStop {
  id: string;
  cell: Cell;
  /** For crew-added stops, and preset stops the crew renamed (#98). */
  name?: string;
  /** #98: only when the crew set or changed it. */
  goal?: string;
  /** #98: only when the crew set or changed it. */
  scienceValue?: ScienceValue;
}

export interface SharedPlan {
  siteId: string;
  /** In visiting order. */
  stops: SharedStop[];
  constraints: Constraints;
  spaceWeather: SpaceWeatherSnapshot | null;
  /** App build: commit hash, or "dev". */
  app: string;
  /** ISO time the link was made. */
  createdAt: string;
}

/** Compact wire format: short keys, cells and constraints as arrays. */
interface Wire {
  v: number;
  s: string;
  /** [id, x, y, name?, goal?, scienceValue?]; null marks a skipped optional field. */
  p: [string, number, number, (string | null)?, (string | null)?, (ScienceValue | null)?][];
  c: [number, number, number];
  w: [SpaceWeatherStatus, string, string[], string, 0 | 1] | null;
  a: string;
  t: string;
}

export class ShareError extends Error {}

export function encodeShare(plan: SharedPlan): string {
  const wire: Wire = {
    v: SHARE_VERSION,
    s: plan.siteId,
    p: plan.stops.map((s) => {
      // Optional fields by position; null fills a gap so later ones keep their place (#98).
      const e: [string, number, number, (string | null)?, (string | null)?, (ScienceValue | null)?] = [s.id, s.cell.x, s.cell.y, s.name ?? null, s.goal ?? null, s.scienceValue ?? null];
      while (e.length > 3 && e[e.length - 1] === null) e.pop();
      return e;
    }),
    c: [plan.constraints.oxygenMin, plan.constraints.reservePct, plan.constraints.maxSlopeDeg],
    w: plan.spaceWeather
      ? [plan.spaceWeather.status, plan.spaceWeather.reason, plan.spaceWeather.eventIds, plan.spaceWeather.fetchedAt, plan.spaceWeather.demo ? 1 : 0]
      : null,
    a: plan.app,
    t: plan.createdAt,
  };
  return toBase64Url(JSON.stringify(wire));
}

/** Decodes a share payload; throws `ShareError` on anything malformed. */
export function decodeShare(payload: string): SharedPlan {
  let w: Wire;
  try {
    w = JSON.parse(fromBase64Url(payload)) as Wire;
  } catch {
    throw new ShareError('The link is damaged: it is not valid base64url JSON.');
  }
  const bad = (what: string): never => {
    throw new ShareError(`The link is damaged: ${what}.`);
  };
  if (typeof w !== 'object' || w === null) bad('not an object');
  if (w.v !== SHARE_VERSION) throw new ShareError(`This link is from a different Marcia version (format ${String(w.v)}).`);
  if (typeof w.s !== 'string' || !/^[a-z0-9-]+$/.test(w.s)) bad('bad site id');
  if (!Array.isArray(w.p) || w.p.length > 50) bad('bad stop list');
  const stops = w.p.map((e): SharedStop => {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length === 0 || e[0].length > 64) bad('bad stop');
    if (!Number.isInteger(e[1]) || !Number.isInteger(e[2]) || e[1] < 0 || e[2] < 0) bad(`bad cell for stop ${e[0]}`);
    const [id, x, y, name, goal, value] = e;
    if (name != null && (typeof name !== 'string' || name.length > 80)) bad(`bad name for stop ${id}`);
    if (goal != null && (typeof goal !== 'string' || goal.length > 400)) bad(`bad goal for stop ${id}`);
    if (value != null && value !== 1 && value !== 2 && value !== 3) bad(`bad science value for stop ${id}`);
    return {
      id,
      cell: { x, y },
      ...(name != null ? { name } : {}),
      ...(goal != null ? { goal } : {}),
      ...(value != null ? { scienceValue: value } : {}),
    };
  });
  if (new Set(stops.map((s) => s.id)).size !== stops.length) bad('duplicate stop ids');
  if (!Array.isArray(w.c) || w.c.length !== 3 || !w.c.every((n) => typeof n === 'number' && Number.isFinite(n))) bad('bad constraints');
  let spaceWeather: SpaceWeatherSnapshot | null = null;
  if (w.w !== null && w.w !== undefined) {
    const [status, reason, ids, fetchedAt, demo] = w.w;
    if (!['clear', 'tighten', 'block'].includes(status)) bad('bad space-weather status');
    if (typeof reason !== 'string' || !Array.isArray(ids) || !ids.every((i) => typeof i === 'string') || typeof fetchedAt !== 'string') {
      bad('bad space-weather snapshot');
    }
    spaceWeather = { status, reason, eventIds: ids, fetchedAt, demo: demo === 1 };
  }
  return {
    siteId: w.s,
    stops,
    constraints: { oxygenMin: w.c[0], reservePct: w.c[1], maxSlopeDeg: w.c[2] },
    spaceWeather,
    app: typeof w.a === 'string' ? w.a : 'unknown',
    createdAt: typeof w.t === 'string' ? w.t : '',
  };
}

/** What a location hash asks for: the brief of the current plan, a shared plan, or nothing. */
export type HashRequest = { kind: 'none' } | { kind: 'brief' } | { kind: 'shared'; plan: SharedPlan } | { kind: 'error'; message: string };

export function parseHash(hash: string): HashRequest {
  const h = hash.replace(/^#/, '');
  if (h === BRIEF_HASH) return { kind: 'brief' };
  if (!h.startsWith(`${BRIEF_HASH}=`)) return { kind: 'none' };
  try {
    return { kind: 'shared', plan: decodeShare(h.slice(BRIEF_HASH.length + 1)) };
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Full share URL for `plan`, on the page at `href` (any existing hash is replaced). */
export function shareUrl(href: string, plan: SharedPlan): string {
  return `${href.replace(/#.*$/, '')}#${BRIEF_HASH}=${encodeShare(plan)}`;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
