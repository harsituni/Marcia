import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cellToLatLng, gridBounds, latLngToCell } from '../src/map/coords.ts';
import { useAppStore } from '../src/store.ts';

const FIX = join(import.meta.dirname, '..', 'fixtures');

describe('coords', () => {
  it('puts cell centres inside their cell and round-trips', () => {
    for (const c of [{ x: 0, y: 0 }, { x: 15, y: 15 }, { x: 99, y: 42 }]) {
      const [lat, lng] = cellToLatLng(c);
      expect(latLngToCell(lat, lng)).toEqual(c);
    }
  });

  it('maps row 0 to the top edge and the grid to its bounds', () => {
    expect(cellToLatLng({ x: 0, y: 0 })).toEqual([-0.5, 0.5]);
    expect(gridBounds({ width: 100, height: 60 })).toEqual([
      [-60, 0],
      [0, 100],
    ]);
  });
});

describe('loadData', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ data: { status: 'idle' } });
  });

  it('loads the fixtures over fetch', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const file = url.replace(/^\/fixtures\//, '');
      return new Response(readFileSync(join(FIX, file)));
    });
    await useAppStore.getState().loadData('/fixtures');
    const data = useAppStore.getState().data;
    expect(data.status).toBe('ready');
    if (data.status !== 'ready') return;
    expect(data.grid.stops).toHaveLength(4);
    expect(data.grid.meta.habitat).toEqual({ x: 15, y: 15 });
    expect(data.grid.basemapUrl).toBe('/fixtures/basemap.png');
  });

  it('reports a failed fetch', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 404 }));
    await useAppStore.getState().loadData('/missing');
    const data = useAppStore.getState().data;
    expect(data.status).toBe('error');
    if (data.status === 'error') expect(data.message).toMatch(/404/);
  });
});
