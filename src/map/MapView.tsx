import { useEffect, useMemo, useRef, useState } from 'react';
import { CRS, latLngBounds } from 'leaflet';
import type { LatLngBoundsLiteral, LeafletEventHandlerFnMap, Marker as LeafletMarker } from 'leaflet';
import { CircleMarker, ImageOverlay, MapContainer, Marker, Polygon, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import type { Stop } from '../contracts.ts';
import type { GridData } from '../data/grid.ts';
import { useAppStore } from '../store.ts';
import { cellToLatLng, gridBounds, latLngToCell } from './coords.ts';
import { habitatIcon, stopIcon } from './pins.ts';
import { RouteLayer } from './RouteLayer.tsx';
import { LayerToggles, OverlayLayers, useCrismLegend, useGeologyLegend } from './OverlayLayers.tsx';
import { COLORS } from './overlays.ts';
import { GEOLOGY_FILES } from './geology.ts';
import { CRISM_FILES } from './crism.ts';
import { inspectSpot, loadPixelSampler, readingText } from './inspect.ts';
import type { PixelSampler, Reading, SamplePixel } from './inspect.ts';
import { WalkMarker } from './WalkMarker.tsx';

/**
 * Grid-space map: CRS.Simple, so one Leaflet unit = one grid cell.
 * See coords.ts for the cell ↔ latlng mapping.
 */
export function MapView() {
  const data = useAppStore((s) => s.data);
  const route = useAppStore((s) => s.route);
  const notice = useAppStore((s) => s.notice);
  const mode = useAppStore((s) => s.mode);
  const drawing = useAppStore((s) => s.drawingZone !== null);
  const inspecting = useAppStore((s) => s.inspecting);
  const setInspecting = useAppStore((s) => s.setInspecting);
  const editing = mode === 'plan' && data.status === 'ready';

  // Inspect only means something in Plan mode; leaving it turns the mode off.
  useEffect(() => {
    if (!editing && inspecting) setInspecting(false);
  }, [editing, inspecting, setInspecting]);

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
        {mode === 'plan' && <AvoidZonesLayer />}
        {route.status === 'ready' && <RouteLayer route={route.result} />}
        {data.status === 'ready' && <StopMarkers editable={editing} />}
        {editing && <AddStopOnClick />}
        {editing && <InspectToggle />}
        {mode === 'walk' && route.status === 'ready' && <WalkMarker route={route.result} />}
        <ResizeWithContainer bounds={data.status === 'ready' ? gridBounds(data.grid.meta) : null} />
      </MapContainer>
      {editing && (
        <p className="pointer-events-none absolute top-3 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-black/60 px-3 py-1.5 text-xs whitespace-nowrap">
          {drawing
            ? 'Click the map to add corners of the avoid zone · Finish when done'
            : inspecting
              ? 'Click the map to inspect a spot · Esc closes it'
              : 'Click the map to add a stop · drag a pin to move it · click a pin for details'}
        </p>
      )}
      {editing && data.status === 'ready' && <InspectPopup grid={data.grid} />}
      {notice && (
        <p role="status" className="absolute top-12 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-amber-900/90 px-3 py-1.5 text-sm">
          {notice}
        </p>
      )}
      {/* The HUD takes the corners in Walk mode; layers stay as set in Plan. */}
      {mode === 'plan' && data.status === 'ready' && <LayerToggles />}
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
    map.fitBounds(bounds, { padding: [16, 16], animate: false });
    // Pan limits come from the grid, not the current view (which may still be mid-fit).
    map.setMaxBounds(latLngBounds(bounds).pad(0.5));
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

/**
 * Clicking empty map adds a stop at the end of the route, or a zone corner while drawing an avoid zone (M32),
 * or opens the spot's details while Inspect is on (#91). The store decides which.
 */
function AddStopOnClick() {
  const mapClick = useAppStore((s) => s.mapClick);
  const showNotice = useAppStore((s) => s.showNotice);
  useMapEvents({
    click(e) {
      if (mapClick(latLngToCell(e.latlng.lat, e.latlng.lng)) === 'blocked') showNotice(BLOCKED);
    },
  });
  return null;
}

/** #91: the Inspect on/off button, top right of the map in Plan mode. */
export function InspectToggle() {
  const on = useAppStore((s) => s.inspecting);
  const setInspecting = useAppStore((s) => s.setInspecting);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => setInspecting(!on)}
      className={`absolute top-3 right-3 z-[1000] rounded-md px-3 py-1.5 text-xs shadow-lg backdrop-blur-sm ${
        on ? 'bg-mars text-white' : 'bg-black/70 text-white/90 hover:bg-black/85'
      }`}
    >
      Inspect
    </button>
  );
}

/** Decoded overlay image for `url`, or null while loading, when there is none, or for another grid size. */
function useSampler(url: string | null, gridWidth: number, gridHeight: number): PixelSampler | null {
  const [state, setState] = useState<{ key: string; sampler: PixelSampler | null } | null>(null);
  const key = url ? `${url}|${gridWidth}x${gridHeight}` : null;
  useEffect(() => {
    if (!url) return;
    const wanted = `${url}|${gridWidth}x${gridHeight}`;
    let live = true;
    void loadPixelSampler(url, gridWidth, gridHeight).then((sampler) => live && setState({ key: wanted, sampler }));
    return () => {
      live = false;
    };
  }, [url, gridWidth, gridHeight]);
  return key && state?.key === key ? state.sampler : null;
}

/** #91: details for the inspected cell: elevation, slope, geology and CRISM, each with its source. */
export function InspectPopup({ grid }: { grid: Pick<GridData, 'meta' | 'elevation'> }) {
  const cell = useAppStore((s) => s.inspectCell);
  const closeInspect = useAppStore((s) => s.closeInspect);
  const site = useAppStore((s) => s.sites.find((x) => x.id === s.siteId));
  const geology = useGeologyLegend();
  const crism = useCrismLegend();
  const { width, height } = grid.meta;
  const geologySampler = useSampler(geology.legend ? `${geology.url}/${GEOLOGY_FILES.image}` : null, width, height);
  const crismSampler = useSampler(crism.legend ? `${crism.url}/${CRISM_FILES.image}` : null, width, height);

  useEffect(() => {
    if (!cell) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeInspect();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cell, closeInspect]);

  if (!cell) return null;
  const samplePixel: SamplePixel = (layer, x, y) => (layer === 'geology' ? geologySampler : crismSampler)?.(x, y) ?? null;
  const spot = inspectSpot(grid, site, geology.legend, crism.legend, cell, samplePixel);

  return (
    <section
      role="dialog"
      aria-label="Spot details"
      className="absolute top-14 right-3 z-[1001] w-72 rounded-lg bg-black/85 p-3 text-sm shadow-xl backdrop-blur-sm"
    >
      <header className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Spot details</h2>
          <p className="text-xs text-white/60">
            Cell x {cell.x}, y {cell.y}
          </p>
        </div>
        <button
          type="button"
          onClick={closeInspect}
          aria-label="Close spot details"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-base leading-none hover:bg-white/20"
        >
          ×
        </button>
      </header>
      <dl className="space-y-2">
        <SpotRow label="Elevation" reading={spot.elevation} format={(v) => `${v.toFixed(1)} m`} />
        <SpotRow label="Slope" reading={spot.slope} format={(v) => `${v.toFixed(1)}°`} />
        <SpotRow label="Geology unit" reading={spot.geology} format={(v) => v} />
        <SpotRow label="CRISM mineral" reading={spot.crism} format={(v) => v} />
      </dl>
    </section>
  );
}

function SpotRow<T>({ label, reading, format }: { label: string; reading: Reading<T>; format: (value: T) => string }) {
  return (
    <div>
      <dt className="text-xs text-white/60">{label}</dt>
      <dd className={reading.value === null ? 'text-white/60 italic' : ''}>{readingText(reading, format)}</dd>
      <dd className="text-[10px] break-words text-white/50">Source: {reading.source}</dd>
    </div>
  );
}

const ZONE_STYLE = { color: COLORS.noGo, weight: 2, opacity: 0.95, fillColor: COLORS.noGo, fillOpacity: 0.25, dashArray: '6 4' };

/** Crew-drawn avoid zones, plus the one being drawn (M32). */
function AvoidZonesLayer() {
  const zones = useAppStore((s) => s.avoidZones);
  const drawing = useAppStore((s) => s.drawingZone);
  return (
    <>
      {zones.map((z, i) => (
        <Polygon key={i} positions={z.map(cellToLatLng)} pathOptions={ZONE_STYLE} interactive={false} />
      ))}
      {drawing && drawing.length > 1 && <Polyline positions={drawing.map(cellToLatLng)} pathOptions={{ ...ZONE_STYLE, fillOpacity: 0 }} interactive={false} />}
      {drawing?.map((c, i) => (
        <CircleMarker key={i} center={cellToLatLng(c)} radius={4} pathOptions={{ color: '#fff', weight: 1.5, fillColor: COLORS.noGo, fillOpacity: 1 }} interactive={false} />
      ))}
    </>
  );
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
  const selectStop = useAppStore((s) => s.selectStop);
  const selected = useAppStore((s) => s.selectedStopId === stop.id);
  // Dropped by a replan: stays on the map, greyed out.
  const dropped = useAppStore((s) => s.replanned?.droppedIds.includes(stop.id) ?? false);
  const showNotice = useAppStore((s) => s.showNotice);

  const handlers = useMemo<LeafletEventHandlerFnMap>(
    () => ({
      click() {
        selectStop(stop.id);
      },
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
    [stop.id, stop.cell, moveStop, showNotice, selectStop],
  );

  return (
    <Marker
      position={cellToLatLng(stop.cell)}
      icon={stopIcon(n, selected, dropped)}
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
      if (!userMoved && boundsRef.current) map.fitBounds(boundsRef.current, { padding: [16, 16], animate: false });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      events.forEach((e) => el.removeEventListener(e, mark));
    };
  }, [map]);
  return null;
}
