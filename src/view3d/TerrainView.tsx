/**
 * Cesium 3D terrain view (M33). Offline: mesh from elevation.bin + basemap.png,
 * no Ion. Overlays habitat, stops, route and the walk marker from the store.
 */
import { useEffect, useRef } from 'react';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ComponentDatatype,
  Ellipsoid,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
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
import { useAppStore } from '../store.ts';
import { positionAt } from '../walk/hud.ts';
import { MARS_RADIUS_M, cellToLonLat, displayHeight, elevationAt, minElevation } from './geo.ts';
import { buildTerrainMesh } from './mesh.ts';

const MARS = new Ellipsoid(MARS_RADIUS_M, MARS_RADIUS_M, MARS_RADIUS_M);

interface OverlayBag {
  habitat?: Entity;
  stops: Entity[];
  route?: Entity;
  walk?: Entity;
}

export function TerrainView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const terrainRef = useRef<Primitive | null>(null);
  const overlaysRef = useRef<OverlayBag>({ stops: [] });

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

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const viewer = new Viewer(el, {
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
      globe: false,
      skyBox: false,
      skyAtmosphere: false,
      orderIndependentTranslucency: false,
      contextOptions: { webgl: { alpha: true } },
    });
    viewer.scene.backgroundColor = Color.fromCssColorString('#1b1210');
    if (viewer.scene.sun) viewer.scene.sun.show = false;
    if (viewer.scene.moon) viewer.scene.moon.show = false;
    // Credit container still shows Cesium's; fine for attribution.
    viewerRef.current = viewer;
    return () => {
      terrainRef.current = null;
      overlaysRef.current = { stops: [] };
      viewerRef.current = null;
      if (!viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !grid || !bounds) return;
    let cancelled = false;

    const prev = terrainRef.current;
    if (prev && !prev.isDestroyed()) {
      viewer.scene.primitives.remove(prev);
      terrainRef.current = null;
    }

    const mesh = buildTerrainMesh(grid.elevation, grid.meta, bounds);
    const positions = new Float64Array(mesh.lon.length * 3);
    const sts = new Float32Array(mesh.lon.length * 2);
    const carto = new Cartographic();
    const cart = new Cartesian3();
    for (let i = 0; i < mesh.lon.length; i++) {
      carto.longitude = CesiumMath.toRadians(mesh.lon[i]!);
      carto.latitude = CesiumMath.toRadians(mesh.lat[i]!);
      carto.height = mesh.height[i]!;
      MARS.cartographicToCartesian(carto, cart);
      positions[i * 3] = cart.x;
      positions[i * 3 + 1] = cart.y;
      positions[i * 3 + 2] = cart.z;
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

    const geometry = new Geometry({
      attributes,
      indices: mesh.indices,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromVertices(Array.from(positions)),
    });

    const material = Material.fromType('Image', { image: grid.basemapUrl });
    if (cancelled || viewer.isDestroyed()) return;

    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({ geometry }),
      appearance: new MaterialAppearance({
        material,
        flat: true,
        translucent: false,
        faceForward: true,
      }),
      asynchronous: false,
      allowPicking: false,
    });
    viewer.scene.primitives.add(primitive);
    terrainRef.current = primitive;

    const mid = Math.floor(mesh.lon.length / 2);
    const target = Cartesian3.fromDegrees(mesh.lon[mid]!, mesh.lat[mid]!, mesh.height[mid]!, MARS);
    const range = Math.max(grid.meta.width, grid.meta.height) * grid.meta.cellSizeM * 1.35;
    viewer.camera.flyToBoundingSphere(new BoundingSphere(target, range * 0.35), {
      duration: 0,
      offset: new HeadingPitchRange(0, CesiumMath.toRadians(-45), range),
    });

    return () => {
      cancelled = true;
    };
  }, [grid, bounds]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !grid || !bounds) return;

    const bag = overlaysRef.current;
    for (const e of bag.stops) viewer.entities.remove(e);
    if (bag.habitat) viewer.entities.remove(bag.habitat);
    if (bag.route) viewer.entities.remove(bag.route);
    if (bag.walk) viewer.entities.remove(bag.walk);
    bag.stops = [];
    bag.habitat = undefined;
    bag.route = undefined;
    bag.walk = undefined;

    const minElev = minElevation(grid.elevation);
    const toCartesian = (cell: Cell, bump = 8) => {
      const { lon, lat } = cellToLonLat(cell, grid.meta, bounds);
      const elev = elevationAt(grid.elevation, grid.meta, cell.x, cell.y);
      const h = displayHeight(Number.isFinite(elev) ? elev : minElev, minElev) + bump;
      return Cartesian3.fromDegrees(lon, lat, h, MARS);
    };

    bag.habitat = viewer.entities.add({
      position: toCartesian(grid.meta.habitat, 12),
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
        position: toCartesian(stop.cell, 12),
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
      bag.route = viewer.entities.add({
        polyline: {
          positions: routeResult.path.map((c) => toCartesian(c, 6)),
          width: 4,
          material: Color.fromCssColorString('#56B4E9'),
        },
      });
    }

    if (mode === 'walk' && routeResult && routeResult.path.length > 0) {
      const w = walk ?? { pathIdx: 0, oxygenLeftMin: constraints.oxygenMin };
      bag.walk = viewer.entities.add({
        position: toCartesian(positionAt(routeResult.path, w.pathIdx), 16),
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
    }
  }, [grid, bounds, stops, routeResult, walk, mode, constraints.oxygenMin]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="cesium-host h-full w-full" aria-label="3D terrain view" />
      {(!grid || !bounds) && (
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
      <p className="pointer-events-none absolute bottom-3 left-1/2 z-[1000] -translate-x-1/2 rounded-md bg-black/60 px-3 py-1.5 text-xs whitespace-nowrap">
        Drag to orbit · scroll to zoom · switch to 2D to edit stops
      </p>
    </div>
  );
}
