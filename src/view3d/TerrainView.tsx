/**
 * Cesium 3D terrain view (M33). Offline mesh from elevation.bin + basemap.png.
 *
 * Uses the default WGS84 ellipsoid (Mars lon/lat still look right for a 3 km
 * site) so ScreenSpaceCameraController pan/zoom/orbit work. A Mars-radius
 * globe mismatched the default camera and broke interaction.
 *
 * React StrictMode mounts effects twice in dev: we put each Viewer in a fresh
 * child div and re-run mesh/overlays when the viewer generation changes.
 */
import { useEffect, useRef, useState } from 'react';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  ComponentDatatype,
  ConstantPositionProperty,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  GeometryPipeline,
  HeadingPitchRange,
  HorizontalOrigin,
  LabelStyle,
  Material,
  MaterialAppearance,
  Math as CesiumMath,
  NearFarScalar,
  Primitive,
  PrimitiveType,
  VerticalOrigin,
  Viewer,
} from 'cesium';
import type { Entity } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { Cell } from '../contracts.ts';
import type { GridData } from '../data/grid.ts';
import type { SiteBounds } from '../data/sites.ts';
import { useAppStore } from '../store.ts';
import { positionAt } from '../walk/hud.ts';
import { cellToLonLat, displayHeight, elevationAt, minElevation } from './geo.ts';
import { buildTerrainMesh } from './mesh.ts';

interface OverlayBag {
  habitat?: Entity;
  stops: Entity[];
  route?: Entity;
  walk?: Entity;
}

function cellCartesian(grid: GridData, bounds: SiteBounds, cell: Cell, bump: number): Cartesian3 {
  const minElev = minElevation(grid.elevation);
  const { lon, lat } = cellToLonLat(cell, grid.meta, bounds);
  const elev = elevationAt(grid.elevation, grid.meta, cell.x, cell.y);
  const h = displayHeight(Number.isFinite(elev) ? elev : minElev, minElev) + bump;
  return Cartesian3.fromDegrees(lon, lat, h);
}

export function TerrainView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const terrainRef = useRef<Primitive | null>(null);
  const overlaysRef = useRef<OverlayBag>({ stops: [] });
  const siteKeyRef = useRef<string>('');
  /** Bumps when a Viewer is (re)created so mesh/overlays attach to the live one. */
  const [viewerGen, setViewerGen] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const data = useAppStore((s) => s.data);
  const sites = useAppStore((s) => s.sites);
  const siteId = useAppStore((s) => s.siteId);
  const stops = useAppStore((s) => s.stops);
  const route = useAppStore((s) => s.route);
  const walk = useAppStore((s) => s.walk);
  const mode = useAppStore((s) => s.mode);
  const constraints = useAppStore((s) => s.constraints);

  const bounds = sites.find((s) => s.id === siteId)?.bounds ?? null;
  const grid = data.status === 'ready' ? data.grid : null;
  const routeResult = route.status === 'ready' ? route.result : null;

  // Create / destroy the Viewer. Fresh child div each time (StrictMode-safe).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    host.appendChild(container);

    let viewer: Viewer;
    try {
      viewer = new Viewer(container, {
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        baseLayer: false,
        skyBox: false,
        skyAtmosphere: false,
        orderIndependentTranslucency: false,
        requestRenderMode: false,
        contextOptions: { webgl: { alpha: false } },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      container.remove();
      return;
    }

    viewer.scene.backgroundColor = Color.fromCssColorString('#1b1210');
    viewer.scene.globe.baseColor = Color.fromCssColorString('#1b1210');
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.globe.enableLighting = false;
    viewer.scene.globe.depthTestAgainstTerrain = false;
    if (viewer.scene.sun) viewer.scene.sun.show = false;
    if (viewer.scene.moon) viewer.scene.moon.show = false;
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;

    const cam = viewer.scene.screenSpaceCameraController;
    cam.enableRotate = true;
    cam.enableTranslate = true;
    cam.enableZoom = true;
    cam.enableTilt = true;
    cam.enableLook = true;
    cam.enableCollisionDetection = false;
    cam.minimumZoomDistance = 50;
    cam.maximumZoomDistance = 80_000;

    const ro = new ResizeObserver(() => {
      if (!viewer.isDestroyed()) {
        viewer.resize();
        viewer.scene.requestRender();
      }
    });
    ro.observe(host);

    viewerRef.current = viewer;
    terrainRef.current = null;
    overlaysRef.current = { stops: [] };
    siteKeyRef.current = '';
    setError(null);
    setViewerGen((g) => g + 1);

    requestAnimationFrame(() => {
      if (!viewer.isDestroyed()) viewer.resize();
    });

    return () => {
      ro.disconnect();
      viewerRef.current = null;
      terrainRef.current = null;
      overlaysRef.current = { stops: [] };
      try {
        if (!viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore double-destroy */
      }
      container.remove();
    };
  }, []);

  // Terrain mesh — re-runs when the viewer is recreated.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !viewerGen || !grid || !bounds) return;

    const siteKey = `${siteId}:${grid.basemapUrl}:${grid.meta.width}x${grid.meta.height}`;
    const firstForSite = siteKeyRef.current !== siteKey;
    siteKeyRef.current = siteKey;

    try {
      const prev = terrainRef.current;
      if (prev && !prev.isDestroyed()) {
        viewer.scene.primitives.remove(prev);
      }
      terrainRef.current = null;

      const mesh = buildTerrainMesh(grid.elevation, grid.meta, bounds, { maxAxis: 120 });
      const n = mesh.lon.length;
      const positions = new Float64Array(n * 3);
      const sts = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        const c = Cartesian3.fromDegrees(mesh.lon[i]!, mesh.lat[i]!, mesh.height[i]!);
        positions[i * 3] = c.x;
        positions[i * 3 + 1] = c.y;
        positions[i * 3 + 2] = c.z;
        sts[i * 2] = mesh.u[i]!;
        sts[i * 2 + 1] = 1 - mesh.v[i]!;
      }

      const attributes = new GeometryAttributes();
      attributes.position = new GeometryAttribute({
        componentDatatype: ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      });
      attributes.st = new GeometryAttribute({
        componentDatatype: ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: sts,
      });

      let geometry = new Geometry({
        attributes,
        indices: mesh.indices,
        primitiveType: PrimitiveType.TRIANGLES,
        boundingSphere: BoundingSphere.fromVertices(positions as unknown as number[]),
      });
      geometry = GeometryPipeline.computeNormal(geometry);

      const primitive = new Primitive({
        geometryInstances: new GeometryInstance({ geometry }),
        appearance: new MaterialAppearance({
          material: Material.fromType('Image', { image: grid.basemapUrl }),
          flat: true,
          translucent: false,
          faceForward: true,
          materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
        }),
        asynchronous: false,
        allowPicking: false,
        compressVertices: false,
      });
      viewer.scene.primitives.add(primitive);
      terrainRef.current = primitive;

      if (firstForSite) {
        const mid = Math.floor(n / 2);
        const target = Cartesian3.fromDegrees(mesh.lon[mid]!, mesh.lat[mid]!, mesh.height[mid]!);
        const range = Math.max(grid.meta.width, grid.meta.height) * grid.meta.cellSizeM * 1.25;
        viewer.camera.flyToBoundingSphere(new BoundingSphere(target, range * 0.35), {
          duration: 0,
          offset: new HeadingPitchRange(CesiumMath.toRadians(30), CesiumMath.toRadians(-40), range),
        });
      }

      viewer.resize();
      viewer.scene.requestRender();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [grid, bounds, siteId, viewerGen]);

  // Habitat, stops, route.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !viewerGen || !grid || !bounds) return;

    const bag = overlaysRef.current;
    for (const e of bag.stops) viewer.entities.remove(e);
    if (bag.habitat) viewer.entities.remove(bag.habitat);
    if (bag.route) viewer.entities.remove(bag.route);
    bag.stops = [];
    bag.habitat = undefined;
    bag.route = undefined;

    bag.habitat = viewer.entities.add({
      position: cellCartesian(grid, bounds, grid.meta.habitat, 12),
      point: {
        pixelSize: 14,
        color: Color.fromCssColorString('#f5ede8'),
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(500, 1.2, 8000, 0.6),
      },
      label: {
        text: 'Habitat',
        font: '12px sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        horizontalOrigin: HorizontalOrigin.CENTER,
        pixelOffset: new Cartesian2(0, -14),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    bag.stops = stops.map((stop, i) =>
      viewer.entities.add({
        position: cellCartesian(grid, bounds, stop.cell, 12),
        point: {
          pixelSize: 12,
          color: Color.fromCssColorString('#c1440e'),
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: String(i + 1),
          font: 'bold 12px sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.CENTER,
          horizontalOrigin: HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );

    if (routeResult && routeResult.path.length > 1) {
      const step = Math.max(1, Math.floor(routeResult.path.length / 600));
      const positions: Cartesian3[] = [];
      for (let i = 0; i < routeResult.path.length; i += step) {
        positions.push(cellCartesian(grid, bounds, routeResult.path[i]!, 6));
      }
      const last = cellCartesian(grid, bounds, routeResult.path[routeResult.path.length - 1]!, 6);
      if (positions.length === 0 || !Cartesian3.equals(positions[positions.length - 1]!, last)) positions.push(last);
      bag.route = viewer.entities.add({
        polyline: {
          positions,
          width: 4,
          material: Color.fromCssColorString('#56B4E9'),
        },
      });
    }

    viewer.scene.requestRender();
  }, [grid, bounds, stops, routeResult, viewerGen]);

  // Walk marker.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !viewerGen || !grid || !bounds) return;
    const bag = overlaysRef.current;

    if (mode !== 'walk' || !routeResult || routeResult.path.length === 0) {
      if (bag.walk) {
        viewer.entities.remove(bag.walk);
        bag.walk = undefined;
      }
      return;
    }

    const w = walk ?? { pathIdx: 0, oxygenLeftMin: constraints.oxygenMin };
    const pos = cellCartesian(grid, bounds, positionAt(routeResult.path, w.pathIdx), 16);

    if (!bag.walk) {
      bag.walk = viewer.entities.add({
        position: pos,
        point: {
          pixelSize: 16,
          color: Color.fromCssColorString('#F0E442'),
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: 'You',
          font: '11px sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } else {
      bag.walk.position = new ConstantPositionProperty(pos);
    }
    viewer.scene.requestRender();
  }, [grid, bounds, walk, mode, routeResult, constraints.oxygenMin, viewerGen]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={hostRef} className="cesium-host h-full min-h-0 w-full" aria-label="3D terrain view" />
      {error && (
        <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4">
          <p className="max-w-md rounded-md bg-red-900/90 px-4 py-3 text-sm">
            3D view failed: {error}
          </p>
        </div>
      )}
      {!error && (!grid || !bounds) && (
        <div className="pointer-events-none absolute inset-0 z-[1000] flex items-center justify-center">
          <p className="rounded-md bg-black/60 px-4 py-2 text-sm">
            {data.status === 'error'
              ? `Couldn't load map data: ${data.message}`
              : !bounds
                ? 'This site has no lon/lat bounds for 3D yet.'
                : 'Loading map data…'}
          </p>
        </div>
      )}
      {!error && (
        <p className="pointer-events-none absolute bottom-3 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-black/60 px-3 py-1.5 text-xs whitespace-nowrap">
          Left-drag orbit · right-drag pan · scroll zoom · 2D to edit stops
        </p>
      )}
    </div>
  );
}
