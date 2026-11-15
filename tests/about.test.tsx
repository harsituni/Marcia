// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AboutButton } from '../src/brief/Brief.tsx';
import { parseSites } from '../src/data/sites.ts';
import { useAppStore } from '../src/store.ts';

const DATA = join(import.meta.dirname, '..', 'public');
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Serve public/ for the legend files; anything missing is a 404.
  vi.stubGlobal('fetch', async (url: string) => {
    try {
      return new Response(readFileSync(join(DATA, url.replace(/^\//, ''))));
    } catch {
      return new Response('', { status: 404 });
    }
  });
  useAppStore.setState({ sites: parseSites(JSON.parse(readFileSync(join(DATA, 'data', 'sites.json'), 'utf8'))), siteId: 'jezero' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('About / Data sources panel (#81)', () => {
  it('lists Jezero datasets including CRISM and the geology map, labels modelled gauges, closes on Esc', async () => {
    await act(async () => root.render(<AboutButton />));
    await act(async () => host.querySelector('button')!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const panel = host.querySelector('[aria-label="About and data sources"]')!;
    const text = panel.textContent!;
    expect(text).toContain('Parente');
    expect(text).toContain('10.5281/zenodo.5575824');
    expect(text).toContain('Geology layer: Stack et al. (2020)');
    expect(text).toContain('NASA DONKI');
    expect(text).toMatch(/MEDA weather gauge.*modelled estimate/);
    expect(text).toMatch(/RAD radiation gauge: modelled estimate/);
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(host.querySelector('[aria-label="About and data sources"]')).toBeNull();
  });
});

describe('dataset links (#81 polish)', () => {
  it('shows each source as its label plus a "link" anchor, never the raw URL', async () => {
    await act(async () => root.render(<AboutButton />));
    await act(async () => host.querySelector('button')!.click());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    const items = [...host.querySelectorAll('[aria-label="About and data sources"] li')];
    const linked = items.filter((li) => li.querySelector('a'));
    expect(linked.length).toBeGreaterThan(3);
    for (const li of linked) {
      const a = li.querySelector('a')!;
      expect(a.textContent).toBe('link');
      expect(a.getAttribute('href')).toMatch(/^https:\/\//);
      // The URL is only in the anchor, not printed after the label.
      expect(li.textContent!.endsWith(' link')).toBe(true);
      expect(li.textContent).not.toContain(`: ${a.getAttribute('href')}`);
    }
    const geology = items.find((li) => li.textContent!.startsWith('Geology layer'))!.textContent!;
    expect(geology.split('10.1007/s11214-020-00739-x')).toHaveLength(2); // the DOI appears once
    const crism = items.find((li) => li.textContent!.startsWith('CRISM minerals layer'))!.textContent!;
    expect(crism).not.toContain('4.0.:');
    expect(crism).toMatch(/Licensed CC BY 4\.0\. link$/);
  });
});
