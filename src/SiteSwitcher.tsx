import { useEffect, useId } from 'react';
import { useAppStore } from './store.ts';

/** Header site picker (M36). Switching reloads the grid, clears stops and route, keeps the settings. */
export function SiteSwitcher() {
  const sites = useAppStore((s) => s.sites);
  const siteId = useAppStore((s) => s.siteId);
  const loading = useAppStore((s) => s.data.status === 'loading');
  const loadSites = useAppStore((s) => s.loadSites);
  const setSite = useAppStore((s) => s.setSite);
  const id = useId();

  useEffect(() => {
    void loadSites();
  }, [loadSites]);

  const site = sites.find((s) => s.id === siteId);
  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="sr-only">
        EVA site
      </label>
      <select
        id={id}
        value={siteId}
        disabled={loading || sites.length < 2}
        onChange={(e) => void setSite(e.currentTarget.value)}
        title={site?.description}
        className="max-w-[14rem] rounded-md bg-white/5 px-2 py-1 disabled:opacity-60"
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id} className="bg-regolith">
            {s.name}
          </option>
        ))}
      </select>
      {site?.slopeOnly && (
        <span
          className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-white/80"
          title="No thermal inertia or mapped sand exists for this site, so walking cost comes from slope alone."
        >
          Slope-only cost
        </span>
      )}
    </div>
  );
}
