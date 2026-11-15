// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cell } from '../src/contracts.ts';
import type { GridData } from '../src/data/grid.ts';
import { parseSites } from '../src/data/sites.ts';
import { InspectPopup, InspectToggle } from '../src/map/MapView.tsx';
import { EngineClient } from '../src/engine/client.ts';
import { isWalkable, resetEngine, useAppStore } from '../src/store.ts';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(import.meta.dirname, '..');
const FIX = join(ROOT, 'fixtures');
const PUBLIC = join(ROOT, 'public');
const SITES = parseSites(JSON.parse(readFileSync(join(PUBLIC, 'data', 'sites.json'), 'utf8')));
const store = () => useAppStore.getState();

let host: HTMLDivElement;
let root: Root;

/** Fixture files for the loaded grid; the real overlay legends for the site's data folder. */
function serve(url: string): Response {
  const path = url.startsWith('/fixtures/') ? join(FIX, url.slice('/fixtures/'.length)) : join(PUBLIC, url.replace(/^\//, ''));
  try {
    return new Response(readFileSync(path));
  } catch {
    return new Response('', { status: 404 });
  }
}

beforeEach(async () => {
  resetEngine();
  useAppStore.setState({ makeEngine: () => new EngineClient(new FakeWorker()), mode: 'plan', sites: SITES, siteId: 'jezero' });
  vi.stubGlobal('fetch', async (url: string) => serve(url));
  await store().loadData('/fixtures');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], inspecting: false, inspectCell: null, drawingZone: null });
});

const grid = (): GridData => (store().data as { status: 'ready'; grid: GridData }).grid;
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"][aria-label="Spot details"]');
const toggle = () => host.querySelector<HTMLButtonElement>('button[aria-pressed]');
const mount = () => act(async () => root.render(<><InspectToggle /><InspectPopup grid={grid()} /></>));

/** A Plan-mode map click, as MapView routes it. */
const click = (cell: Cell) => act(async () => store().mapClick(cell));
/** Turns Inspect on, as the toggle does. */
const inspectOn = () => act(async () => store().setInspecting(true));

describe('Inspect toggle and spot popup (#91)', () => {
  it('Inspect on: a click opens Spot details with the values and their sources; stops are not added', async () => {
    await mount();
    await act(async () => toggle()!.click());
    expect(store().inspecting).toBe(true);
    expect(toggle()!.getAttribute('aria-pressed')).toBe('true');

    const before = store().stops.length;
    const cell = { x: 10, y: 10 };
    await click(cell);
    expect(store().stops.length).toBe(before);
    expect(store().inspectCell).toEqual(cell);

    await mount();
    const d = dialog();
    expect(d).not.toBeNull();
    const text = d!.textContent!;
    expect(text).toContain('Cell x 10, y 10');
    expect(text).toContain(`${grid().elevation[10 * grid().meta.width + 10]!.toFixed(1)} m`);
    expect(text).toContain('Elevation');
    expect(text).toContain('Slope');
    expect(text).toContain("computed from the DTM (Horn's method)");
    expect(text).toContain(`Source: ${SITES[0]!.credits[0]!.label}`);
  });

  it('the Inspect button sits top left, clear of the Settings panel and outside the Leaflet container', async () => {
    await mount();
    const b = toggle()!;
    expect(b.closest('.leaflet-container')).toBeNull();
    expect(b.classList.contains('left-14')).toBe(true);
    expect(b.classList.contains('right-3')).toBe(false);
  });

  it('× closes the popup', async () => {
    await mount();
    await inspectOn();
    await click({ x: 10, y: 10 });
    await mount();
    expect(dialog()).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close spot details"]')!.click());
    expect(dialog()).toBeNull();
    expect(store().inspectCell).toBeNull();
  });

  it('Esc closes the popup', async () => {
    await mount();
    await inspectOn();
    await click({ x: 10, y: 10 });
    await mount();
    expect(dialog()).not.toBeNull();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(dialog()).toBeNull();
  });

  it('Inspect off: a click adds a stop as before and opens no popup', async () => {
    await mount();
    const cell = findWalkable();
    const before = store().stops.length;
    await click(cell);
    expect(store().stops.length).toBe(before + 1);
    expect(store().inspectCell).toBeNull();
    await mount();
    expect(dialog()).toBeNull();
  });

  it('turning Inspect on cancels a zone being drawn; starting a zone turns Inspect off', () => {
    store().startZone();
    store().setInspecting(true);
    expect(store().drawingZone).toBeNull();
    expect(store().inspecting).toBe(true);
    store().startZone();
    expect(store().inspecting).toBe(false);
    expect(store().drawingZone).toEqual([]);
  });

  it('Gale has no geology or CRISM: both read "no data"', async () => {
    useAppStore.setState({ siteId: 'gale' });
    await mount();
    await inspectOn();
    await click({ x: 10, y: 10 });
    await mount();
    const rows = [...host.querySelectorAll('div')].filter((d) => d.querySelector('dt'));
    const row = (label: string) => rows.find((d) => d.querySelector('dt')!.textContent === label)!;
    expect(row('Geology unit').querySelector('dd')!.textContent).toBe('no data');
    expect(row('CRISM mineral').querySelector('dd')!.textContent).toBe('no data');
    expect(row('Geology unit').textContent).toContain('No geologic map for this site');
  });
});

/** The first cell near the middle of the grid that a stop can go on. */
function findWalkable(): Cell {
  const g = grid();
  for (let y = 5; y < g.meta.height; y++) for (let x = 5; x < g.meta.width; x++) if (isWalkable(g, { x, y })) return { x, y };
  throw new Error('no walkable cell in the fixture');
}
