import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ImageOverlay, Pane, Polygon } from 'react-leaflet';
import type { GridData } from '../data/grid.ts';
import { DATA_ROOT, useAppStore } from '../store.ts';
import { siteDataUrl } from '../data/sites.ts';
import { GEOLOGY_FILES, loadGeologyLegend } from './geology.ts';
import type { GeologyLegend } from './geology.ts';
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
  // M30: geology is a Plan-mode layer, drawn only for sites that have a geologic map.
  const showGeology = layers.geology && mode === 'plan' && geology.legend !== null;
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
    id: 'ring',
    label: 'Turn-back ring',
    swatch: <span className="h-3 w-3 rounded-full border-2 border-dashed" style={{ borderColor: COLORS.easy }} aria-hidden="true" />,
  },
];

/** On/off switches for the overlays, with a key for the difficulty colours. */
export function LayerToggles() {
  const layers = useAppStore((s) => s.layers);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const mode = useAppStore((s) => s.mode);
  const geology = useGeologyLegend();

  return (
    <fieldset className="absolute bottom-3 left-3 z-[1000] rounded-lg bg-black/70 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
      <legend className="sr-only">Map layers</legend>
      <p className="mb-1 font-semibold" aria-hidden="true">
        Layers
      </p>
      {LAYERS.map((l) => (
        <label key={l.id} className="flex cursor-pointer items-center gap-2 py-0.5">
          <input type="checkbox" checked={layers[l.id]} onChange={() => toggleLayer(l.id)} className="accent-mars" />
          <span className="flex-1">{l.label}</span>
          {l.swatch}
        </label>
      ))}
      {layers.geology && (
        <div className="mt-1 max-h-40 overflow-y-auto border-t border-white/10 pt-1 text-white/70">
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
      )}
      {layers.difficulty && (
        <p className="mt-1 border-t border-white/10 pt-1 text-white/70">Blue easy · yellow caution · hatched no-go</p>
      )}
    </fieldset>
  );
}
