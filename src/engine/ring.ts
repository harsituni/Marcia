/**
 * Turn-back ring (M18).
 *
 * `HomeField` runs one Dijkstra from the habitat over the cost grid, with the
 * same edges as `AStar` (8 directions; step 1 or √2 cells × cellSizeM × the
 * mean of the two cells' cost; Infinity blocked; no corner cutting). Costs are
 * symmetric, so the cheapest path habitat → cell is also the cheapest path
 * cell → habitat. For every cell it stores `homeMinutes`: the walking time
 * home along that cheapest path, using the flat-ground estimate constants in
 * `model.ts` (path length ÷ `WALK_SPEED_M_PER_MIN`, like the route stats).
 *
 * The ring for an oxygen budget is the set of cells you can still get home
 * from: `homeMinutes × OXYGEN_MIN_PER_MIN ≤ oxygenLeftMin`. `ringPolygon`
 * traces that region's outer edge (along cell borders) into a closed polygon
 * of at most `maxPoints` vertices. Blocked islands fully inside the region
 * are holes in the mask but sit inside the single outline (a `RingResult` is
 * one polygon).
 */
import type { Cell, GridMeta, RingResult } from '../contracts.ts';
import { MinHeap } from './heap.ts';
import { OXYGEN_MIN_PER_MIN, WALK_SPEED_M_PER_MIN } from './model.ts';

const SQRT2 = Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const DY = [0, 0, 1, -1, 1, -1, 1, -1] as const;

/** Single-source Dijkstra field from `source` (normally the habitat). */
export class HomeField {
  readonly width: number;
  readonly height: number;
  /** Source cell, rounded to whole cells. */
  readonly source: Cell;
  /** Walking minutes home from each cell along its cheapest path; Infinity if unreachable. */
  readonly homeMinutes: Float32Array;

  constructor(meta: Pick<GridMeta, 'width' | 'height' | 'cellSizeM'>, cost: Float32Array, source: Cell) {
    const W = meta.width;
    const H = meta.height;
    const n = W * H;
    if (cost.length !== n) throw new Error(`cost has ${cost.length} cells, expected ${n}`);
    this.width = W;
    this.height = H;
    this.source = { x: Math.round(source.x), y: Math.round(source.y) };
    this.homeMinutes = new Float32Array(n).fill(Infinity);

    const { x: sx, y: sy } = this.source;
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
    const s = sy * W + sx;
    if (!Number.isFinite(cost[s]!)) return;

    const cell = meta.cellSizeM;
    const dist = new Float64Array(n).fill(Infinity); // cost-weighted metres (the Dijkstra key)
    const lenM = new Float64Array(n); // path length in metres along the chosen path
    const done = new Uint8Array(n);
    const heap = new MinHeap(1 << 16);
    dist[s] = 0;
    heap.push(s, 0);
    while (heap.size > 0) {
      const cur = heap.pop();
      if (done[cur]) continue;
      done[cur] = 1;
      const cx = cur % W;
      const cy = (cur - cx) / W;
      const dCur = dist[cur]!;
      const cCur = cost[cur]!;
      for (let d = 0; d < 8; d++) {
        const dx = DX[d]!;
        const dy = DY[d]!;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (done[ni]) continue;
        const cN = cost[ni]!;
        if (cN === Infinity) continue;
        let step = cell;
        if (dx !== 0 && dy !== 0) {
          if (cost[cy * W + nx] === Infinity || cost[ny * W + cx] === Infinity) continue;
          step = cell * SQRT2;
        }
        const nd = dCur + step * 0.5 * (cCur + cN);
        if (nd < dist[ni]!) {
          dist[ni] = nd;
          lenM[ni] = lenM[cur]! + step;
          heap.push(ni, nd);
        }
      }
    }
    for (let i = 0; i < n; i++) if (done[i]) this.homeMinutes[i] = lenM[i]! / WALK_SPEED_M_PER_MIN;
  }

  /** Minutes home from `c`, or Infinity if it's off the grid, blocked or cut off. */
  minutesFrom(c: Cell): number {
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return Infinity;
    return this.homeMinutes[y * this.width + x]!;
  }
}

/**
 * 1 for cells you can still get home from with `oxygenLeftMin`, restricted to
 * the 4-connected region around the source (so the outline is one loop).
 * All 0 if the budget is negative/NaN or the source is blocked.
 */
export function ringMask(field: HomeField, oxygenLeftMin: number): Uint8Array {
  const { width: W, height: H, homeMinutes } = field;
  const mask = new Uint8Array(W * H);
  const { x: sx, y: sy } = field.source;
  if (!(oxygenLeftMin >= 0) || sx < 0 || sy < 0 || sx >= W || sy >= H) return mask;
  const ok = (i: number) => homeMinutes[i]! * OXYGEN_MIN_PER_MIN <= oxygenLeftMin;
  const s = sy * W + sx;
  if (!ok(s)) return mask;
  const stack = [s];
  mask[s] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % W;
    const y = (i - x) / W;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!mask[j] && ok(j)) {
        mask[j] = 1;
        stack.push(j);
      }
    }
  }
  return mask;
}

/**
 * Outer outline of a 4-connected mask, walked clockwise (on screen, y down)
 * along cell borders. Vertices are cell corners in grid units: corner (cx, cy)
 * is the top-left corner of cell (cx, cy). Only turning points are kept.
 */
export function traceOutline(mask: Uint8Array, W: number, H: number): [number, number][] {
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const x0 = start % W;
  const y0 = (start - x0) / W;
  // Start on the top edge of the first (top-most, left-most) cell, heading east,
  // with the region on the right.
  let vx = x0;
  let vy = y0;
  let dx = 1;
  let dy = 0;
  const out: [number, number][] = [[vx, vy]];
  const limit = 4 * (W + 1) * (H + 1);
  for (let steps = 0; steps < limit; steps++) {
    vx += dx;
    vy += dy;
    // Right of heading (screen coords): (-dy, dx).
    const rx = -dy;
    const ry = dx;
    const cell = (sxn: number, syn: number) => inside(sxn > 0 ? vx : vx - 1, syn > 0 ? vy : vy - 1);
    const aheadRight = cell(dx + rx, dy + ry);
    const aheadLeft = cell(dx - rx, dy - ry);
    let ndx = dx;
    let ndy = dy;
    if (!aheadRight) {
      ndx = rx; // turn right
      ndy = ry;
    } else if (aheadLeft) {
      ndx = -rx; // turn left
      ndy = -ry;
    }
    if (vx === x0 && vy === y0 && ndx === 1 && ndy === 0) break;
    if (ndx !== dx || ndy !== dy) out.push([vx, vy]);
    dx = ndx;
    dy = ndy;
  }
  return out;
}

/** Perpendicular distance from p to segment a–b. */
function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

function douglasPeucker(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let best = -1;
    let bestD = eps;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k]!, pts[i]!, pts[j]!);
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Simplifies a closed ring to at most `maxPoints` vertices (first point not repeated). */
export function simplifyRing(ring: [number, number][], maxPoints: number): [number, number][] {
  if (ring.length <= maxPoints) return ring;
  // Split the loop at the vertex farthest from the first, simplify both halves.
  const a = ring[0]!;
  let far = 1;
  let farD = -1;
  for (let k = 1; k < ring.length; k++) {
    const d = Math.hypot(ring[k]![0] - a[0], ring[k]![1] - a[1]);
    if (d > farD) {
      farD = d;
      far = k;
    }
  }
  const first = ring.slice(0, far + 1);
  const second = [...ring.slice(far), a];
  for (let eps = 0.5; ; eps *= 1.5) {
    const out = [...douglasPeucker(first, eps), ...douglasPeucker(second, eps).slice(1, -1)];
    if (out.length <= maxPoints || eps > 1e6) return out;
  }
}

/**
 * Turn-back ring for `oxygenLeftMin`: the closed outline (first cell not
 * repeated) of the cells you can still get home from. Points are in cell
 * coordinates like `Cell` (cell centres are whole numbers, so cell borders sit
 * at .5). Empty if the budget is negative or the source is blocked; a single
 * cell (budget 0) gives the 4 corners of the habitat cell.
 */
export function ringPolygon(field: HomeField, oxygenLeftMin: number, maxPoints = 200): RingResult {
  const outline = traceOutline(ringMask(field, oxygenLeftMin), field.width, field.height);
  const simple = simplifyRing(outline, Math.max(4, maxPoints));
  return { polygon: simple.map(([x, y]) => ({ x: x - 0.5, y: y - 0.5 })) };
}
