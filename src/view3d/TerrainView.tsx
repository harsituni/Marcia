/**
 * Cesium 3D terrain view (M33). Offline: mesh from elevation.bin + basemap.png,
 * no Ion. Overlays habitat, stops, route and the walk marker from the store.
 *
 * Camera note: the mesh is built on a Mars-radius ellipsoid. The Viewer must
 * use that same ellipsoid (and keep a globe) so pan / zoom / orbit can pick a
 * surface. `globe: false` breaks ScreenSpaceCameraController.
 */
import { useEffect, useRef } from 'react';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ComponentDatatype,
  ConstantPositionProperty,
  Ellipsoid,
  EllipsoidTerrainProvider,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  GeometryPipeline,
  Globe,
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
import { MARS_RADIUS_M, cellToLonLat, displayHeight, elevationAt, minElevation } from './geo.ts';
import { buildTerrainMesh } from './mesh.ts';

const MARS = new Ellipsoid(MARS_RADIUS_M, MARS_RADIUS_M, MARS_RADIUS_M);

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
  return Cartesian3.fromDegrees(lon, lat, h, MARS);
}

export function TerrainView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const terrainRef = useRef<Primitive | null>(null);
  const overlaysRef = useRef<OverlayBag>({ stops: [] });
  const siteKeyRef = useRef<string>('');

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

    const prevDefault = Ellipsoid.default;
    Ellipsoid.default = MARS;

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
      baseLayer: false,
      globe: new Globe(MARS),
      terrainProvider: new EllipsoidTerrainProvider({ ellipsoid: MARS }),
      skyBox: false,
      skyAtmosphere: false,
      orderIndependentTranslucency: false,
      requestRenderMode: false,
      contextOptions: { webgl: { alpha: false } },
    });

    Ellipsoid.default = prevDefault;

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
    cam.minimumZoomDistance = 20;
    cam.maximumZoomDistance = 50_000;

    const ro = new ResizeObserver(() => {
      if (!viewer.isDestroyed()) {
        viewer.resize();
        viewer.scene.requestRender();
      }
    });
    ro.observe(el);

    viewerRef.current = viewer;
    // First paint after layout settles.
    requestAnimationFrame(() => {
      if (!viewer.isDestroyed()) viewer.resize();
    });

    return () => {
      ro.disconnect();
      terrainRef.current = null;
      overlaysRef.current = { stops: [] };
      siteKeyRef.current = '';
      viewerRef.current = null;
      if (!viewer.isDestroyed()) viewer.destroy();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !grid || !bounds) return;

    const siteKey = `${siteId}:${grid.basemapUrl}:${grid.meta.width}x${grid.meta.height}`;
    const firstForSite = siteKeyRef.current !== siteKey;
    siteKeyRef.current = siteKey;

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

    let geometry = new Geometry({
      attributes,
      indices: mesh.indices,
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromVertices(Array.from(positions)),
    });
    // MaterialAppearance's vertex shader expects normals.
    geometry = GeometryPipeline.computeNormal(geometry);

    const material = Material.fromType('Image', {
      image: grid.basemapUrl,
      repeat: new Cartesian2(1.0, 1.0),
    });

    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({ geometry }),
      appearance: new MaterialAppearance({
        material,
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
      const mid = Math.floor(mesh.lon.length / 2);
      const target = Cartesian3.fromDegrees(mesh.lon[mid]!, mesh.lat[mid]!, mesh.height[mid]!, MARS);
      const range = Math.max(grid.meta.width, grid.meta.height) * grid.meta.cellSizeM * 1.2;
      viewer.camera.flyToBoundingSphere(new BoundingSphere(target, range * 0.4), {
        duration: 0,
        offset: new HeadingPitchRange(0, CesiumMath.toRadians(-40), range),
      });
    }

    viewer.resize();
    viewer.scene.requestRender();
  }, [grid, bounds, siteId]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !grid || !bounds) return;

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
      const step = Math.max(1, Math.floor(routeResult.path.length / 800));
      const positions: Cartesian3[] = [];
      for (let i = 0; i < routeResult.path.length; i += step) {
        positions.push(cellCartesian(grid, bounds, routeResult.path[i]!, 6));
      }
      const last = routeResult.path[routeResult.path.length - 1]!;
      const lastPos = cellCartesian(grid, bounds, last, 6);
      if (positions.length === 0 || !Cartesian3.equals(positions[positions.length - 1]!, lastPos)) {
        positions.push(lastPos);
      }
      bag.route = viewer.entities.add({
        polyline: {
          positions,
          width: 4,
          material: Color.fromCssColorString('#56B4E9'),
        },
      });
    }

    viewer.scene.requestRender();
  }, [grid, bounds, stops, routeResult]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !grid || !bounds) return;
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
  }, [grid, bounds, walk, mode, routeResult, constraints.oxygenMin]);

  return (
    <div className="relative h-full min-h-0 w-full">
      {/* Not absolute: absolute children don't give the flex parent a height. */}
      <div ref={hostRef} className="cesium-host h-full min-h-0 w-full" aria-label="3D terrain view" />
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
        Left-drag orbit · right-drag pan · scroll zoom · 2D to edit stops
      </p>
    </div>
  );
}
