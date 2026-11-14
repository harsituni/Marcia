import { useEffect } from 'react';
import { CRS } from 'leaflet';
import { ImageOverlay, MapContainer, Marker, Tooltip, useMap } from 'react-leaflet';
import type { GridData } from '../data/grid.ts';
import { useAppStore } from '../store.ts';
import { cellToLatLng, gridBounds } from './coords.ts';
import { habitatIcon, stopIcon } from './pins.ts';

/**
 * Grid-space map: CRS.Simple, so one Leaflet unit = one grid cell.
 * See coords.ts for the cell ↔ latlng mapping.
 */
export function MapView() {
  const data = useAppStore((s) => s.data);

  return (
    <>
      <MapContainer
        crs={CRS.Simple}
        bounds={gridBounds({ width: 100, height: 100 })}
        minZoom={-3}
        maxZoom={5}
        zoomSnap={0.25}
        attributionControl={false}
        className="h-full w-full"
      >
        {data.status === 'ready' && <GridLayers grid={data.grid} />}
      </MapContainer>
      {data.status !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center">
          <p className="rounded-md bg-black/60 px-4 py-2 text-sm">
            {data.status === 'error' ? `Couldn't load map data: ${data.message}` : 'Loading map data…'}
          </p>
        </div>
      )}
    </>
  );
}

function GridLayers({ grid }: { grid: GridData }) {
  const map = useMap();
  const bounds = gridBounds(grid.meta);

  useEffect(() => {
    map.fitBounds(bounds, { padding: [16, 16] });
    map.setMaxBounds(map.getBounds().pad(0.5));
    // Refit only when the grid size changes, not on every render.
  }, [map, grid.meta.width, grid.meta.height]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <ImageOverlay url={grid.basemapUrl} bounds={bounds} />
      <Marker position={cellToLatLng(grid.meta.habitat)} icon={habitatIcon} keyboard={false}>
        <Tooltip direction="top">Habitat</Tooltip>
      </Marker>
      {grid.stops.map((stop, i) => (
        <Marker key={stop.id} position={cellToLatLng(stop.cell)} icon={stopIcon(i + 1)} title={`${i + 1}. ${stop.name}`}>
          <Tooltip direction="top">
            <span className="font-semibold">
              {i + 1}. {stop.name}
            </span>
            <br />
            {stop.geologyUnit} · science {'★'.repeat(stop.scienceValue)}
          </Tooltip>
        </Marker>
      ))}
    </>
  );
}
