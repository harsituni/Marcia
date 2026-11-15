// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineClient } from '../src/engine/client.ts';
import { resetEngine, useAppStore } from '../src/store.ts';
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
  useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], walk: null, mode: 'plan' });
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
    expect(label('Return margin:')).toBe('Return margin: 384 minutes spare, OK');
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
  });
});
