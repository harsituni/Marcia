// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeSwitch } from '../src/App.tsx';
import { EngineClient } from '../src/engine/client.ts';
import { resetEngine, useAppStore, walkWarnings } from '../src/store.ts';
import type { RouteResult, Stop } from '../src/contracts.ts';
import type { SpaceWeather } from '../src/engine/spaceWeather.ts';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIX = join(import.meta.dirname, '..', 'fixtures');
const store = () => useAppStore.getState();

const blocked: SpaceWeather = {
  status: 'block',
  reasons: [{ status: 'block', text: 'demo SEP', eventId: 'x' }],
  missing: [],
  fetchedAt: new Date().toISOString(),
};

describe('walkWarnings', () => {
  const route = (outOfRangeIds: string[]) => ({ status: 'ready' as const, result: { outOfRangeIds } as RouteResult });
  const stops = [
    { id: 'a', name: 'Layered Outcrop' },
    { id: 'b', name: 'Rim Cut' },
  ] as Stop[];

  it('lists a blocked EVA', () => {
    const w = walkWarnings({ spaceWeather: { assessment: blocked } as never, route: { status: 'idle' }, stops });
    expect(w).toEqual([expect.stringContaining('EVA blocked: demo SEP')]);
  });

  it('names an out-of-range stop', () => {
    const w = walkWarnings({ spaceWeather: { assessment: null } as never, route: route(['b']), stops });
    expect(w).toEqual(['Rim Cut is out of range']);
  });

  it('lists both reasons together', () => {
    const w = walkWarnings({ spaceWeather: { assessment: blocked } as never, route: route(['a']), stops });
    expect(w).toHaveLength(2);
    expect(w[0]).toContain('EVA blocked');
    expect(w[1]).toBe('Layered Outcrop is out of range');
  });

  it('is empty when there is nothing to warn about', () => {
    expect(walkWarnings({ spaceWeather: { assessment: null } as never, route: route([]), stops })).toEqual([]);
    expect(walkWarnings({ spaceWeather: { assessment: { ...blocked, status: 'tighten' } } as never, route: { status: 'idle' }, stops })).toEqual([]);
  });
});

describe('ModeSwitch walk warning', () => {
  let host: HTMLDivElement;
  let root: Root;
  const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
  const dialog = () => host.querySelector('[role="dialog"][aria-label="Walk warning"]');

  beforeEach(async () => {
    resetEngine();
    useAppStore.setState({ makeEngine: () => new EngineClient(new FakeWorker()), mode: 'plan' });
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await store().loadData('/fixtures');
    await act(async () => root.render(<ModeSwitch />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({ spaceWeather: { ...store().spaceWeather, assessment: null }, route: { status: 'idle' }, mode: 'plan' });
  });

  it('starts Walk straight away when there is no reason to warn', async () => {
    await act(async () => button('Walk').click());
    expect(store().mode).toBe('walk');
    expect(dialog()).toBeNull();
  });

  it('shows the reasons instead of switching when space weather is blocked', async () => {
    useAppStore.setState({ spaceWeather: { ...store().spaceWeather, assessment: blocked } });
    await act(async () => button('Walk').click());
    expect(store().mode).toBe('plan');
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain('EVA blocked: demo SEP');
  });

  it('lists an out-of-range stop by name', async () => {
    const stop = store().stops[0]!;
    const r = store().route;
    if (r.status !== 'ready') throw new Error('route not ready');
    useAppStore.setState({ route: { status: 'ready', result: { ...r.result, outOfRangeIds: [stop.id] } } });
    await act(async () => button('Walk').click());
    expect(store().mode).toBe('plan');
    expect(dialog()!.textContent).toContain(`${stop.name} is out of range`);
  });

  it('Cancel keeps Plan mode and closes the dialog', async () => {
    useAppStore.setState({ spaceWeather: { ...store().spaceWeather, assessment: blocked } });
    await act(async () => button('Walk').click());
    await act(async () => button('Cancel').click());
    expect(dialog()).toBeNull();
    expect(store().mode).toBe('plan');
  });

  it('Start anyway (simulation) enters Walk', async () => {
    useAppStore.setState({ spaceWeather: { ...store().spaceWeather, assessment: blocked } });
    await act(async () => button('Walk').click());
    await act(async () => button('Start anyway (simulation)').click());
    expect(dialog()).toBeNull();
    expect(store().mode).toBe('walk');
  });

  it('Esc cancels', async () => {
    useAppStore.setState({ spaceWeather: { ...store().spaceWeather, assessment: blocked } });
    await act(async () => button('Walk').click());
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(dialog()).toBeNull();
    expect(store().mode).toBe('plan');
  });
});
