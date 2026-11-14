# Marcia

Mars EVA planning and walk guidance for Jezero Crater.

## Pitch

Marcia is a Mars EVA planning and walk-guidance app for Jezero Crater.

1. **Plan (in the habitat).** The crew picks science stops on the map.
2. **Route.** Marcia plans a safe out-and-back walking route from the habitat
   through those stops. It uses NASA terrain, sand and hazard data to avoid
   steep slopes and soft ground.
3. **Walk.** Walk mode guides the crew on a helmet-style HUD. It shows oxygen
   margin and hazard alerts, plus a rover photo for each stop.

## Stack

Set up in M02:

- [Vite](https://vite.dev/) + [React](https://react.dev/) + TypeScript
- [Tailwind CSS](https://tailwindcss.com/) for styling
- [Leaflet](https://leafletjs.com/) (via react-leaflet) for the map
- [Zustand](https://zustand.docs.pmnd.rs/) for app state
- [Vitest](https://vitest.dev/) for tests
- Deploy: Vercel or GitHub Pages. CI currently deploys `main` to GitHub Pages.

## Data sources

| Data | Use | Milestone |
| --- | --- | --- |
| HiRISE elevation + imagery | Slope / cost grid and basemap | M06 |
| THEMIS thermal inertia | Sand mask (soft ground to avoid) | M12 |
| CRISM minerals + USGS geology | Science layers *(stretch)* | M30 |
| MEDA weather + RAD radiation | Conditions and dose *(stretch)* | M31 |

### Runtime grid files

The file formats are defined in M01 (`src/contracts.ts`). The files live in
`fixtures/` for now and will move to `public/data/` later.

| File | Contents |
| --- | --- |
| `meta.json` | Grid size, cell size, max slope, habitat cell |
| `cost.bin` | Per-cell walking cost (blocked cells marked) |
| `elevation.bin` | Per-cell elevation |
| `sand.bin` | Per-cell sand mask |
| `basemap.png` | Map image aligned to the grid |
| `stops.json` | Candidate science stops |

The current files are small synthetic fixtures. Real NASA-derived grids replace
them in M06 and M12.

## Team split

| Who | Track | Owns |
| --- | --- | --- |
| **Akileash** | Engine | Routing, grids, data export, alerts / replan |
| **Harsit** | UI | App shell, map, HUD, stop cards, layers |
| **Both** | Contract | Shared contracts (M01) and integration (M22) |

`src/contracts.ts` is the boundary between the two tracks. **Any change to
`contracts.ts` needs the other person's PR approval.**

## Local commands

```sh
npm test            # run the Vitest suite
npm run typecheck   # tsc --noEmit
```

## Working on milestones

Work is tracked as GitHub issues titled `Mxx · …`. Each milestone gets its own
branch (`mxx-short-name`) and a PR that closes its issue. AI coding agents must
follow [AGENTS.md](AGENTS.md).
