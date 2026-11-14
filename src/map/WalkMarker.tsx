import { useMemo } from 'react';
import { divIcon } from 'leaflet';
import { Marker } from 'react-leaflet';
import type { RouteResult } from '../contracts.ts';
import { useAppStore } from '../store.ts';
import { bearingDeg, positionAt } from '../walk/hud.ts';
import { cellToLatLng } from './coords.ts';

/** "You are here" arrow on the walk map, pointing along the route. */
export function WalkMarker({ route }: { route: RouteResult }) {
  const pathIdx = useAppStore((s) => s.walk?.pathIdx ?? 0);
  const last = route.path.length - 1;
  const position = positionAt(route.path, pathIdx);
  const ahead = positionAt(route.path, Math.min(pathIdx + 4, last));
  const behind = positionAt(route.path, Math.max(pathIdx - 4, 0));
  const moved = ahead.x !== position.x || ahead.y !== position.y;
  // Rounded so the icon is only rebuilt when the arrow visibly turns.
  const heading = Math.round((moved ? bearingDeg(position, ahead) : bearingDeg(behind, position)) / 5) * 5;

  const icon = useMemo(
    () =>
      divIcon({
        className: 'walker',
        html: `<svg viewBox="-14 -14 28 28" style="transform:rotate(${heading}deg)" aria-hidden="true"><path d="M0 -11 L8 9 L0 4.5 L-8 9 Z"/></svg>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      }),
    [heading],
  );

  if (last < 1) return null;
  return <Marker position={cellToLatLng(position)} icon={icon} interactive={false} keyboard={false} zIndexOffset={1000} />;
}
