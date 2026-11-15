import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '../src/engine/client.ts';
import { DEFAULT_CONSTRAINTS, resetEngine, useAppStore } from '../src/store.ts';
import { IDLE_REPLAY } from '../src/walk/replay.ts';
import { FakeWorker } from './fakeWorker.ts';
import { CACHE_KEY, checkDonki, donkiUrl, fetchDonki, readCache } from '../src/data/donki.ts';
import type { StorageLike } from '../src/data/donki.ts';
import {
  SPACE_WEATHER,
  assessSpaceWeather,
  effectiveConstraints,
  eventIds,
  marsArrivals,
  ringOxygenFor,
  spaceWeatherAlert,
  spaceWeatherHeadline,
} from '../src/engine/spaceWeather.ts';
import type { DonkiBundle } from '../src/engine/spaceWeather.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures', 'donki');
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8')) as DonkiBundle & { note?: string };

/** Real DONKI responses fetched 2026-11-15 00:05 UTC (FLR was returning HTTP 404). */
const TODAY = load('2026-11-15.json');
/** Real DONKI responses around a historical storm (see `note` in the file). */
const STORM = load('storm.json');

const H = 3_600_000;
const C = { oxygenMin: 480, reservePct: 20, maxSlopeDeg: 25 };

describe('space-weather rules on real DONKI data', () => {
  it('a quiet day is clear, and says which endpoint had no data', () => {
    const sw = assessSpaceWeather(TODAY, new Date(TODAY.fetchedAt));
    expect(sw.status).toBe('clear');
    expect(sw.reasons).toEqual([]);
    expect(sw.missing).toEqual(['FLR']);
    expect(spaceWeatherHeadline(sw)).toBe('Space weather: quiet');
    expect(spaceWeatherAlert(sw)).toBeNull();
    expect(effectiveConstraints(C, sw)).toBe(C);
  });

  it('the historical storm blocks the EVA at its reference time', () => {
    const sw = assessSpaceWeather(STORM, new Date(STORM.fetchedAt));
    expect(sw.status).toBe('block');
    expect(sw.reasons[0]!.status).toBe('block');
    expect(eventIds(sw).length).toBeGreaterThan(0);
    expect(spaceWeatherHeadline(sw)).toMatch(/^EVA blocked: /);
    const alert = spaceWeatherAlert(sw)!;
    expect(alert).toMatchObject({ kind: 'space-weather', severity: 'critical' });
    expect(alert.message).toMatch(/Return to the habitat/);
  });

  it('a Mars CME arrival 12–72 h ahead tightens; within 12 h blocks; long after is clear', () => {
    const arrivals = marsArrivals(STORM);
    expect(arrivals.length).toBeGreaterThan(0);
    const { at, cmeId } = arrivals[0]!;
    // Only the CME rules, and only this one CME (May 2024 had several Mars arrivals close together).
    const cmeOnly: DonkiBundle = {
      ...STORM,
      sep: [],
      flr: [],
      cme: STORM.cme!.filter((c) => c.activityID === cmeId),
      enlil: STORM.enlil!.filter((r) => (r.cmeInputs?.[0]?.CMEID ?? r.simulationID) === cmeId),
    };
    expect(marsArrivals(cmeOnly)).toEqual([{ cmeId, at }]);

    const tight = assessSpaceWeather(cmeOnly, new Date(at - 48 * H));
    expect(tight.status).toBe('tighten');
    expect(tight.reasons[0]).toMatchObject({ status: 'tighten', eventId: cmeId });

    expect(assessSpaceWeather(cmeOnly, new Date(at - 6 * H)).status).toBe('block');
    expect(assessSpaceWeather(cmeOnly, new Date(at + 6 * H)).status).toBe('block');
    expect(assessSpaceWeather(cmeOnly, new Date(at + 13 * H)).status).toBe('clear');
    expect(assessSpaceWeather(cmeOnly, new Date(at - 80 * H)).status).toBe('clear');
  });

  it('an SEP event blocks for 24 h, then stops', () => {
    const sep = STORM.sep![0]!;
    const only: DonkiBundle = { ...STORM, cme: [], enlil: [], flr: [], sep: [sep] };
    const t = Date.parse(sep.eventTime);
    expect(assessSpaceWeather(only, new Date(t + 2 * H)).status).toBe('block');
    expect(assessSpaceWeather(only, new Date(t + 25 * H)).status).toBe('clear');
    // Not yet happened at `now`: no effect.
    expect(assessSpaceWeather(only, new Date(t - H)).status).toBe('clear');
  });

  it('M and X flares tighten for 24 h; C flares do nothing', () => {
    // DONKI's FLR endpoint answered HTTP 404 for every date range when M35
    // was built, so no real flare response could be saved: STORM.flr is null.
    // This record is SYNTHETIC, shaped like a DONKI FLR entry.
    expect(STORM.flr).toBeNull();
    const big = { flrID: 'SYNTHETIC-FLR-001', beginTime: '2024-05-13T09:24Z', peakTime: '2024-05-13T09:44Z', classType: 'M6.6' };
    const at = Date.parse(big.peakTime);
    const only: DonkiBundle = { ...STORM, cme: [], enlil: [], sep: [], flr: [big] };
    const sw = assessSpaceWeather(only, new Date(at + H));
    expect(sw.status).toBe('tighten');
    expect(sw.reasons[0]!.eventId).toBe(big.flrID);
    expect(sw.reasons[0]!.text).toMatch(/near-Earth/);
    expect(assessSpaceWeather(only, new Date(at + 25 * H)).status).toBe('clear');
    const small: DonkiBundle = { ...only, flr: [{ ...big, classType: 'C3.1' }] };
    expect(assessSpaceWeather(small, new Date(at + H)).status).toBe('clear');
  });

  it('tightening raises the reserve and shrinks the ring budget by the configured amounts', () => {
    const sw = { status: 'tighten' as const, reasons: [{ status: 'tighten' as const, text: 'x', eventId: 'e' }], fetchedAt: '', missing: [] };
    expect(effectiveConstraints(C, sw)).toEqual({ ...C, reservePct: C.reservePct + SPACE_WEATHER.tightenReservePctAdd });
    expect(effectiveConstraints({ ...C, reservePct: 95 }, sw).reservePct).toBe(100);
    expect(ringOxygenFor(300, sw)).toBe(300 * SPACE_WEATHER.tightenRingOxygenFactor);
    expect(ringOxygenFor(300, null)).toBe(300);
    expect(spaceWeatherAlert(sw)).toMatchObject({ kind: 'space-weather', severity: 'warn' });
  });
});

/** Serves the saved fixture as if it were api.nasa.gov. */
function fakeDonki(bundle: DonkiBundle, status: Partial<Record<string, number>> = {}) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const ep = new URL(url).pathname.split('/').pop()!;
    if (status[ep]) return new Response('{}', { status: status[ep] });
    const body = { SEP: bundle.sep, CME: bundle.cme, FLR: bundle.flr, WSAEnlilSimulations: bundle.enlil }[ep];
    return body === null ? new Response('', { status: 404 }) : new Response(JSON.stringify(body));
  };
  return { fetch, calls };
}

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const ALL_429 = { SEP: 429, CME: 429, FLR: 429, WSAEnlilSimulations: 429 };

describe('DONKI fetch and cache', () => {
  const now = new Date('2026-11-15T00:05:00Z');

  it('asks every endpoint for 3 days back to 3 days ahead, with the key', () => {
    expect(donkiUrl('CME', now, 'K')).toBe('https://api.nasa.gov/DONKI/CME?startDate=2026-11-12&endDate=2026-11-18&api_key=K');
  });

  it('a failed endpoint comes back null; the rest still parse', async () => {
    const { fetch, calls } = fakeDonki(TODAY);
    const b = await fetchDonki(now, fetch, 'K');
    expect(calls).toHaveLength(4);
    expect(b.flr).toBeNull();
    expect(b.cme).toEqual(TODAY.cme);
    expect(b.fetchedAt).toBe(now.toISOString());
  });

  it('throws when every endpoint fails (rate limited)', async () => {
    await expect(fetchDonki(now, fakeDonki(TODAY, ALL_429).fetch, 'K')).rejects.toThrow(/HTTP 429/);
  });

  it('fetches at most once per 15 min, then refetches', async () => {
    const storage = memStorage();
    const { fetch, calls } = fakeDonki(TODAY);
    await checkDonki({ now, fetch, storage });
    expect(calls).toHaveLength(4);
    expect(readCache(storage)?.fetchedAt).toBe(now.toISOString());

    const soon = await checkDonki({ now: new Date(now.getTime() + 14 * 60_000), fetch, storage });
    expect(calls).toHaveLength(4);
    expect(soon.stale).toBe(false);

    await checkDonki({ now: new Date(now.getTime() + 16 * 60_000), fetch, storage });
    expect(calls).toHaveLength(8);
  });

  it('offline or rate limited: falls back to the last good check, marked stale', async () => {
    const storage = memStorage();
    await checkDonki({ now, fetch: fakeDonki(TODAY).fetch, storage });
    const later = new Date(now.getTime() + 60 * 60_000);
    const res = await checkDonki({ now: later, fetch: fakeDonki(TODAY, ALL_429).fetch, storage });
    expect(res.stale).toBe(true);
    expect(res.bundle.fetchedAt).toBe(now.toISOString());
    expect(res.error).toMatch(/429/);
    const offline = await checkDonki({ now: later, fetch: () => Promise.reject(new TypeError('Failed to fetch')), storage });
    expect(offline.stale).toBe(true);
  });

  it('with no cache, a failed fetch throws; a corrupt cache is ignored', async () => {
    const storage = memStorage();
    storage.data.set(CACHE_KEY, '{not json');
    expect(readCache(storage)).toBeNull();
    await expect(checkDonki({ now, fetch: fakeDonki(TODAY, ALL_429).fetch, storage })).rejects.toThrow();
    expect(readCache(null)).toBeNull();
  });
});

describe('space weather in the app (demo storm)', () => {
  const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
  const store = () => useAppStore.getState();
  const settle = async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({
      data: { status: 'idle' },
      route: { status: 'idle' },
      stops: [],
      ring: null,
      mode: 'plan',
      walk: null,
      replay: IDLE_REPLAY,
      alerts: [],
      constraints: DEFAULT_CONSTRAINTS,
      spaceWeather: { assessment: null, stale: false, loading: false, error: null, demo: false },
    });
  });

  it('blocks: the engine plans with the raised reserve, Walk shows a critical alert first, the ring shrinks', async () => {
    const worker = new FakeWorker();
    resetEngine();
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIXTURES, url.replace(/^\/fixtures\//, '')))));
    useAppStore.setState({ makeEngine: () => new EngineClient(worker) });
    await store().loadData('/fixtures');
    useAppStore.setState({ constraints: { ...DEFAULT_CONSTRAINTS, reservePct: 20 } });
    await store().planRoute();
    store().toggleLayer('ring');
    await settle();
    const ringBefore = worker.sent.filter((m) => m.type === 'ring').at(-1);

    store().setSpaceWeatherDemo(true);
    await settle();
    expect(store().spaceWeather.assessment?.status).toBe('block');
    const lastRoute = worker.sent.filter((m) => m.type === 'route').at(-1);
    expect(lastRoute?.type === 'route' && lastRoute.req.constraints.reservePct).toBe(20 + SPACE_WEATHER.tightenReservePctAdd);
    expect(store().constraints.reservePct).toBe(20); // the crew's own setting is untouched
    const ringAfter = worker.sent.filter((m) => m.type === 'ring').at(-1);
    if (ringBefore?.type !== 'ring' || ringAfter?.type !== 'ring') throw new Error('no ring request');
    expect(ringAfter.oxygenLeftMin).toBeLessThan(ringBefore.oxygenLeftMin);

    store().setMode('walk');
    await settle();
    expect(store().alerts[0]).toMatchObject({ kind: 'space-weather', severity: 'critical' });
    expect(store().alerts[0]!.message).toMatch(/Return to the habitat/);

    store().setSpaceWeatherDemo(false);
    await settle();
    expect(store().alerts.some((a) => a.kind === 'space-weather')).toBe(false);
  });
});
