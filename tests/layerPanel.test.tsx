// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LayerToggles } from '../src/map/OverlayLayers.tsx';
import { useAppStore } from '../src/store.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = join(import.meta.dirname, '..', 'public', 'data', 'jezero');

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  useAppStore.setState({
    siteId: 'jezero',
    mode: 'plan',
    layers: { difficulty: false, sand: false, geology: true, crism: true, ring: false },
  });
  vi.stubGlobal(
    'fetch',
    async (url: string) => new Response(readFileSync(join(DATA, url.endsWith('geology.json') ? 'geology.json' : 'crism.json'))),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<LayerToggles />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  useAppStore.setState({
    layers: { difficulty: false, sand: false, geology: false, crism: false, ring: false },
    mode: 'plan',
  });
});

describe('Layers panel legends', () => {
  it('starts with both legends collapsed and caps the panel with scrolling', () => {
    expect(host.querySelector('button[aria-controls="geology-legend"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('button[aria-controls="crism-legend"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('#geology-legend')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('#crism-legend')?.hasAttribute('hidden')).toBe(true);
    const panel = host.querySelector('fieldset');
    // #83: capped to the map height below the zoom buttons, not a fixed 45vh.
    expect(panel?.classList.contains('max-h-[calc(100%-6.5rem)]')).toBe(true);
    expect(panel?.classList.contains('overflow-y-auto')).toBe(true);
  });

  it('shows only one active legend at a time', async () => {
    const geologyButton = host.querySelector<HTMLButtonElement>('button[aria-controls="geology-legend"]')!;
    const crismButton = host.querySelector<HTMLButtonElement>('button[aria-controls="crism-legend"]')!;

    await act(async () => geologyButton.click());
    expect(geologyButton.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('#geology-legend')?.hasAttribute('hidden')).toBe(false);
    expect(host.querySelector('#crism-legend')?.hasAttribute('hidden')).toBe(true);

    await act(async () => crismButton.click());
    expect(geologyButton.getAttribute('aria-expanded')).toBe('false');
    expect(crismButton.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('#geology-legend')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('#crism-legend')?.hasAttribute('hidden')).toBe(false);
  });
});
