import { CRS } from 'leaflet';
import type { LatLngBoundsExpression } from 'leaflet';
import { MapContainer } from 'react-leaflet';

/**
 * Grid-space map: CRS.Simple, so one Leaflet unit = one grid cell.
 * Leaflet's lat grows upward, so cell (x, y) sits at latlng [-y, x].
 * M05 adds the basemap overlay, habitat and stop pins.
 */
export const GRID_BOUNDS: LatLngBoundsExpression = [
  [-100, 0],
  [0, 100],
];

export function MapView() {
  return (
    <MapContainer
      crs={CRS.Simple}
      bounds={GRID_BOUNDS}
      minZoom={-2}
      maxZoom={4}
      zoomSnap={0.25}
      attributionControl={false}
      className="h-full w-full"
    />
  );
}
