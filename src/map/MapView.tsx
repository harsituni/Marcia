import { useEffect, useMemo, useRef } from 'react';
import { CRS } from 'leaflet';
import type { LatLngBoundsLiteral, LeafletEventHandlerFnMap, Marker as LeafletMarker } from 'leaflet';
import { ImageOverlay, MapContainer, Marker, Popup, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { Stop } from '../contracts.ts';
import type { GridData } from '../data/grid.ts';
import { useAppStore } from '../store.ts';
import { cellToLatLng, gridBounds, latLngToCell } from './coords.ts';
import { habitatIcon, stopIcon } from './pins.ts';
import { RouteLayer, RouteLegend } from './RouteLayer.tsx';
import { LayerToggles, OverlayLayers } from './OverlayLayers.tsx';

/**
 * Grid-space map: CRS.Simple, so one Leaflet unit = one grid cell.
 * See coords.ts for the cell ↔ latlng mapping.
 */
export function MapView() {
  const data = useAppStore((s) => s.data);
  const route = useAppStore((s) => s.route);
  const notice = useAppStore((s) => s.notice);
  const editing = useAppStore((s) => s.mode === 'plan') && data.status === 'ready';

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
        {data.status === 'ready' && <OverlayLayers grid={data.grid} />}
        {route.status === 'ready' && <RouteLayer route={route.result} />}
        {data.status === 'ready' && <StopMarkers editable={editing} />}
        {editing && <AddStopOnClick />}
        <ResizeWithContainer bounds={data.status === 'ready' ? gridBounds(data.grid.meta) : null} />
      </MapContainer>
      {editing && (
        <p className="pointer-events-none absolute top-3 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-black/60 px-3 py-1.5 text-xs whitespace-nowrap">
          Click the map to add a stop · drag a pin to move it · click a pin to remove it
        </p>
      )}
      {notice && (
        <p role="status" className="absolute top-12 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-amber-900/90 px-3 py-1.5 text-sm">
          {notice}
        </p>
      )}
      {route.status === 'ready' && <RouteLegend />}
      {data.status === 'ready' && <LayerToggles />}
      {data.status !== 'ready' && (
        <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center">
          <p className="rounded-md bg-black/60 px-4 py-2 text-sm">
            {data.status === 'error' ? `Couldn't load map data: ${data.message}` : 'Loading map data…'}
          </p>
        </div>
      )}
      {route.status === 'error' && (
        <p className="absolute bottom-4 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-red-900/80 px-4 py-2 text-sm">
          Couldn't plan the route: {route.message}
        </p>
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
    </>
  );
}

const BLOCKED = "Can't put a stop there: too steep or outside the map.";

/** Clicking empty map adds a stop at the end of the route. */
function AddStopOnClick() {
  const addStop = useAppStore((s) => s.addStop);
  const showNotice = useAppStore((s) => s.showNotice);
  useMapEvents({
    click(e) {
      if (!addStop(latLngToCell(e.latlng.lat, e.latlng.lng))) showNotice(BLOCKED);
    },
  });
  return null;
}

function StopMarkers({ editable }: { editable: boolean }) {
  const stops = useAppStore((s) => s.stops);
  return (
    <>
      {stops.map((stop, i) => (
        // Keyed by number too: react-leaflet doesn't update `title` on an existing marker.
        <StopMarker key={`${stop.id}#${i}`} stop={stop} n={i + 1} editable={editable} />
      ))}
    </>
  );
}

function StopMarker({ stop, n, editable }: { stop: Stop; n: number; editable: boolean }) {
  const moveStop = useAppStore((s) => s.moveStop);
  const removeStop = useAppStore((s) => s.removeStop);
  const showNotice = useAppStore((s) => s.showNotice);

  const handlers = useMemo<LeafletEventHandlerFnMap>(
    () => ({
      dragend(e) {
        const marker = e.target as LeafletMarker;
        const { lat, lng } = marker.getLatLng();
        const cell = latLngToCell(lat, lng);
        const ok = moveStop(stop.id, cell);
        if (!ok) showNotice(BLOCKED);
        // Snap to the cell centre, or back to where it was.
        marker.setLatLng(cellToLatLng(ok ? cell : stop.cell));
      },
    }),
    [stop.id, stop.cell, moveStop, showNotice],
  );

  return (
    <Marker
      position={cellToLatLng(stop.cell)}
      icon={stopIcon(n)}
      title={`${n}. ${stop.name}`}
      draggable={editable}
      autoPan
      eventHandlers={handlers}
    >
      <Tooltip direction="top">
        <span className="font-semibold">
          {n}. {stop.name}
        </span>
        <br />
        {stop.geologyUnit} · science {'★'.repeat(stop.scienceValue)}
      </Tooltip>
      {editable && (
        <Popup closeButton={false} offset={[0, -10]}>
          <div className="flex items-center gap-3">
            <span className="font-semibold">
              {n}. {stop.name}
            </span>
            <button
              type="button"
              // Remove after the click finishes; removing the popup mid-click
              // lets the click fall through to the map and add a stop there.
              onClick={() => setTimeout(() => removeStop(stop.id), 0)}
              className="rounded bg-red-700 px-2 py-1 text-xs font-semibold text-white hover:bg-red-600"
            >
              Remove
            </button>
          </div>
        </Popup>
      )}
    </Marker>
  );
}

/**
 * Leaflet only tracks window resizes; this also catches layout changes (e.g.
 * the route panel opening). Until the user zooms or pans, it refits the grid
 * so the whole site stays in view.
 */
function ResizeWithContainer({ bounds }: { bounds: LatLngBoundsLiteral | null }) {
  const map = useMap();
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useEffect(() => {
    let userMoved = false;
    const el = map.getContainer();
    const mark = () => (userMoved = true);
    const events = ['pointerdown', 'wheel', 'keydown'] as const;
    events.forEach((e) => el.addEventListener(e, mark, { passive: true }));
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
      if (!userMoved && boundsRef.current) map.fitBounds(boundsRef.current, { padding: [16, 16] });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      events.forEach((e) => el.removeEventListener(e, mark));
    };
  }, [map]);
  return null;
}
