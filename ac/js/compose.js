// The Argonaut × Credit × engine compositor — Punks' _composeBaseFrame (modulopunks/collection L2115-2135),
// adapted. Composes at 144×144 = 24 cells × 6 px, EXACTLY like Punks: the engine window comes from
// `engine.paintTo` at 144 (6 px per cell, WITH the artifact's dx dither/glyphs — chunk-5 GO P1), static layers
// are upscaled 24→144 nearest. Integer pixel math, deterministic, testable in Node.
//  - layers are painted in the renderer's draw-list order (argonaut.js drawList — the list G1 verifies);
//  - the ANIMATED slot shows the engine inside its mask; OUTSIDE the mask that layer's own pixels still paint
//    normally (keeps e.g. Cloak 1's faint semi pixels — chunk-5 GO P2);
//  - masks: alpha ≥ 128 → in (Le 2026-09-24: Cloak/Bones binarized; other semi layers are not offered);
//  - the per-id variance marks go right after BODY (A9), with the renderer's opacities (0.14 / 0.11).
import { LAYER, SMOKE_SLOT, layerPixels, blobHasSemi } from './argonaut.js?v=daf77ad712';

export const SIZE = 24, PX = SIZE * SIZE, SCALE = 6, OUT = SIZE * SCALE, OUT_PX = OUT * OUT;   // 144×144
export const MARK_A = [Math.round(0.14 * 255), Math.round(0.14 * 255), Math.round(0.11 * 255)];   // 36, 36, 28 (exported: fx.js re-blends the marks over the glyphs)
export const MARK_RGB = [[0, 0, 0], [0, 0, 0], [255, 255, 255]];
const over = (s, d, a) => Math.floor((s * a + d * (255 - a) + 127) / 255);   // RendererV5._over

/** Offerable animated layers (Le): Bones, Cloak, Crown, Sight, Background. A slot whose drawn blob has semi-transparent
 *  pixels is offered ONLY if it is Bones or Cloak (their mask is binarized); otherwise (Crown 6, Sight 14) not offered. */
export const OFFERABLE = [LAYER.BODY, LAYER.HOODIE, LAYER.HEAD, LAYER.EYES, LAYER.BACKGROUND];
export function offeredLayers(draw, blobOf) {
  return OFFERABLE.filter(slot => {
    const d = draw.find(x => x.slot === slot);
    if (!d) return false;                                   // trait absent (index 0 / 0xFF blob)
    if (!blobHasSemi(blobOf(d.blobId))) return true;
    return slot === LAYER.BODY || slot === LAYER.HOODIE;
  });
}

/** Precompute per-layer straight-alpha pixels (24×24) + binarized masks for one verified Argonaut. */
export function prepareLayers(draw, blobOf) {
  return draw.map(d => {
    const px = layerPixels(blobOf(d.blobId), d.tone);
    const mask = new Uint8Array(PX);
    for (let i = 0; i < PX; i++) mask[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
    return { slot: d.slot, px, mask };
  });
}

function blendCell(out, cell, r, g, b, a) {
  const cx = (cell % SIZE) * SCALE, cy = Math.floor(cell / SIZE) * SCALE;
  for (let y = 0; y < SCALE; y++) {
    let o = ((cy + y) * OUT + cx) * 4;
    for (let x = 0; x < SCALE; x++, o += 4) {
      if (a === 255) { out[o] = r; out[o + 1] = g; out[o + 2] = b; }
      else { out[o] = over(r, out[o], a); out[o + 1] = over(g, out[o + 1], a); out[o + 2] = over(b, out[o + 2], a); }
    }
  }
}
function copyCell(out, cell, src) {
  const cx = (cell % SIZE) * SCALE, cy = Math.floor(cell / SIZE) * SCALE;
  for (let y = 0; y < SCALE; y++) {
    const o = ((cy + y) * OUT + cx) * 4;
    for (let k = 0; k < SCALE * 4; k += 4) { out[o + k] = src[o + k]; out[o + k + 1] = src[o + k + 1]; out[o + k + 2] = src[o + k + 2]; }
  }
}

/**
 * One 144×144 frame. `engineRGB` = the engine's paintTo output at 144×144 (RGBA; alpha ignored) or null (static).
 * @returns Uint8ClampedArray(144*144*4), fully opaque.
 */
export function composeFrame(layers, marks, animatedSlot, engineRGB, out = new Uint8ClampedArray(OUT_PX * 4)) {
  if (engineRGB && engineRGB.length !== OUT_PX * 4) throw new Error('engine frame must be 144×144 RGBA');
  if (marks && marks.some(([x, y]) => !(x >= 0 && x < SIZE && y >= 0 && y < SIZE))) throw new Error('mark outside 24×24');
  out.fill(0);
  for (let i = 0; i < OUT_PX; i++) out[i * 4 + 3] = 255;          // opaque black base (the ground layer covers it)
  for (const L of layers) {
    const animated = engineRGB && L.slot === animatedSlot;
    for (let c = 0; c < PX; c++) {
      if (animated && L.mask[c]) { copyCell(out, c, engineRGB); continue; }
      const o = c * 4, a = L.px[o + 3];
      if (a !== 0) blendCell(out, c, L.px[o], L.px[o + 1], L.px[o + 2], a);
    }
    if (L.slot === LAYER.BODY && marks && marks.length === 3)
      marks.forEach(([x, y], k) => blendCell(out, y * SIZE + x, MARK_RGB[k][0], MARK_RGB[k][1], MARK_RGB[k][2], MARK_A[k]));
  }
  return out;
}

/** 144 → 24 (top-left pixel of every cell) — for tests and thumbnails. */
export function downsample(frame144) {
  const out = new Uint8ClampedArray(PX * 4);
  for (let c = 0; c < PX; c++) {
    const o = (((Math.floor(c / SIZE) * SCALE) * OUT) + (c % SIZE) * SCALE) * 4;
    out[c * 4] = frame144[o]; out[c * 4 + 1] = frame144[o + 1]; out[c * 4 + 2] = frame144[o + 2]; out[c * 4 + 3] = 255;
  }
  return out;
}

export { SMOKE_SLOT };
