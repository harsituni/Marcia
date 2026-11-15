// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Brief } from '../src/brief/Brief.tsx';
import { EngineClient } from '../src/engine/client.ts';
import { LayerToggles } from '../src/map/OverlayLayers.tsx';
import { resetEngine, useAppStore } from '../src/store.ts';
import { FakeWorker } from './fakeWorker.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');
let host: HTMLDivElement;
let root: Root;
const dialog = () => host.querySelector('[aria-label="Mission brief"]');
const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

beforeEach(async () => {
  resetEngine();
  vi.stubGlobal('fetch', async (url: string) => {
    try {
      return new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, ''))));
    } catch {
      return new Response('', { status: 404 });
    }
  });
  useAppStore.setState({ makeEngine: () => new EngineClient(new FakeWorker()), mode: 'plan', briefOpen: false });
  await useAppStore.getState().loadData('/fixtures');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({ briefOpen: false, data: { status: 'idle' }, route: { status: 'idle' }, stops: [] });
});

describe('Mission brief and Esc (#83)', () => {
  it('Esc closes the open brief', async () => {
    await act(async () => root.render(<Brief />));
    await act(async () => useAppStore.getState().setBriefOpen(true));
    expect(dialog()).not.toBeNull();
    await act(async () => esc());
    expect(dialog()).toBeNull();
    expect(useAppStore.getState().briefOpen).toBe(false);
  });

  it('Esc clears a #brief link hash, like the Close button', async () => {
    history.replaceState(null, '', '/#brief=abc');
    await act(async () => root.render(<Brief />));
    await act(async () => useAppStore.getState().setBriefOpen(true));
    await act(async () => esc());
    expect(location.hash).toBe('');
  });

  it('other keys leave it open, and Esc does nothing once it is closed', async () => {
    await act(async () => root.render(<Brief />));
    await act(async () => useAppStore.getState().setBriefOpen(true));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })));
    expect(dialog()).not.toBeNull();
    await act(async () => esc());
    await act(async () => esc());
    expect(useAppStore.getState().briefOpen).toBe(false);
  });
});

describe('Route key lives in the Layers panel (#83)', () => {
  it('is drawn inside the panel, not as a separate floating box', async () => {
    await act(async () => root.render(<LayerToggles />));
    const key = host.querySelector('[aria-label="Route key"]')!;
    expect(key.textContent).toContain('Way out');
    expect(key.textContent).toContain('Way home');
    expect(key.closest('fieldset')).not.toBeNull();
    expect(key.className).not.toContain('absolute');
  });
});
