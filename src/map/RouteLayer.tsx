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
 * Small key for the two line styles. #83: drawn inside the Layers panel (not
 * floating over the map), so the panel, its legends and the stop card can't cover it.
 */
export function RouteLegend() {
  return (
    <div role="group" aria-label="Route key" className="mb-1 border-b border-white/10 pb-1">
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
