// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYER_UNAVAILABLE, parseSites, siteHasLayer } from '../src/data/sites.ts';
import { LayerToggles } from '../src/map/OverlayLayers.tsx';
import { useAppStore } from '../src/store.ts';
import { siteLayers, sitesIndex } from '../scripts/site.ts';

const PUBLIC = join(import.meta.dirname, '..', 'public');
const SITES = parseSites(JSON.parse(readFileSync(join(PUBLIC, 'data', 'sites.json'), 'utf8')));
const OFF = { difficulty: false, sand: false, geology: false, crism: false, ring: false };

describe('site layers in sites.json (#82)', () => {
  it('Jezero has sand, geology and CRISM; Gale has none of them', () => {
    expect(SITES.find((s) => s.id === 'jezero')!.layers).toEqual({ sand: true, geology: true, crism: true });
    expect(SITES.find((s) => s.id === 'gale')!.layers).toEqual({ sand: false, geology: false, crism: false });
  });
  it('sites.json matches what export:grid would write (legend files on disk)', () => {
    for (const s of sitesIndex()) expect(SITES.find((x) => x.id === s.id)!.layers).toEqual(s.layers);
    expect(siteLayers('gale', false).geology).toBe(false);
  });
  it('an older sites.json without layers treats every optional layer as unavailable', () => {
    const [s] = parseSites([{ id: 'old', name: 'Old', bounds: { minLon: 0, maxLon: 1, minLat: 0, maxLat: 1 } }]);
    expect(s!.layers).toEqual({ sand: false, geology: false, crism: false });
    expect(siteHasLayer(s, 'geology')).toBe(false);
    expect(siteHasLayer(undefined, 'sand')).toBe(false);
  });
});

describe('Layers panel on a site without the data (#82)', () => {
  let host: HTMLDivElement;
  let root: Root;
  let requested: string[];

  beforeEach(() => {
    requested = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      try {
        return new Response(readFileSync(join(PUBLIC, url.replace(/^\//, ''))));
      } catch {
        return new Response('', { status: 404 });
      }
    });
    useAppStore.setState({ sites: SITES, mode: 'plan', layers: { ...OFF } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    useAppStore.setState({ siteId: 'jezero', layers: { ...OFF } });
  });

  const box = (label: string) => [...host.querySelectorAll('label')].find((l) => l.textContent!.startsWith(label))!;

  it('Gale: Soft sand, Geology and CRISM are disabled with a tooltip, and their files are never requested', async () => {
    useAppStore.setState({ siteId: 'gale' });
    await act(async () => root.render(<LayerToggles />));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    for (const name of ['Soft sand', 'Geology', 'CRISM minerals']) {
      const label = box(name);
      expect(label.title).toBe(LAYER_UNAVAILABLE);
      expect(label.querySelector('input')!.disabled).toBe(true);
    }
    expect(box('Walking difficulty').querySelector('input')!.disabled).toBe(false);
    expect(requested.filter((u) => /gale\/(geology|crism)\.json/.test(u))).toEqual([]);
  });

  it("Gale: the store won't switch a missing layer on", () => {
    useAppStore.setState({ siteId: 'gale' });
    for (const id of ['sand', 'geology', 'crism'] as const) {
      useAppStore.getState().toggleLayer(id);
      expect(useAppStore.getState().layers[id]).toBe(false);
    }
    useAppStore.getState().toggleLayer('difficulty');
    expect(useAppStore.getState().layers.difficulty).toBe(true);
  });

  it('Jezero: the layers are enabled and the legends load', async () => {
    useAppStore.setState({ siteId: 'jezero' });
    await act(async () => root.render(<LayerToggles />));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(box('Geology').querySelector('input')!.disabled).toBe(false);
    expect(box('Geology').title).toBe('');
    expect(requested.some((u) => u.endsWith('jezero/geology.json'))).toBe(true);
    expect(requested.some((u) => u.endsWith('jezero/crism.json'))).toBe(true);
  });
});
