# Marcia

Mars EVA planning and walk guidance for Jezero and Gale craters.

**[Try Marcia](https://trymarcia.work/)** · Built for NASA Space Apps Challenge 2026, Interplanetary Survival Guide: Martian Map.

## Pitch

Marcia is a Mars EVA planning and walk-guidance app for Jezero and Gale craters.

1. **Plan (in the habitat).** The crew picks science stops on the map.
2. **Route.** Marcia plans a safe out-and-back walking route from the habitat
   through those stops. It uses NASA terrain, sand and hazard data to avoid
   steep slopes and soft ground.
3. **Walk.** Walk mode guides the crew on a helmet-style HUD. It shows oxygen
   margin and hazard alerts, plus a rover photo for each stop.

## Stack

- [Vite](https://vite.dev/) + [React](https://react.dev/) + TypeScript
- [Tailwind CSS](https://tailwindcss.com/) for styling
- [Leaflet](https://leafletjs.com/) (via react-leaflet) for the map
- [Zustand](https://zustand.docs.pmnd.rs/) for app state
- [Vitest](https://vitest.dev/) for tests
- Deploy: CI deploys `main` to GitHub Pages at **https://trymarcia.work/**
  (custom domain: `public/CNAME` plus the repo's Pages setting).

## Data sources

| Data | Use |
| --- | --- |
| HiRISE elevation + imagery | Slope / cost grid and basemap |
| THEMIS thermal inertia | Sand mask (soft ground to avoid) |
| CRISM minerals + USGS geology | Science layers |
| MEDA weather + RAD radiation | Conditions and dose |
| NASA DONKI space weather | Block or tighten the EVA during solar storms |
| CesiumJS 3D terrain | Optional perspective view of the EVA site |

### Space weather key

M35 reads NASA DONKI through `api.nasa.gov`. Set `VITE_NASA_API_KEY` (CI
passes the `NASA_API_KEY` repo secret); without it the app uses `DEMO_KEY`,
which allows only a few requests an hour. The key is compiled into the client
bundle, so anyone can read it. That is acceptable for a free NASA key.
If DONKI returns no data or is unreachable, the app shows a no-data state and planning still works.

### Runtime grid files

The file formats are defined in M01 (`src/contracts.ts`). The app loads each
site's files from `public/data/<id>/` (M36: `jezero`, the default, and
`gale`), listed in `public/data/sites.json`. Stop photos are in
`public/data/photos/`. Rebuild a site with the scripts and `--site <id>`; see
[data/raw/README.md](data/raw/README.md#sites-m36).

| File | Contents |
| --- | --- |
| `meta.json` | Grid size, cell size, max slope, habitat cell |
| `cost.bin` | Per-cell walking cost (blocked cells marked) |
| `elevation.bin` | Per-cell elevation |
| `sand.bin` | Per-cell sand mask |
| `basemap.png` | Map image aligned to the grid |
| `stops.json` | Candidate science stops |

`fixtures/` holds a small synthetic 100 × 100 grid in the same formats. Only
the tests use it.

## Team split

| Who | Track | Owns |
| --- | --- | --- |
| **Akileash** | Engine | Routing, grids, data export, alerts / replan |
| **Harsit** | UI | App shell, map, HUD, stop cards, layers |
| **Both** | Contract | Shared contracts (M01) and integration (M22) |

`src/contracts.ts` is the boundary between the two tracks. **Any change to
`contracts.ts` needs the other person's PR approval.**

## Run locally

```sh
npm ci              # install
npm run dev         # start the dev server
npm run build       # production build
npm test            # run the Vitest suite
npm run typecheck   # tsc --noEmit
```

## Built with

- [React](https://react.dev/), [Vite](https://vite.dev/) and [TypeScript](https://www.typescriptlang.org/)
- [CesiumJS](https://github.com/CesiumGS/cesium) for the 3D view, via [vite-plugin-cesium](https://github.com/nshen/vite-plugin-cesium)
- [Leaflet](https://leafletjs.com/) via [React-Leaflet](https://react-leaflet.js.org/) for the map
- [Zustand](https://github.com/pmndrs/zustand) for app state, [Tailwind CSS](https://tailwindcss.com/) for styling
- [Vitest](https://vitest.dev/) and [jsdom](https://github.com/jsdom/jsdom) for tests
- Terrain and imagery processed with [GDAL](https://gdal.org/) and [QGIS](https://qgis.org/)
- Hosted on [GitHub Pages](https://pages.github.com/), deployed with [GitHub Actions](https://github.com/features/actions)

## Data acknowledgements

Marcia uses NASA mission data (MRO HiRISE, Mars Odyssey THEMIS, MRO CRISM,
DONKI space weather, and Mars 2020 and MSL traverse data) plus published
research. Every source is credited in
[public/data/photos/CREDITS.md](public/data/photos/CREDITS.md) and in the
app's About panel.

## Use of AI

Marcia is our team's work. We came up with the concept, designed the EVA
planning and safety logic, chose and processed the NASA datasets, and made
every design decision. We used AI assistants as development tools for
research, coding and writing support. We reviewed, tested and verified all of
their output before it went into the project. Our logo was hand-designed as
SVG code with help from GitHub Copilot; it is vector code, not an
AI-generated image.
