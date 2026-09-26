// The pure data side of the Cubes view (chunk 7b, design app-plan/13-chunk7-synthesis.md D2/D2'/G17/G19): which
// cells become voxels, which colour each voxel takes each frame, and what the flat backdrop shows. No DOM, no GL —
// everything here is testable in Node.
import { LAYER } from './argonaut.js?v=daf77ad712';
import { SIZE, PX, SCALE, OUT } from './compose.js?v=607ac14ea1';
import { overlay } from './fx.js?v=abd4dbc130';

export const CELLS = PX;                  // 576
export const RGB_CELLS = PX * 2;          // G17: the rgb fed to the core ALWAYS has 1152 cells (576..1151 = back slab)
const MID = SCALE >> 1;                   // 3 → the centre pixel of a 6×6 cell (Punks _3dCrops parity)

/** figure = union of every non-BACKGROUND layer mask (alpha ≥ 128, the compose.js threshold); smoke included. */
export function figureMask(layers) {
  const m = new Uint8Array(PX);
  for (const L of layers) if (L.slot !== LAYER.BACKGROUND) for (let i = 0; i < PX; i++) if (L.mask[i]) m[i] = 1;
  return m;
}
export const countCells = mask => mask.reduce((a, v) => a + v, 0);

/** D7 (Le): cells covered by any layer ABOVE Bones (every layer except BACKGROUND and BODY, smoke included; α ≥ 128) —
 *  the core gives each of them a second cube at z=+1 (a solid column). Always a subset of figureMask. */
export function raisedMask(layers) {
  const m = new Uint8Array(PX);
  for (const L of layers) if (L.slot !== LAYER.BACKGROUND && L.slot !== LAYER.BODY) for (let i = 0; i < PX; i++) if (L.mask[i]) m[i] = 1;
  return m;
}

/** the 24×24 RGBA the core voxelizes (alpha 255 where the figure is, 0 elsewhere) */
export function silhouettePixels(mask) {
  const px = new Uint8ClampedArray(PX * 4);
  for (let i = 0; i < PX; i++) if (mask[i]) px[i * 4 + 3] = 255;
  return px;
}

/** the layers the backdrop / back slab come from (0 or 1 entries) */
export const backgroundLayers = layers => layers.filter(L => L.slot === LAYER.BACKGROUND);

/** sample the centre pixel of every cell of a 144×144 RGBA frame into rgb[off .. off+576) (cells, RGBA) */
export function sampleCells(frame, rgb, off = 0) {
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const s = ((r * SCALE + MID) * OUT + c * SCALE + MID) * 4, d = (off + r * SIZE + c) * 4;
    rgb[d] = frame[s]; rgb[d + 1] = frame[s + 1]; rgb[d + 2] = frame[s + 2]; rgb[d + 3] = 255;
  }
  return rgb;
}

/** D2': the back slab exists only while an engine really runs on the BACKGROUND slot */
export const wantsBackSlab = (engineOn, slot) => !!engineOn && slot === LAYER.BACKGROUND;

// ── MP4 turn (Le 2026-09-26): one full turn over the clip, but at the live spin's CURVE — slow facing the camera, faster
// edge-on where there is little to see (cubes.js spin(): 0.0015 + 0.004·(1 − |cos yaw|), ~3.7× on the sides). Exact:
// yaw(0) = start, yaw(1) = start + 2π, so the clip still loops seamlessly (the speed is periodic too). ──
const SPIN_SLOW = 0.0015, SPIN_EDGE = 0.004, SPIN_STEPS = 4096;
const spinTables = new Map();
function spinTable(start) {
  let t = spinTables.get(start);
  if (t) return t;
  const speed = y => SPIN_SLOW + SPIN_EDGE * (1 - Math.abs(Math.cos(y)));
  t = new Float64Array(SPIN_STEPS + 1);                    // t[i] = time to reach start + 2π·i/STEPS (trapezoid of 1/speed)
  const dy = 2 * Math.PI / SPIN_STEPS;
  for (let i = 1; i <= SPIN_STEPS; i++) t[i] = t[i - 1] + dy * (1 / speed(start + (i - 1) * dy) + 1 / speed(start + i * dy)) / 2;
  spinTables.set(start, t);
  return t;
}
/** the yaw at clip fraction u ∈ [0, 1] of one full turn starting at `start` */
export function spinYaw(u, start) {
  const t = spinTable(start), want = Math.min(1, Math.max(0, u)) * t[SPIN_STEPS];
  let lo = 0, hi = SPIN_STEPS;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= want) lo = mid; else hi = mid; }
  const f = t[hi] > t[lo] ? (want - t[lo]) / (t[hi] - t[lo]) : 0;
  return start + (lo + f) * 2 * Math.PI / SPIN_STEPS;
}

// ── Checks & Stars in 3D (Le 2026-09-26): the core's check / gold / silver modes, scoped to the animated layer ──
/**
 * `fused` for the core (RGB_CELLS entries): which voxels become a seal / star tile. Background animated → the back slab
 * (gi 576..1151) wherever the Background has a cell; the figure in front stays plain cubes. Any other layer → its own
 * cells (the stage's mask) that are still visible, i.e. not fully covered by what is drawn after it (fx.js overlay
 * alpha < 255: a 50 % lens / smoke lets the glyph through, like the 2D Checks view). Slot absent → all zero.
 */
export function fusedMask(layers, marks, slot, back) {
  const m = new Uint8Array(RGB_CELLS), L = layers.find(x => x.slot === slot);
  if (!L) return m;
  if (slot === LAYER.BACKGROUND) { if (back) for (let i = 0; i < PX; i++) m[CELLS + i] = L.mask[i] ? 1 : 0; return m; }
  const top = overlay(layers, marks, slot);
  for (let i = 0; i < PX; i++) m[i] = L.mask[i] && top[i * 4 + 3] < 255 ? 1 : 0;
  return m;
}
/**
 * `idx` for the core (RGB_CELLS entries): the engine's palette index of every window cell — the value whose bits pick
 * lit / shadow tile and star (the 2D paintToStars reads the same bits from the engine grid). Read like Punks' 3D does
 * (nearest palette colour of the cell's centre pixel), here from the ENGINE's own 144×144 paint (never the composed
 * frame, where an upper layer could tint it) and the Credit palette it runs on. The slab half repeats the front half.
 */
export function paletteIndex(engineRGB, pal, idx) {
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const s = ((r * SCALE + MID) * OUT + c * SCALE + MID) * 4, R = engineRGB[s], G = engineRGB[s + 1], B = engineRGB[s + 2];
    let bi = 0, bd = Infinity;
    for (let k = 0; k < pal.length; k++) { const p = pal[k], d = (R - p[0]) ** 2 + (G - p[1]) ** 2 + (B - p[2]) ** 2; if (d < bd) { bd = d; bi = k; } }
    idx[r * SIZE + c] = bi; idx[CELLS + r * SIZE + c] = bi;
  }
  return idx;
}
