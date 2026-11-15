// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DonkiBundle } from '../src/engine/spaceWeather.ts';
import { SpaceWeatherChip } from '../src/SpaceWeatherChip.tsx';
import { useAppStore } from '../src/store.ts';

const TODAY = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'donki', '2026-11-15.json'), 'utf8')) as DonkiBundle;
const initial = useAppStore.getState().spaceWeather;

/** DONKI stand-in: `failing` endpoints answer 404, the rest answer from TODAY (FLR as an empty list). */
const donki = (failing: string[]) => async (url: string) => {
  const ep = new URL(url).pathname.split('/').pop()!;
  if (failing.includes(ep)) return new Response('', { status: 404 });
  const body = { SEP: TODAY.sep, CME: TODAY.cme, FLR: [], WSAEnlilSimulations: TODAY.enlil }[ep];
  return new Response(JSON.stringify(body));
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useAppStore.setState({ spaceWeather: initial });
});

async function renderWith(failing: string[]) {
  useAppStore.setState({ fetchDonki: donki(failing), now: () => new Date(TODAY.fetchedAt), spaceWeather: initial });
  await act(async () => root.render(<SpaceWeatherChip />));
  await act(async () => {
    await useAppStore.getState().checkSpaceWeather(true);
  });
  const button = host.querySelector('button')!;
  await act(async () => button.click());
  return button;
}

describe('SpaceWeatherChip no-data state (#80)', () => {
  it('a failed feed shows grey "no data" naming it, never "quiet"', async () => {
    const button = await renderWith(['FLR']);
    expect(button.textContent).toContain('Space weather: no data');
    expect(button.textContent).not.toContain('quiet');
    expect(button.style.background).toBe('rgb(95, 95, 95)');
    const panel = host.querySelector('[aria-label="Space weather"]')!.textContent!;
    expect(panel).toContain('no data from FLR');
    expect(panel).toContain("Can't confirm it's quiet");
  });

  it('every feed answering with no events shows quiet', async () => {
    const button = await renderWith([]);
    expect(button.textContent).toContain('Space weather: quiet');
    expect(host.querySelector('[aria-label="Space weather"]')!.textContent).not.toContain('no data');
  });
});
