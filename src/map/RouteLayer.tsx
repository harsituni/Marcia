import { useMemo } from 'react';
import { Pane, Polyline } from 'react-leaflet';
import type { RouteResult } from '../contracts.ts';
import { cellToLatLng } from './coords.ts';
import { splitOutAndHome } from './route.ts';

const CASING = { color: '#1b1210', weight: 6, opacity: 0.55, lineCap: 'round', lineJoin: 'round' } as const;
const LINE = { color: '#ffffff', weight: 3, opacity: 0.95, lineCap: 'round', lineJoin: 'round' } as const;

/** Planned route: solid on the way out, dashed on the way home. */
export function RouteLayer({ route }: { route: RouteResult }) {
  const { out, home } = useMemo(() => {
    const parts = splitOutAndHome(route);
    return { out: parts.out.map(cellToLatLng), home: parts.home.map(cellToLatLng) };
  }, [route]);

  if (out.length < 2 && home.length < 2) return null;

  // Own pane between the basemap (overlayPane, z 400) and the pins (markerPane, z 600).
  return (
    <Pane name="route" style={{ zIndex: 450 }}>
      <Polyline positions={home} pathOptions={{ ...CASING, dashArray: '2 10' }} interactive={false} />
      <Polyline positions={home} pathOptions={{ ...LINE, dashArray: '2 10' }} interactive={false} />
      {out.length >= 2 && <Polyline positions={out} pathOptions={CASING} interactive={false} />}
      {out.length >= 2 && <Polyline positions={out} pathOptions={LINE} interactive={false} />}
    </Pane>
  );
}

/**
 * Small key for the two line styles. With a stop card open (top-left, `left-14 w-72`)
 * it moves just right of the card (3.5rem + 18rem + gap = 22rem), or to the bottom-right on phones, so both stay visible.
 */
export function RouteLegend({ besideCard = false }: { besideCard?: boolean }) {
  const place = besideCard
    ? 'top-3 left-[22rem] max-sm:top-auto max-sm:bottom-14 max-sm:left-auto max-sm:right-3'
    : 'top-[88px] left-[10px]';
  return (
    <div className={`pointer-events-none absolute ${place} z-[1000] rounded-md bg-black/60 px-3 py-2 text-xs`}>
      <div className="flex items-center gap-2">
        <svg width="28" height="6" aria-hidden="true">
          <line x1="2" y1="3" x2="26" y2="3" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        </svg>
        Way out
      </div>
      <div className="mt-1 flex items-center gap-2">
        <svg width="28" height="6" aria-hidden="true">
          <line x1="2" y1="3" x2="26" y2="3" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 6" />
        </svg>
        Way home
      </div>
    </div>
  );
}
