import { useAppStore } from '../store.ts';
import type { MapKind } from '../store.ts';

const KINDS: { id: MapKind; label: string }[] = [
  { id: '2d', label: '2D' },
  { id: '3d', label: '3D' },
];

/** Switch between the Leaflet map and the Cesium terrain view (M33). */
export function ViewToggle() {
  const mapKind = useAppStore((s) => s.mapKind);
  const setMapKind = useAppStore((s) => s.setMapKind);

  return (
    <div role="tablist" aria-label="Map view" className="flex rounded-md bg-white/5 p-0.5 text-sm">
      {KINDS.map((k) => (
        <button
          key={k.id}
          type="button"
          role="tab"
          aria-selected={mapKind === k.id}
          onClick={() => setMapKind(k.id)}
          className={`rounded px-2.5 py-1 transition-colors ${
            mapKind === k.id ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white'
          }`}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
