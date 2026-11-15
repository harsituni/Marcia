import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectedAlerts, legRows, totals } from '../src/brief/brief.ts';
import { estimates } from '../src/brief/estimates.ts';
import { ShareError, decodeShare, encodeShare, parseHash, shareUrl } from '../src/brief/share.ts';
import type { SharedPlan } from '../src/brief/share.ts';
import { EngineClient } from '../src/engine/client.ts';
import * as model from '../src/engine/model.ts';
import { SPACE_WEATHER } from '../src/engine/spaceWeather.ts';
import { DEFAULT_CONSTRAINTS, resetEngine, sharePlanFrom, useAppStore } from '../src/store.ts';
import { IDLE_REPLAY } from '../src/walk/replay.ts';
import { FakeWorker } from './fakeWorker.ts';

const PLAN: SharedPlan = {
  siteId: 'gale',
  stops: [
    { id: 'atacama', cell: { x: 379, y: 326 } },
    { id: 'custom-1', cell: { x: 10, y: 20 }, name: 'Crête « boxwork » 🪨' },
  ],
  constraints: { oxygenMin: 420, reservePct: 25, maxSlopeDeg: 20 },
  spaceWeather: { status: 'block', reason: 'CME predicted at Mars in 3 h', eventIds: ['2024-05-11T01:36:00-CME-001'], fetchedAt: '2024-05-13T20:00:00.000Z', demo: true },
  app: 'abc1234',
  createdAt: '2026-11-15T01:00:00.000Z',
};

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

describe('share link', () => {
  it('round-trips a plan, including custom stops, unicode and the space-weather snapshot', () => {
    const payload = encodeShare(PLAN);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShare(payload)).toEqual(PLAN);
    expect(decodeShare(encodeShare({ ...PLAN, spaceWeather: null }))).toEqual({ ...PLAN, spaceWeather: null });
  });

  it('builds a #brief= URL and parses it back, replacing any old hash', () => {
    const url = shareUrl('https://x.github.io/Marcia/#brief=old', PLAN);
    expect(url.startsWith('https://x.github.io/Marcia/#brief=')).toBe(true);
    const req = parseHash(new URL(url).hash);
    expect(req).toEqual({ kind: 'shared', plan: PLAN });
    expect(parseHash('#brief')).toEqual({ kind: 'brief' });
    expect(parseHash('')).toEqual({ kind: 'none' });
    expect(parseHash('#other')).toEqual({ kind: 'none' });
  });

  it.each([
    ['not base64url', '!!!'],
    ['base64 of non-JSON', b64url('hello')],
    ['base64 of invalid UTF-8', Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')],
    ['JSON null', b64url('null')],
    ['wrong version', b64url(JSON.stringify({ v: 99 }))],
    ['bad site id', b64url(JSON.stringify({ v: 1, s: '../etc', p: [], c: [1, 2, 3], w: null }))],
    ['negative cell', b64url(JSON.stringify({ v: 1, s: 'gale', p: [['a', -1, 2]], c: [1, 2, 3], w: null }))],
    ['fractional cell', b64url(JSON.stringify({ v: 1, s: 'gale', p: [['a', 1.5, 2]], c: [1, 2, 3], w: null }))],
    ['duplicate stop ids', b64url(JSON.stringify({ v: 1, s: 'gale', p: [['a', 1, 2], ['a', 3, 4]], c: [1, 2, 3], w: null }))],
    ['too many stops', b64url(JSON.stringify({ v: 1, s: 'gale', p: Array.from({ length: 51 }, (_, i) => [`s${i}`, 1, 1]), c: [1, 2, 3], w: null }))],
    ['non-numeric constraints', b64url(JSON.stringify({ v: 1, s: 'gale', p: [], c: [1, 'x', 3], w: null }))],
    ['bad space-weather status', b64url(JSON.stringify({ v: 1, s: 'gale', p: [], c: [1, 2, 3], w: ['storm', '', [], '', 0] }))],
  ])('rejects %s with a ShareError', (_name, payload) => {
    expect(() => decodeShare(payload)).toThrow(ShareError);
    expect(parseHash(`#brief=${payload}`).kind).toBe('error');
  });
});

describe("what's estimated", () => {
  const list = estimates();
  const byKey = new Map(list.map((e) => [e.key, e.value]));

  it('lists every numeric constant in model.ts with its current value', () => {
    const numeric = Object.entries(model).filter(([, v]) => typeof v === 'number');
    expect(numeric.length).toBeGreaterThan(5);
    for (const [k, v] of numeric) expect(byKey.get(k), k).toBe(v);
  });

  it('lists every SPACE_WEATHER threshold with its current value', () => {
    for (const [k, v] of Object.entries(SPACE_WEATHER)) {
      expect(byKey.get(`SPACE_WEATHER.${k}`), k).toEqual(Array.isArray(v) ? v.join(', ') : v);
    }
  });

  it('has no entries that are not in the config', () => {
    const known = new Set([...Object.keys(model), ...Object.keys(SPACE_WEATHER).map((k) => `SPACE_WEATHER.${k}`)]);
    for (const e of list) expect(known.has(e.key), e.key).toBe(true);
  });
});

const PUBLIC = join(import.meta.dirname, '..', 'public');
const store = () => useAppStore.getState();

async function startApp() {
  const worker = new FakeWorker();
  resetEngine();
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(PUBLIC, url.replace(/^\//, '')))));
  useAppStore.setState({ makeEngine: () => new EngineClient(worker) });
  await store().loadSites();
  return worker;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({
    data: { status: 'idle' },
    route: { status: 'idle' },
    stops: [],
    ring: null,
    siteId: 'jezero',
    mode: 'plan',
    walk: null,
    replay: IDLE_REPLAY,
    briefOpen: false,
    sharedSpaceWeather: null,
    constraints: DEFAULT_CONSTRAINTS,
  });
});

describe('brief numbers on a real route', () => {
  it('legs add up to the totals; margin is usable minus used', async () => {
    await startApp();
    await store().loadData();
    const r = store().route;
    if (r.status !== 'ready') throw new Error(r.status);
    const rows = legRows(r.result, store().stops);
    expect(rows[0]!.from).toBe('Habitat');
    expect(rows.at(-1)!.to).toBe('Habitat');
    expect(rows.reduce((a, l) => a + l.distanceM, 0)).toBeCloseTo(r.result.distanceM, 6);
    expect(rows.reduce((a, l) => a + l.timeMin, 0)).toBeCloseTo(r.result.timeMin, 6);
    const t = totals(r.result, store().constraints, store().stops);
    expect(t.marginMin).toBeCloseTo(t.usableMin - r.result.oxygenUsedMin, 6);
  });

  it('expected alerts: none with plenty of oxygen; an oxygen alert on a tight supply, listed once', async () => {
    await startApp();
    await store().loadData();
    const r = store().route;
    if (r.status !== 'ready') throw new Error(r.status);
    const d = store().data;
    if (d.status !== 'ready') throw new Error('no data');
    const easy = expectedAlerts(r.result, { ...DEFAULT_CONSTRAINTS, oxygenMin: 600, reservePct: 0, maxSlopeDeg: 25 }, store().stops);
    expect(easy).toEqual([]);
    const tight = expectedAlerts(r.result, { oxygenMin: r.result.oxygenUsedMin, reservePct: 20, maxSlopeDeg: 25 }, store().stops, d.grid);
    const oxygen = tight.filter((a) => a.kind === 'oxygen');
    expect(oxygen.length).toBeGreaterThan(0);
    expect(new Set(tight.map((a) => `${a.kind}:${a.severity}`)).size).toBe(tight.length);
    expect(tight[0]!.severity).toBe('critical');
  });
});

describe('opening a share link', () => {
  it('rebuilds the same plan on another site from a fresh app and opens the brief', async () => {
    // Make a plan on Gale: reorder stops, move one, add a custom stop, change settings.
    await startApp();
    await store().loadData();
    await store().setSite('gale');
    const [a, b, c] = store().stops;
    useAppStore.setState({ stops: [c!, { ...a!, cell: { x: a!.cell.x + 1, y: a!.cell.y } }, b!], constraints: { oxygenMin: 300, reservePct: 25, maxSlopeDeg: 22 } });
    expect(store().addStop({ x: 440, y: 140 })).toBe(true);
    await store().planRoute();
    const before = store().route;
    if (before.status !== 'ready') throw new Error(before.status);
    const url = shareUrl('https://x/Marcia/', sharePlanFrom(store(), 'test', new Date()));
    const planned = { stops: store().stops, constraints: store().constraints, path: before.result.path };

    // Fresh browser.
    resetEngine();
    useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], siteId: 'jezero', constraints: DEFAULT_CONSTRAINTS, briefOpen: false });
    await startApp();
    const req = parseHash(new URL(url).hash);
    if (req.kind !== 'shared') throw new Error(req.kind);
    await store().restoreShared(req.plan);

    expect(store().siteId).toBe('gale');
    expect(store().stops).toEqual(planned.stops);
    expect(store().constraints).toEqual(planned.constraints);
    const after = store().route;
    if (after.status !== 'ready') throw new Error(after.status);
    expect(after.result.path).toEqual(planned.path);
    expect(store().briefOpen).toBe(true);
  });

  it('skips stops that are off the walkable grid', async () => {
    await startApp();
    const plan: SharedPlan = { ...PLAN, siteId: 'jezero', stops: [{ id: 'berea', cell: { x: 64, y: 238 } }, { id: 'x', cell: { x: 9999, y: 1 }, name: 'X' }], spaceWeather: null };
    await store().restoreShared(plan);
    expect(store().stops.map((s) => s.id)).toEqual(['berea']);
  });
});
