import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ImageOverlay, Pane, Polygon } from 'react-leaflet';
import type { GridData } from '../data/grid.ts';
import { MIN_ZONE_POINTS } from '../engine/avoid.ts';
import { VISIONS, colorFor, recolorPixels } from './colorblind.ts';
import type { Vision } from './colorblind.ts';
import { DATA_ROOT, useAppStore } from '../store.ts';
import { LAYER_UNAVAILABLE, siteDataUrl, siteHasLayer } from '../data/sites.ts';
import type { SiteLayer } from '../data/sites.ts';
import { GEOLOGY_FILES, loadGeologyLegend } from './geology.ts';
import type { GeologyLegend } from './geology.ts';
import { CRISM_FILES, loadCrismLegend } from './crism.ts';
import type { CrismLegend } from './crism.ts';
import type { LayerId } from '../store.ts';
import { cellToLatLng, gridBounds } from './coords.ts';
import { COLORS, classifyCost, difficultyPixels, overlayScale, sandPixels } from './overlays.ts';
import type { Pixels } from './overlays.ts';
import { RouteLegend } from './RouteLayer.tsx';

/** The current site's geology legend, fetched once per site; null while loading or when the site has none. */
/**
 * M34: `url` with its legend colours swapped for the crew's colour vision
 * (colorblind.ts SAFE_PALETTES). Normal vision gets `url` itself; otherwise
 * null until the recoloured copy is ready.
 */
function useVisionImage(url: string | null, items: readonly { name: string; color: string }[] | undefined): string | null {
  const vision = useAppStore((s) => s.colorVision);
  const key = `${url}|${vision}`;
  const [out, setOut] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!url || vision === 'normal' || !items) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      recolorPixels(pixels.data, items.map((i) => ({ from: i.color, to: colorFor(i.name, i.color, vision) })));
      ctx.putImageData(pixels, 0, 0);
      if (live) setOut({ key, url: canvas.toDataURL() });
    };
    img.src = url;
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!url || vision === 'normal') return url;
  return out?.key === key ? out.url : null;
}

/** True when the current site has data for `layer` (#82). */
export function useSiteHas(layer: SiteLayer): boolean {
  return useAppStore((s) => siteHasLayer(s.sites.find((x) => x.id === s.siteId), layer));
}

export function useGeologyLegend(): { url: string; legend: GeologyLegend | null } {
  const siteId = useAppStore((s) => s.siteId);
  const url = siteDataUrl(DATA_ROOT, siteId);
  // #82: a site without this layer never requests its file.
  const available = useSiteHas('geology');
  const [state, setState] = useState<{ url: string; legend: GeologyLegend | null }>({ url, legend: null });
  useEffect(() => {
    if (!available) return;
    let live = true;
    void loadGeologyLegend(url).then((legend) => live && setState({ url, legend }));
    return () => {
      live = false;
    };
  }, [url, available]);
  return available && state.url === url ? state : { url, legend: null };
}

/** The current site's CRISM legend, fetched once per site; null while loading or when absent. */
export function useCrismLegend(): { url: string; legend: CrismLegend | null } {
  const siteId = useAppStore((s) => s.siteId);
  const url = siteDataUrl(DATA_ROOT, siteId);
  // #82: a site without this layer never requests its file.
  const available = useSiteHas('crism');
  const [state, setState] = useState<{ url: string; legend: CrismLegend | null }>({ url, legend: null });
  useEffect(() => {
    if (!available) return;
    let live = true;
    void loadCrismLegend(url).then((legend) => live && setState({ url, legend }));
    return () => {
      live = false;
    };
  }, [url, available]);
  return available && state.url === url ? state : { url, legend: null };
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
  const geologyImage = useVisionImage(showGeology ? `${geology.url}/${GEOLOGY_FILES.image}` : null, geology.legend?.units);
  const crismImage = useVisionImage(showCrism ? `${crism.url}/${CRISM_FILES.image}` : null, crism.legend?.categories);
  const { width, height } = grid.meta;
  const scale = overlayScale(width);
  const bounds = gridBounds(grid.meta);

  // Painted only while the layer is on.
  const difficultyUrl = useMemo(
    () => (layers.difficulty ? toDataUrl(difficultyPixels(classifyCost(grid.cost), width, height, scale)) : null),
    [grid.cost, width, height, scale, layers.difficulty],
  );
  const hasSand = useSiteHas('sand');
  const sandUrl = useMemo(
    () => (layers.sand && hasSand ? toDataUrl(sandPixels(grid.sand, width, height, scale)) : null),
    [grid.sand, width, height, scale, layers.sand, hasSand],
  );

  return (
    <Pane name="overlays" style={{ zIndex: 420 }}>
      {difficultyUrl && <ImageOverlay url={difficultyUrl} bounds={bounds} className="pixelated" />}
      {geologyImage && <ImageOverlay url={geologyImage} bounds={bounds} opacity={0.6} className="pixelated" />}
      {crismImage && <ImageOverlay url={crismImage} bounds={bounds} opacity={0.6} className="pixelated" />}
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

const LAYERS: { id: LayerId; label: string; swatch: ReactNode | ((vision: Vision) => ReactNode) }[] = [
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
    swatch: (v) => (
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="h-3 w-3 rounded-sm" style={{ background: colorFor('Delta blocky', '#1b7837', v) }} />
        <span className="h-3 w-3 rounded-sm" style={{ background: colorFor('Aeolian bedforms, large', '#fdb863', v) }} />
      </span>
    ),
  },
  {
    id: 'crism',
    label: 'CRISM minerals',
    swatch: (v) => (
      <span className="flex gap-0.5" aria-hidden="true">
        <span className="h-3 w-3 rounded-sm" style={{ background: colorFor('Olivine and olivine mixtures', '#e76f51', v) }} />
        <span className="h-3 w-3 rounded-sm" style={{ background: colorFor('Smectites', '#2a9d8f', v) }} />
        <span className="h-3 w-3 rounded-sm" style={{ background: colorFor('Carbonates', '#e9c46a', v) }} />
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

/**
 * M34: the crew's colour vision. Anything but Normal swaps geology and CRISM
 * to colour-blind-safe colours (colorblind.ts SAFE_PALETTES).
 */
function ColorVisionControl() {
  const vision = useAppStore((s) => s.colorVision);
  const setVision = useAppStore((s) => s.setColorVision);
  return (
    <div className="mt-1 border-t border-white/10 pt-1">
      <label className="flex items-center gap-2">
        <span className="flex-1">Colour vision</span>
        <select value={vision} onChange={(e) => setVision(e.currentTarget.value as Vision)} className="rounded bg-white/10 px-1 py-0.5">
          {VISIONS.map((v) => (
            <option key={v} value={v} className="bg-regolith">
              {v === 'normal' ? 'Normal' : v[0]!.toUpperCase() + v.slice(1)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function LayerToggles() {
  const layers = useAppStore((s) => s.layers);
  const hasSand = useSiteHas('sand');
  const hasGeology = useSiteHas('geology');
  const hasCrism = useSiteHas('crism');
  const available: Record<LayerId, boolean> = { difficulty: true, ring: true, sand: hasSand, geology: hasGeology, crism: hasCrism };
  const vision = useAppStore((s) => s.colorVision);
  const toggleLayer = useAppStore((s) => s.toggleLayer);
  const routeReady = useAppStore((s) => s.route.status === 'ready');
  const mode = useAppStore((s) => s.mode);
  const geology = useGeologyLegend();
  const crism = useCrismLegend();
  const [openLegend, setOpenLegend] = useState<'geology' | 'crism' | null>(null);

  return (
    // #83: the one panel in the bottom-left column. It holds the route key, is wide enough that
    // long citations wrap instead of clipping, and stops below the zoom buttons; the stop card sits to its right.
    <fieldset className="absolute bottom-3 left-3 z-[1000] max-h-[calc(100%-6.5rem)] w-80 overflow-y-auto rounded-lg bg-black/70 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
      <legend className="sr-only">Map layers</legend>
      {routeReady && <RouteLegend />}
      <p className="mb-1 font-semibold" aria-hidden="true">
        Layers
      </p>
      {LAYERS.map((l) => (
        <label
          key={l.id}
          title={available[l.id] ? undefined : LAYER_UNAVAILABLE}
          className={`flex items-center gap-2 py-0.5 ${available[l.id] ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}
        >
          <input
            type="checkbox"
            checked={layers[l.id] && available[l.id]}
            disabled={!available[l.id]}
            onChange={() => {
              toggleLayer(l.id);
              if (layers[l.id] && (l.id === 'geology' || l.id === 'crism')) setOpenLegend(null);
            }}
            className="accent-mars"
          />
          <span className="flex-1">{l.label}</span>
          {typeof l.swatch === 'function' ? l.swatch(vision) : l.swatch}
        </label>
      ))}
      {layers.geology && available.geology && (
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
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorFor(u.name, u.color, vision) }} aria-hidden="true" />
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
      {layers.crism && available.crism && (
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
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colorFor(category.name, category.color, vision) }} aria-hidden="true" />
                      {category.name}
                    </li>
                  ))}
                </ul>
                <p className="mt-0.5 text-[10px] text-white/50">{crism.legend.note}</p>
                <p className="mt-0.5 text-[10px] break-words text-white/50">{crism.legend.source}</p>
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
      <ColorVisionControl />
    </fieldset>
  );
}
