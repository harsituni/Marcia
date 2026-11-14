/**
 * Generates the 100×100 mock grid in `fixtures/`, in the same formats as the
 * real `public/data/`. Deterministic; run with `npm run fixtures`.
 *
 * Terrain: a gentle tilt, a hill to the north-east, a crater to the
 * south-west (steep walls → blocked cells) and a sand sheet in the middle.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import type { GridMeta, Stop } from '../src/contracts.ts';

const OUT = join(import.meta.dirname, '..', 'fixtures');
const W = 100;
const H = 100;

const meta: GridMeta = {
  width: W,
  height: H,
  cellSizeM: 5,
  maxSlopeDeg: 25,
  habitat: { x: 15, y: 15 },
};

// --- terrain -------------------------------------------------------------
const elevation = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let z = -2000 + 0.15 * x - 0.1 * y; // gentle regional tilt (m)
    const hd2 = (x - 68) ** 2 + (y - 30) ** 2;
    z += 45 * Math.exp(-hd2 / (2 * 9 ** 2)); // hill
    const cd = Math.hypot(x - 32, y - 68);
    if (cd < 11) z -= 28 * (1 - (cd / 11) ** 2) ** 0.5; // crater bowl
    z += 6 * Math.exp(-((cd - 11.5) ** 2) / 2); // crater rim
    z += 0.6 * Math.sin(x * 0.7) * Math.cos(y * 0.5); // small bumps
    elevation[y * W + x] = z;
  }
}

const elev = (x: number, y: number) =>
  elevation[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))]!;

const slopeDeg = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dzdx = (elev(x + 1, y) - elev(x - 1, y)) / (2 * meta.cellSizeM);
    const dzdy = (elev(x, y + 1) - elev(x, y - 1)) / (2 * meta.cellSizeM);
    slopeDeg[y * W + x] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  }
}

const sand = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const inSheet = ((x - 55) / 14) ** 2 + ((y - 60) / 8) ** 2 < 1;
    sand[y * W + x] = inSheet ? 1 : 0;
  }
}

/** Cost per cell: 1 on flat rock, rising with slope, ×2 on sand, ∞ over the limit. */
const cost = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) {
  const s = slopeDeg[i]!;
  cost[i] = s > meta.maxSlopeDeg ? Infinity : (1 + 3 * (s / meta.maxSlopeDeg) ** 2) * (sand[i] ? 2 : 1);
}

// --- stops ----------------------------------------------------------------
const stops: Stop[] = [
  {
    id: 'stop-a',
    name: 'Layered Outcrop',
    cell: { x: 40, y: 22 },
    goal: 'Image the layers and sample the lowest bed.',
    geologyUnit: 'Delta front',
    minerals: ['clay', 'sulfate'],
    photo: 'photos/stop-a.png',
    scienceValue: 3,
  },
  {
    id: 'stop-b',
    name: 'Hill Flank Boulders',
    cell: { x: 80, y: 42 },
    goal: 'Check boulders shed from the hilltop for olivine.',
    geologyUnit: 'Crater floor fractured',
    minerals: ['olivine', 'pyroxene'],
    photo: 'photos/stop-b.png',
    scienceValue: 2,
  },
  {
    id: 'stop-c',
    name: 'Sand Sheet Edge',
    cell: { x: 70, y: 66 },
    goal: 'Trench the ripple crest and log grain size.',
    geologyUnit: 'Aeolian sand',
    minerals: ['basaltic sand'],
    photo: 'photos/stop-c.png',
    scienceValue: 1,
  },
  {
    id: 'stop-d',
    name: 'Crater Rim Ejecta',
    cell: { x: 20, y: 52 },
    goal: 'Sample ejecta blocks on the north rim.',
    geologyUnit: 'Impact ejecta',
    minerals: ['carbonate', 'pyroxene'],
    photo: 'photos/stop-d.png',
    scienceValue: 2,
  },
];

for (const s of stops) {
  const i = s.cell.y * W + s.cell.x;
  if (!Number.isFinite(cost[i]!)) throw new Error(`${s.id} sits on a blocked cell`);
}
if (!Number.isFinite(cost[meta.habitat.y * W + meta.habitat.x]!)) throw new Error('habitat is blocked');

// --- PNG writer (RGB, 8-bit, no dependencies) -------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}
const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/** Bilinear elevation sample at fractional grid coordinates. */
function elevAt(gx: number, gy: number): number {
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const a = elev(x0, y0) * (1 - fx) + elev(x0 + 1, y0) * fx;
  const b = elev(x0, y0 + 1) * (1 - fx) + elev(x0 + 1, y0 + 1) * fx;
  return a * (1 - fy) + b * fy;
}

// Basemap: 4 px per cell, hillshade (sun from the north-west) tinted Mars-red.
const SCALE = 4;
const basemap = png(W * SCALE, H * SCALE, (px, py) => {
  const gx = (px + 0.5) / SCALE - 0.5;
  const gy = (py + 0.5) / SCALE - 0.5;
  const d = 0.25;
  const dzdx = (elevAt(gx + d, gy) - elevAt(gx - d, gy)) / (2 * d * meta.cellSizeM);
  const dzdy = (elevAt(gx, gy + d) - elevAt(gx, gy - d)) / (2 * d * meta.cellSizeM);
  // Normal (-dzdx, -dzdy, 1) dotted with the light direction (NW, 45° up).
  const n = Math.hypot(dzdx, dzdy, 1);
  const shade = Math.max(0, (dzdx * 0.5 + dzdy * 0.5 + 0.707) / n);
  const onSand = sand[Math.min(H - 1, Math.max(0, Math.round(gy))) * W + Math.min(W - 1, Math.max(0, Math.round(gx)))];
  const base: [number, number, number] = onSand ? [214, 160, 112] : [176, 98, 62];
  const k = 0.35 + 0.85 * shade;
  return [clamp8(base[0] * k), clamp8(base[1] * k), clamp8(base[2] * k)];
});

// Stop photos: 160×120 gradient placeholders, one hue per stop.
const PHOTO_HUES: [number, number, number][] = [
  [190, 120, 80],
  [120, 110, 100],
  [220, 175, 120],
  [150, 90, 70],
];
function photo(i: number): Buffer {
  const [r, g, b] = PHOTO_HUES[i % PHOTO_HUES.length]!;
  return png(160, 120, (x, y) => {
    const k = 0.6 + 0.4 * (1 - y / 120) + 0.08 * Math.sin(x * 0.2 + i);
    return [clamp8(r * k), clamp8(g * k), clamp8(b * k)];
  });
}

// --- write ----------------------------------------------------------------
mkdirSync(join(OUT, 'photos'), { recursive: true });
const bytes = (a: Float32Array | Uint8Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
writeFileSync(join(OUT, 'cost.bin'), bytes(cost));
writeFileSync(join(OUT, 'elevation.bin'), bytes(elevation));
writeFileSync(join(OUT, 'sand.bin'), bytes(sand));
writeFileSync(join(OUT, 'basemap.png'), basemap);
writeFileSync(join(OUT, 'stops.json'), JSON.stringify(stops, null, 2) + '\n');
stops.forEach((s, i) => writeFileSync(join(OUT, s.photo), photo(i)));

const blocked = cost.reduce((n, c) => n + (Number.isFinite(c) ? 0 : 1), 0);
console.log(`fixtures: ${W}×${H}, ${blocked} blocked cells, ${sand.reduce((a, b) => a + b, 0)} sand cells, ${stops.length} stops`);
