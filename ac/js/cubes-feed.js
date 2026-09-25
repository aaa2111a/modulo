// The pure data side of the Cubes view (chunk 7b, design app-plan/13-chunk7-synthesis.md D2/D2'/G17/G19): which
// cells become voxels, which colour each voxel takes each frame, and what the flat backdrop shows. No DOM, no GL —
// everything here is testable in Node.
import { LAYER } from './argonaut.js?v=29531b221c';
import { SIZE, PX, SCALE, OUT } from './compose.js?v=329af6516e';

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
