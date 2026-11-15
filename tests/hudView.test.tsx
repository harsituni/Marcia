// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '../src/engine/client.ts';
import { resetEngine, useAppStore } from '../src/store.ts';
import { formatDuration } from '../src/plan/profile.ts';
import { spaceWeatherAlert } from '../src/engine/spaceWeather.ts';
import type { SpaceWeather } from '../src/engine/spaceWeather.ts';
import { Hud } from '../src/walk/Hud.tsx';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIX = join(import.meta.dirname, '..', 'fixtures');
const store = () => useAppStore.getState();

let host: HTMLDivElement;
let root: Root;
const label = (prefix: string) => [...host.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')!).find((l) => l.startsWith(prefix));

beforeEach(async () => {
  resetEngine();
  useAppStore.setState({ makeEngine: () => new EngineClient(new FakeWorker()), mode: 'walk', walk: null });
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({
    data: { status: 'idle' },
    route: { status: 'idle' },
    stops: [],
    walk: null,
    mode: 'plan',
    spaceWeather: { ...store().spaceWeather, assessment: null },
  });
});

describe('Hud', () => {
  it('asks for a route when there is none', async () => {
    await act(async () => root.render(<Hud />));
    expect(host.textContent).toContain('No route to walk yet');
  });

  it('shows the compass, both gauges, the mini-map and the next-stop card', async () => {
    await store().loadData('/fixtures');
    await act(async () => root.render(<Hud />));
    expect(label('Compass: heading')).toBeDefined();
    expect(label('Oxygen:')).toBe('Oxygen: 480 of 480 minutes left, OK');
    // At the habitat the margin is not a number yet: no spare value, no countdown.
    expect(label('Return margin:')).toBe('Return margin: at habitat');
    expect(host.textContent).toContain('—');
    // At 0 min the walker is at the habitat: no "home in ~0 min" countdown.
    expect(host.textContent).toContain('At habitat');
    expect(host.textContent).not.toContain('home in');
    expect(label('Weather MEDA:')).toMatch(/^Weather MEDA:/);
    expect(label('Radiation RAD:')).toMatch(/^Radiation RAD:/);
    expect(label('Mini-map')).toBeDefined();
    expect(label('Next stop:')).toMatch(/^Next stop: Layered Outcrop, \d+ m away$/);
    // Mini-map draws every stop and the route.
    expect(host.querySelectorAll('svg circle[fill="#c1440e"]')).toHaveLength(4);
    expect(host.querySelectorAll('polyline')).toHaveLength(2);
  });

  it('raises the RAD gauge when space weather blocks the EVA', async () => {
    await store().loadData('/fixtures');
    useAppStore.setState({
      spaceWeather: {
        ...store().spaceWeather,
        assessment: {
          status: 'block',
          reasons: [{ status: 'block', text: 'demo SEP', eventId: 'x' }],
          missing: [],
          fetchedAt: new Date().toISOString(),
        },
      },
    });
    await act(async () => root.render(<Hud />));
    expect(label('Radiation RAD:')).toMatch(/HIGH$/);
  });

  it('follows the walk state: next stop advances and the gauges drop', async () => {
    await store().loadData('/fixtures');
    await act(async () => root.render(<Hud />));
    const route = store().route;
    if (route.status !== 'ready') throw new Error('no route');
    const afterFirstStop = route.result.legs[0]!.endIdx + 1;
    await act(async () => store().setWalk({ pathIdx: afterFirstStop, oxygenLeftMin: 100 }));
    expect(label('Next stop:')).toContain('Hill Flank Boulders');
    expect(label('Oxygen:')).toBe('Oxygen: 100 of 480 minutes left, LOW');
    expect(label('Return margin:')).toMatch(/TIGHT$/);

    await act(async () => store().setWalk({ pathIdx: route.result.path.length - 1, oxygenLeftMin: 90 }));
    expect(host.textContent).toContain('Back at the habitat');
    expect(label('Oxygen:')).toMatch(/IN RESERVE$/);
    // End of the walk: a summary on the Return margin gauge, not a countdown home.
    expect(label('Return margin:')).toBe(`Return margin: EVA complete · ${formatDuration(route.result.timeMin)} · 390 min O₂ used`);
    expect(host.textContent).not.toContain('home in');
  });

  describe('storm and habitat', () => {
    const assessment = (status: 'block' | 'tighten'): SpaceWeather => ({
      status,
      reasons: [{ status, text: 'demo SEP', eventId: 'x' }],
      missing: [],
      fetchedAt: new Date().toISOString(),
    });
    /** Sets the storm the way the store does: the assessment plus the alert it produces. */
    const setStorm = (status: 'block' | 'tighten') => {
      const sw = assessment(status);
      useAppStore.setState({ spaceWeather: { ...store().spaceWeather, assessment: sw }, alerts: [spaceWeatherAlert(sw)!] });
    };
    const replanButton = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Replan from here');
    const alertTexts = () => [...host.querySelectorAll('ul[aria-label="Alerts"] li')].map((li) => li.textContent ?? '');

    it('a storm raises the oxygen reserve by 10 points', async () => {
      await store().loadData('/fixtures');
      setStorm('tighten');
      await act(async () => root.render(<Hud />));
      // Clear: reserve 20% of 480 = 96. Tightened: 30% = 144.
      expect(label('Oxygen:')).toBe('Oxygen: 480 of 480 minutes left, OK');
      expect(host.textContent).toContain('reserve 144');
    });

    it('a storm shrinks the Return margin to 75% of the usable oxygen', async () => {
      await store().loadData('/fixtures');
      const route = store().route;
      if (route.status !== 'ready') throw new Error('no route');
      const mid = Math.floor(route.result.path.length / 2);
      await act(async () => store().setWalk({ pathIdx: mid, oxygenLeftMin: 300 }));
      await act(async () => root.render(<Hud />));
      const spareOf = (l: string | undefined) => Number(/: (-?\d+) minutes spare/.exec(l ?? '')?.[1]);
      const clear = spareOf(label('Return margin:'));
      setStorm('tighten');
      await act(async () => root.render(<Hud />));
      const storm = spareOf(label('Return margin:'));
      // Clear: 300 − 96 − home. Tightened: 0.75 × (300 − 144) − home. Same walk home, so the gap is the rule.
      // Rounded on screen, so allow a minute either way; the exact numbers are in tests/hud.test.ts.
      const homeMin = 300 - 96 - clear;
      expect(Math.abs(storm - (0.75 * (300 - 144) - homeMin))).toBeLessThanOrEqual(1);
      expect(storm).toBeLessThan(clear);
    });

    it('at the habitat: no "Return to the habitat now", no Replan button, no margin number', async () => {
      await store().loadData('/fixtures');
      setStorm('block');
      await act(async () => root.render(<Hud />));
      expect(host.textContent).toContain('At habitat');
      expect(alertTexts().some((t) => t.includes('Return to the habitat now'))).toBe(false);
      expect(replanButton()).toBeUndefined();
      expect(label('Return margin:')).toBe('Return margin: at habitat');
      expect(host.textContent).not.toMatch(/\+\d/);
    });

    it('after EVA complete: same hiding, and the summary stays', async () => {
      await store().loadData('/fixtures');
      setStorm('block');
      const route = store().route;
      if (route.status !== 'ready') throw new Error('no route');
      await act(async () => store().setWalk({ pathIdx: route.result.path.length - 1, oxygenLeftMin: 90 }));
      await act(async () => root.render(<Hud />));
      expect(alertTexts().some((t) => t.includes('Return to the habitat now'))).toBe(false);
      expect(replanButton()).toBeUndefined();
      expect(host.textContent).not.toMatch(/\+\d/);
      expect(label('Return margin:')).toMatch(/^Return margin: EVA complete · /);
    });

    it('walking away from the habitat: the storm alert and Replan button are back', async () => {
      await store().loadData('/fixtures');
      setStorm('block');
      await act(async () => store().setWalk({ pathIdx: 5, oxygenLeftMin: 300 }));
      await act(async () => root.render(<Hud />));
      expect(alertTexts().some((t) => t.includes('Return to the habitat now'))).toBe(true);
      expect(replanButton()).toBeDefined();
      expect(label('Return margin:')).toMatch(/minutes spare/);
    });

    it('walking near home with the countdown rounding to 0: "Arriving at habitat"', async () => {
      await store().loadData('/fixtures');
      const route = store().route;
      if (route.status !== 'ready') throw new Error('no route');
      await act(async () => store().setWalk({ pathIdx: route.result.path.length - 1.1, oxygenLeftMin: 300 }));
      await act(async () => root.render(<Hud />));
      expect(host.textContent).toContain('Arriving at habitat');
      expect(host.textContent).not.toContain('home in');
    });

    it('normal walking still shows the countdown home', async () => {
      await store().loadData('/fixtures');
      await act(async () => store().setWalk({ pathIdx: 5, oxygenLeftMin: 300 }));
      await act(async () => root.render(<Hud />));
      expect(host.textContent).toMatch(/home in ~\d+ min/);
      expect(host.textContent).not.toContain('Arriving at habitat');
    });
  });
});
