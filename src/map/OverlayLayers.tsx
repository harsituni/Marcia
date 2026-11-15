import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ImageOverlay, Pane, Polygon } from 'react-leaflet';
import type { GridData } from '../data/grid.ts';
import { MIN_ZONE_POINTS } from '../engine/avoid.ts';
import { DATA_ROOT, useAppStore } from '../store.ts';
import { siteDataUrl } from '../data/sites.ts';
import { GEOLOGY_FILES, loadGeologyLegend } from './geology.ts';
import type { GeologyLegend } from './geology.ts';
import { CRISM_FILES, loadCrismLegend } from './crism.ts';
import type { CrismLegend } from './crism.ts';
import type { LayerId } from '../store.ts';
import { cellToLatLng, gridBounds } from './coords.ts';
import { COLORS, classifyCost, difficultyPixels, overlayScale, sandPixels } from './overlays.ts';
import type { Pixels } from './overlays.ts';

/** The current site's geology legend, fetched once per site; null while loading or when the site has none. */
function useGeologyLegend(): { url: string; legend: GeologyLegend | null } {
  const siteId = useAppStore((s) => s.siteId);
  const url = siteDataUrl(DATA_ROOT, siteId);
  const [state, setState] = useState<{ url: string; legend: GeologyLegend | null }>({ url, legend: null });
  useEffect(() => {
    let live = true;
    void loadGeologyLegend(url).then((legend) => live && setState({ url, legend }));
    return () => {
      live = false;
    };
  }, [url]);
  return state.url === url ? state : { url, legend: null };
}

/** The current site's CRISM legend, fetched once per site; null while loading or when absent. */
function useCrismLegend(): { url: string; legend: CrismLegend | null } {
  const siteId = useAppStore((s) => s.siteId);
  const url = siteDataUrl(DATA_ROOT, siteId);
  const [state, setState] = useState<{ url: string; legend: CrismLegend | null }>({ url, legend: null });
  useEffect(() => {
    let live = true;
    void loadCrismLegend(url).then((legend) => live && setState({ url, legend }));
    return () => {
      live = false;
    };
  }, [url]);
  return state.url === url ? state : { url, legend: null };
}

function toDataUrl(p: Pixels): string {
  const canvas = document.createElement('canvas');
  canvas.width = p.width;
  canvas.height = p.height;
  canvas.getContext('2d')!.putImageData(new ImageData(p.data, p.width, p.height), 0, 0);
  return canvas.toDataURL();
}

/** Map overlays (inside the MapContainer). Between the basemap and the route. */
export function OverlayLayers({ grid }: { grid: GridData }) {
  const layers = useAppStore((s) => s.layers);
  const ring = useAppStore((s) => s.ring);
  // In Walk mode the ring is always on: it's the live turn-back line.
  const showRing = useAppStore((s) => s.layers.ring || s.mode === 'walk');
  const mode = useAppStore((s) => s.mode);
  const geology = useGeologyLegend();
  const crism = useCrismLegend();
  // M30: geology is a Plan-mode layer, drawn only for sites that have a geologic map.
  const showGeology = layers.geology && mode === 'plan' && geology.legend !== null;
  const showCrism = layers.crism && mode === 'plan' && crism.legend !== null;
  const { width, height } = grid.meta;
  const scale = overlayScale(width);
  const bounds = gridBounds(grid.meta);

  // Painted only while the layer is on.
  const difficultyUrl = useMemo(
    () => (layers.difficulty ? toDataUrl(difficultyPixels(classifyCost(grid.cost), width, height, scale)) : null),
    [grid.cost, width, height, scale, layers.difficulty],
  );
  const sandUrl = useMemo(
    () => (layers.sand ? toDataUrl(sandPixels(grid.sand, width, height, scale)) : null),
    [grid.sand, width, height, scale, layers.sand],
  );

  return (
    <Pane name="overlays" style={{ zIndex: 420 }}>
      {difficultyUrl && <ImageOverlay url={difficultyUrl} bounds={bounds} className="pixelated" />}
      {showGeology && <ImageOverlay url={`${geology.url}/${GEOLOGY_FILES.image}`} bounds={bounds} opacity={0.6} className="pixelated" />}
      {showCrism && <ImageOverlay url={`${crism.url}/${CRISM_FILES.image}`} bounds={bounds} opacity={0.6} className="pixelated" />}
      {sandUrl && <ImageOverlay url={sandUrl} bounds={bounds} className="pixelated" />}
      {showRing && ring && ring.polygon.length > 2 && (
        <Polygon
          positions={ring.polygon.map(cellToLatLng)}
          interactive={false}
          pathOptions={{ color: COLORS.easy, weight: 3, opacity: 0.95, fillColor: COLORS.easy, fillOpacity: 0.08, dashArray: '10 6' }}
        />
      )}
    </Pane>
  );
}

const LAYERS: { id: LayerId; label: string; swatch: ReactNode }[] = [
  {
    id: 'difficulty',
    label: 'Walking difficulty',
    swatch: (
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="h-3 w-3 rounded-sm" style={{ background: COLORS.easy }} />
        <span className="h-3 w-3 rounded-sm" style={{ background: COLORS.caution }} />
        <span className="hatch-nogo h-3 w-3 rounded-sm" />
      </span>
    ),
  },
  {
    id: 'sand',
    label: 'Soft sand',
    swatch: <span className="stipple-sand h-3 w-3 rounded-sm" aria-hidden="true" />,
  },
  {
    id: 'geology',
    label: 'Geology',
    swatch: (
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="h-3 w-3 rounded-sm" style={{ background: '#1b7837' }} />
        <span className="h-3 w-3 rounded-sm" style={{ background: '#fdb863' }} />
      </span>
    ),
  },
  {
    id: 'crism',
    label: 'CRISM minerals',
    swatch: (
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="h-3 w-3 rounded-sm" style={{ background: '#e76f51' }} />
        <span className="h-3 w-3 rounded-sm" style={{ background: '#2a9d8f' }} />
        <span className="h-3 w-3 rounded-sm" style={{ background: '#e9c46a' }} />
      </span>
    ),
  },
  {
    id: 'ring',
    label: 'Turn-back ring',
    swatch: <span className="h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: COLORS.easy }} aria-hidden="true" />,
  },
];

/** On/off switches for the overlays, with a key for the difficulty colours. */
/** M32: draw / finish / clear the crew's avoid zones. The router blocks every cell inside one and reroutes. */
export function AvoidZoneControls() {
  const zones = useAppStore((s) => s.avoidZones.length);
  const drawing = useAppStore((s) => s.drawingZone);
  const startZone = useAppStore((s) => s.startZone);
  const finishZone = useAppStore((s) => s.finishZone);
  const cancelZone = useAppStore((s) => s.cancelZone);
  const clearZones = useAppStore((s) => s.clearZones);
  const btn = 'rounded bg-white/10 px-2 py-0.5 hover:bg-white/20 disabled:opacity-40';
  return (
    <div role="group" aria-label="Avoid zones" className="mt-1 border-t border-white/10 pt-1">
      <p className="mb-1 flex items-center gap-1.5 font-semibold">
        <span className="h-3 w-3 rounded-sm border border-dashed" style={{ borderColor: COLORS.noGo, background: `${COLORS.noGo}40` }} aria-hidden="true" />
        Avoid zones{zones > 0 && <span className="font-normal text-white/60">({zones})</span>}
      </p>
      {drawing ? (
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={btn} disabled={drawing.length < MIN_ZONE_POINTS} onClick={() => finishZone()}>
            Finish ({drawing.length} pts)
          </button>
          <button type="button" className={btn} onClick={cancelZone}>
            Cancel
          </button>
          {drawing.length < MIN_ZONE_POINTS && <span className="text-white/60">Click {MIN_ZONE_POINTS - drawing.length} more</span>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={btn} onClick={startZone}>
            Draw zone
          </button>
          <button type="button" className={btn} disabled={zones === 0} onClick={clearZones}>
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

export function LayerToggles() {
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const mode = useAppStore((s) => s.mode);
  const geology = useGeologyLegend();
  const crism = useCrismLegend();
  const [openLegend, setOpenLegend] = useState<'geology' | 'crism' | null>(null);

  return (
    <fieldset className="absolute bottom-3 left-3 z-[1000] w-64 max-h-[45vh] overflow-y-auto rounded-lg bg-black/70 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
      <legend className="sr-only">Map layers</legend>
      <p className="mb-1 font-semibold" aria-hidden="true">
        Layers
      </p>
      {LAYERS.map((l) => (
        <label key={l.id} className="flex cursor-pointer items-center gap-2 py-0.5">
          <input
            type="checkbox"
            checked={layers[l.id]}
            onChange={() => {
              toggleLayer(l.id);
              if (layers[l.id] && (l.id === 'geology' || l.id === 'crism')) setOpenLegend(null);
            }}
            className="accent-mars"
          />
          <span className="flex-1">{l.label}</span>
          {l.swatch}
        </label>
      ))}
      {layers.geology && (
        <div className="mt-1 border-t border-white/10 pt-1 text-white/70">
          <button
            type="button"
            aria-expanded={openLegend === 'geology'}
            aria-controls="geology-legend"
            onClick={() => setOpenLegend((open) => (open === 'geology' ? null : 'geology'))}
            className="flex w-full items-center justify-between py-0.5 text-left font-medium"
          >
            Geology legend <span aria-hidden="true">{openLegend === 'geology' ? '▾' : '▸'}</span>
          </button>
          <div id="geology-legend" className="pt-1" hidden={openLegend !== 'geology'}>
            {mode !== 'plan' ? (
              <p>Geology shows in Plan mode</p>
            ) : geology.legend ? (
              <>
                <ul>
                  {geology.legend.units.map((u) => (
                    <li key={u.name} className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: u.color }} aria-hidden="true" />
                      {u.name}
                    </li>
                  ))}
                </ul>
                <p className="mt-0.5 text-[10px] text-white/50">{geology.legend.source}</p>
              </>
            ) : (
              <p>No geologic map for this site</p>
            )}
          </div>
        </div>
      )}
      {layers.crism && (
        <div className="mt-1 border-t border-white/10 pt-1 text-white/70">
          <button
            type="button"
            aria-expanded={openLegend === 'crism'}
            aria-controls="crism-legend"
            onClick={() => setOpenLegend((open) => (open === 'crism' ? null : 'crism'))}
            className="flex w-full items-center justify-between py-0.5 text-left font-medium"
          >
            CRISM legend <span aria-hidden="true">{openLegend === 'crism' ? '▾' : '▸'}</span>
          </button>
          <div id="crism-legend" className="pt-1" hidden={openLegend !== 'crism'}>
            {mode !== 'plan' ? (
              <p>CRISM minerals show in Plan mode</p>
            ) : crism.legend ? (
              <>
                <ul>
                  {crism.legend.categories.map((category) => (
                    <li key={category.name} className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: category.color }} aria-hidden="true" />
                      {category.name}
                    </li>
                  ))}
                </ul>
                <p className="mt-0.5 text-[10px] text-white/50">{crism.legend.note}</p>
                <p className="mt-0.5 break-all text-[10px] text-white/50">{crism.legend.source}</p>
              </>
            ) : (
              <p>No CRISM map for this site</p>
            )}
          </div>
        </div>
      )}
      {layers.difficulty && (
        <p className="mt-1 border-t border-white/10 pt-1 text-white/70">Blue easy · yellow caution · hatched no-go</p>
      )}
      <AvoidZoneControls />
    </fieldset>
  );
}
