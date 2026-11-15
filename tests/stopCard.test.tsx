// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stop } from '../src/contracts.ts';
import { dataFileUrl } from '../src/data/grid.ts';
import { EngineClient } from '../src/engine/client.ts';
import { StopCard } from '../src/plan/StopCard.tsx';
import { resetEngine, useAppStore } from '../src/store.ts';
import { FakeWorker } from './fakeWorker.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIX = join(import.meta.dirname, '..', 'fixtures');
const stops = JSON.parse(readFileSync(join(FIX, 'stops.json'), 'utf8')) as Stop[];
const store = () => useAppStore.getState();

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  resetEngine();
  useAppStore.setState({ makeEngine: () => new EngineClient(new FakeWorker()), mode: 'plan' });
  vi.stubGlobal('fetch', async (url: string) => new Response(readFileSync(join(FIX, url.replace(/^\/fixtures\//, '')))));
  await store().loadData('/fixtures');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<StopCard />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetEngine();
  useAppStore.setState({ data: { status: 'idle' }, route: { status: 'idle' }, stops: [], selectedStopId: null });
});

const card = () => host.querySelector('article');
const select = (id: string | null) => act(async () => store().selectStop(id));

describe('stop card', () => {
  it('is hidden until a pin is selected', () => {
    expect(card()).toBeNull();
  });

  it('shows the photo, goal, geology and minerals of the selected stop', async () => {
    await select('stop-a');
    const a = stops[0]!;
    expect(card()?.getAttribute('aria-label')).toBe(`Stop 1: ${a.name}`);
    expect(card()?.textContent).toContain(a.goal);
    expect(card()?.textContent).toContain(a.geologyUnit);
    for (const m of a.minerals) expect(card()?.textContent).toContain(m);
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/fixtures/photos/stop-a.png');
  });

  it('switches when another pin is selected and closes with ×', async () => {
    await select('stop-a');
    await select('stop-c');
    expect(card()?.textContent).toContain(stops[2]!.name);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close stop details"]')!.click());
    expect(card()).toBeNull();
    expect(store().selectedStopId).toBeNull();
  });

  it('closes with Escape', async () => {
    await select('stop-b');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(card()).toBeNull();
  });

  it('shows placeholders for a crew-added stop', async () => {
    store().addStop({ x: 50, y: 85 });
    await select('custom-1');
    expect(host.querySelector('img')).toBeNull();
    expect(card()?.textContent).toContain('No photo yet');
    expect(card()?.textContent).toContain('No goal set');
    expect(card()?.textContent).toContain('None listed');
  });

  it('Remove stop deletes it and closes the card (plan mode only)', async () => {
    await select('stop-d');
    const remove = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Remove stop')!;
    await act(async () => remove.click());
    expect(store().stops.some((s) => s.id === 'stop-d')).toBe(false);
    expect(card()).toBeNull();

    await act(async () => store().setMode('walk'));
    await select('stop-a');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Remove stop')).toBe(false);
  });
});

describe('renaming (#98)', () => {
  const pencil = () => host.querySelector<HTMLButtonElement>('button[aria-label="Rename stop"]');
  const field = () => host.querySelector<HTMLInputElement>('input[aria-label="Stop name"]');
  const type = async (value: string) =>
    act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(field()!, value);
      field()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const key = (k: string) => act(async () => field()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));

  it('pencil, type, Enter saves and updates the title', async () => {
    await select('stop-a');
    await act(async () => pencil()!.click());
    await type('  Crater rim ');
    await key('Enter');
    expect(field()).toBeNull();
    expect(store().stops[0]!.name).toBe('Crater rim');
    expect(host.querySelector('h2')?.textContent).toBe('Crater rim');
  });

  it('blur saves', async () => {
    await select('stop-a');
    await act(async () => pencil()!.click());
    await type('Via blur');
    await act(async () => field()!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(store().stops[0]!.name).toBe('Via blur');
  });

  it('Escape cancels and keeps the card open', async () => {
    await select('stop-a');
    await act(async () => pencil()!.click());
    await type('Nope');
    await key('Escape');
    expect(store().stops[0]!.name).toBe(stops[0]!.name);
    expect(card()).not.toBeNull();
    expect(field()).toBeNull();
  });

  it('an empty name is rejected', async () => {
    await select('stop-a');
    await act(async () => pencil()!.click());
    await type('   ');
    await key('Enter');
    expect(store().stops[0]!.name).toBe(stops[0]!.name);
    expect(host.querySelector('h2')?.textContent).toBe(stops[0]!.name);
  });

  it('the field is capped at 40 characters', async () => {
    await select('stop-a');
    await act(async () => pencil()!.click());
    expect(field()!.maxLength).toBe(40);
  });

  it('is not offered in Walk mode', async () => {
    await act(async () => store().setMode('walk'));
    await select('stop-a');
    expect(pencil()).toBeNull();
  });
});

describe('selection', () => {
  it('ignores unknown ids', () => {
    store().selectStop('nope');
    expect(store().selectedStopId).toBeNull();
  });

  it('dataFileUrl resolves paths next to the basemap', () => {
    expect(dataFileUrl({ basemapUrl: '/Marcia/fixtures/basemap.png' }, 'photos/a.png')).toBe('/Marcia/fixtures/photos/a.png');
    expect(dataFileUrl({ basemapUrl: '/data/basemap.png' }, '/photos/a.jpg')).toBe('/data/photos/a.jpg');
  });
});
