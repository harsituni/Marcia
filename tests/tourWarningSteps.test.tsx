// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModeSwitch } from '../src/App.tsx';
import { EngineClient } from '../src/engine/client.ts';
import { resetEngine, useAppStore } from '../src/store.ts';
import { makeTourApi } from '../src/tour/api.ts';
import { WALK_CHAPTERS } from '../src/tour/chapters/walk.ts';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIX = join(import.meta.dirname, '..', 'fixtures');
const store = () => useAppStore.getState();
const WARNING = '[role=dialog][aria-label="Walk warning"]';
const storms = WALK_CHAPTERS[1]!;

describe('tutorial: the Walk warning steps (real mode switch)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    resetEngine();
    useAppStore.setState({ makeEngine: () => new EngineClient(new FakeWorker()), mode: 'plan', walk: null, replanned: null });
    vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await store().loadData('/fixtures');
    await store().planRoute();
    await act(async () => root.render(<ModeSwitch />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    store().setSpaceWeatherDemo(false);
    vi.unstubAllGlobals();
    resetEngine();
    useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], mode: 'plan' });
  });

  it('Show me on the Walk tab step opens the warning; Start anyway then enters walk mode', async () => {
    const a = storms.steps.find((s) => s.id === 'storms-warning')!;
    const b = storms.steps.find((s) => s.id === 'storms-start-anyway')!;
    const api = makeTourApi();

    await act(async () => void (await a.setup?.(api)));
    expect(store().mode).toBe('plan');
    expect(a.action!.done(store(), document)).toBe(false);
    await act(async () => a.action!.doIt(api));
    expect(document.querySelector(WARNING)).not.toBeNull();
    expect(a.action!.done(store(), document)).toBe(true);
    expect(store().mode).toBe('plan');

    await act(async () => void (await b.setup?.(api)));
    expect(document.querySelector(b.target!)).not.toBeNull();
    expect(b.action!.done(store(), document)).toBe(false);
    await act(async () => b.action!.doIt(api));
    expect(store().mode).toBe('walk');
    expect(b.action!.done(store(), document)).toBe(true);
    expect(document.querySelector(WARNING)).toBeNull();
  });
});
