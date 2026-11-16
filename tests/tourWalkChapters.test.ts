import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '../src/engine/client.ts';
import { DEFAULT_CONSTRAINTS, resetEngine, useAppStore } from '../src/store.ts';
import { WALK_CHAPTERS } from '../src/tour/chapters/walk.ts';
import type { TourApi } from '../src/tour/types.ts';
import { IDLE_REPLAY } from '../src/walk/replay.ts';
import { FakeWorker } from './fakeWorker.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
const store = () => useAppStore.getState();
const doc = {} as Document;

/** A TourApi with no DOM: clicks find nothing. Steps must work through the store. */
const api: TourApi = {
  state: store,
  click: async () => false,
  ensureExpanded: async () => {},
  waitFor: async () => null,
  sleep: async () => {},
};

const KNOWN_TARGETS = new Set([
  '[role=tablist][aria-label="Mode"]',
  'section[aria-label="Helmet display"]',
  '[role=group][aria-label="Walk replay"]',
  'ul[aria-label="Alerts"]',
  '[data-tour="space-weather"]',
  '[role=status][aria-label="Replan result"]',
  '[role=group][aria-label="Replay speed"]',
  'input[aria-label="Walk progress"]',
  '[role=img][aria-label^="Compass"]',
  '[role=img][aria-label^="Return margin"]',
  '[role=img][aria-label^="Weather MEDA"]',
  '[role=img][aria-label^="Mini-map"]',
  '[data-tour="replan"]',
  '[data-tour="head-home"]',
  '[data-tour="hud-left"]',
  '[data-tour="hud-centre"]',
  '[data-tour="hud-right"]',
  '[role=dialog][aria-label="Walk warning"] section',
  '[data-tour="tutorial"]',
]);

beforeEach(async () => {
  resetEngine();
  useAppStore.setState({
    makeEngine: () => new EngineClient(new FakeWorker()),
    mode: 'plan',
    replay: IDLE_REPLAY,
    walk: null,
    replanned: null,
    alerts: [],
    constraints: DEFAULT_CONSTRAINTS,
  });
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  await store().loadData('/fixtures');
  await store().planRoute();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({
    data: { status: 'idle' },
    route: { status: 'idle' },
    stops: [],
    ring: null,
    walk: null,
    replay: IDLE_REPLAY,
    replanned: null,
    replanning: false,
    alerts: [],
    mode: 'plan',
    constraints: DEFAULT_CONSTRAINTS,
  });
  useAppStore.getState().setSpaceWeatherDemo(false);
});

describe('walk tutorial chapters: data', () => {
  const steps = WALK_CHAPTERS.flatMap((c) => c.steps.map((s) => ({ c, s })));

  it('has chapters 5 and 6 with prefixed, unique step ids', () => {
    expect(WALK_CHAPTERS.map((c) => c.id)).toEqual(['walking', 'storms']);
    const ids = steps.map(({ s }) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { c, s } of steps) expect(s.id.startsWith(`${c.id}-`)).toBe(true);
  });

  it('every step has a title and body, and actions are complete', () => {
    for (const { s } of steps) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
      if (s.action) {
        expect(s.action.prompt.length).toBeGreaterThan(0);
        expect(typeof s.action.done).toBe('function');
        expect(typeof s.action.doIt).toBe('function');
      }
    }
  });

  it('every target is a known selector', () => {
    for (const { s } of steps) if (s.target) expect(KNOWN_TARGETS.has(s.target), s.target).toBe(true);
  });
});

describe('walk tutorial chapters: behaviour', () => {
  it('actions are not done before, and done after Show me, in order', async () => {
    for (const chapter of WALK_CHAPTERS) {
      for (const step of chapter.steps) {
        await step.setup?.(api);
        if (!step.action) continue;
        expect(step.action.done(store(), doc), `${step.id} done before`).toBe(false);
        await step.action.doIt(api);
        expect(step.action.done(store(), doc), `${step.id} done after`).toBe(true);
      }
    }
  });

  it('chapter 5 ends replanned and chapter 6 ends headed home', async () => {
    const [ch5, ch6] = WALK_CHAPTERS;
    for (const step of ch5!.steps) {
      await step.setup?.(api);
      await step.action?.doIt(api);
    }
    expect(store().replanned).not.toBeNull();
    expect(store().spaceWeather.demo).toBe(false);
    for (const step of ch6!.steps) {
      await step.setup?.(api);
      await step.action?.doIt(api);
    }
    expect(store().replanned?.headedHome).toBe(true);
    expect(store().spaceWeather.demo).toBe(true);
  });

  it('the replan step lowers the oxygen, drops a stop, and a note step follows', async () => {
    const ch5 = WALK_CHAPTERS[0]!;
    const i = ch5.steps.findIndex((x) => x.id === 'walking-replan');
    const step = ch5.steps[i]!;
    await step.setup?.(api);
    expect(step.action!.done(store(), doc)).toBe(false);
    await step.action!.doIt(api);
    expect(store().replanned?.droppedIds.length).toBeGreaterThan(0);
    expect(step.action!.done(store(), doc)).toBe(true);
    expect(ch5.steps[i + 1]!.target).toBe('[role=status][aria-label="Replan result"]');
  });

  it('the warning steps: Walk tab then Start anyway', () => {
    const ch6 = WALK_CHAPTERS[1]!;
    const a = ch6.steps.find((x) => x.id === 'storms-warning')!;
    const b = ch6.steps.find((x) => x.id === 'storms-start-anyway')!;
    expect(a.target).toBe('[role=tablist][aria-label="Mode"]');
    expect(b.target).toContain('Walk warning');
    expect(b.action!.done({ ...store(), mode: 'walk' }, doc)).toBe(true);
    expect(b.action!.done({ ...store(), mode: 'plan' }, doc)).toBe(false);
  });

  it('the first step setup puts the app in Plan with the storm demo off', async () => {
    useAppStore.setState({ mode: 'walk' });
    store().setSpaceWeatherDemo(true);
    await WALK_CHAPTERS[0]!.steps[0]!.setup?.(api);
    expect(store().mode).toBe('plan');
    expect(store().spaceWeather.demo).toBe(false);
  });
});
