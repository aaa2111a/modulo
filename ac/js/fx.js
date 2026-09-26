// Checks & Stars (Le 2026-09-26, "three positions + style"): the Modulo Punks fusion "check it" / gold / silver modes
// for AC. The engine (engine.js, extracted verbatim from Punks) already draws them — paintToBadge (verified-check seals)
// and paintToStars (gold / silver stars) — over the SAME centered 24-cell window AC animates, 1 cell = 1 glyph.
// This module composes them into the Argonaut at a high resolution with EXACTLY the 2D stage's layering
// (compose.js composeFrame): the static Argonaut underneath, the engine's glyphs on the animated layer's own cells (its
// mask, like the 2D copyCell), and on top everything drawn after that layer — later layers and, when they come after it,
// the three marks — with their REAL alpha (vape smoke / lenses at 50 % let the glyphs through, as in 2D; GO opus P2-1).
// One painter serves the live view, the PNG and the MP4.
import { composeFrame, OUT, OUT_PX, SIZE, PX, MARK_RGB, MARK_A } from './compose.js?v=607ac14ea1';
import { LAYER } from './argonaut.js?v=daf77ad712';

export const FX = Object.freeze(['check', 'gold', 'silver']);
export const STAR_SPIN_MS = 2600;                               // Punks GOLD_SPIN_MS: one star revolution per 2.6 s
/** the star angle at `ms` (time-driven live, frame-index-driven in the MP4 → deterministic) */
export const starAngle = ms => 2 * Math.PI * ((ms % STAR_SPIN_MS) / STAR_SPIN_MS);

/** straight-alpha "over" of one RGBA source cell onto the 24×24 RGBA buffer `out` (overlay() starts TRANSPARENT) */
function over(out, c, r, g, b, a) {
  if (!a) return;
  const o = c * 4, as = a / 255, ad = out[o + 3] / 255, ao = as + ad * (1 - as);
  out[o] = Math.round((r * as + out[o] * ad * (1 - as)) / ao);
  out[o + 1] = Math.round((g * as + out[o + 1] * ad * (1 - as)) / ao);
  out[o + 2] = Math.round((b * as + out[o + 2] * ad * (1 - as)) / ao);
  out[o + 3] = Math.round(ao * 255);
}
/**
 * What the 2D stage draws AFTER the animated layer, on a transparent 24×24 (RGBA): every later layer in order, and the
 * three marks where composeFrame puts them (right after BODY, compose.js MARK_RGB / MARK_A) if BODY is the animated
 * layer or comes after it.
 */
export function overlay(layers, marks, slot) {
  const out = new Uint8ClampedArray(PX * 4), i = layers.findIndex(L => L.slot === slot);
  if (i < 0) return out;
  const markCells = () => {
    if (marks && marks.length === 3) marks.forEach(([x, y], k) => over(out, y * SIZE + x, MARK_RGB[k][0], MARK_RGB[k][1], MARK_RGB[k][2], MARK_A[k]));
  };
  if (layers[i].slot === LAYER.BODY) markCells();
  for (let k = i + 1; k < layers.length; k++) {
    const L = layers[k];
    for (let c = 0; c < PX; c++) { const o = c * 4; over(out, c, L.px[o], L.px[o + 1], L.px[o + 2], L.px[o + 3]); }
    if (L.slot === LAYER.BODY) markCells();
  }
  return out;
}
/**
 * @param size   output side in px — a multiple of 24 (720 live, 2016 / 1440 / 1152 export), so 1 cell = size/24 px
 * @param mk     (w, h) → a canvas (document.createElement in the page; injectable for tests)
 * @param into   optional: the canvas to paint INTO (the live #fx element); resized to size×size
 * @returns { canvas, paint(engine|null, layers, marks, slot, fx, angle) }
 */
export function createFxPainter(size, mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }, into = null) {
  if (!Number.isInteger(size / SIZE) || size < SIZE) throw new Error('fx size must be a multiple of 24');
  const canvas = into || mk(size, size), ctx = canvas.getContext('2d');
  if (into) { into.width = size; into.height = size; }
  const glyphs = mk(size, size), gctx = glyphs.getContext('2d');   // the engine's full-window glyph render
  const small = mk(OUT, OUT), sctx = small.getContext('2d');        // the static Argonaut at 144 (6 px per cell)
  const cellMask = mk(SIZE, SIZE), mctx = cellMask.getContext('2d');   // 24×24 alpha: the animated layer's own cells
  const top = mk(SIZE, SIZE), tctx = top.getContext('2d');          // 24×24 RGBA: everything drawn after it (real alpha)
  const frame = new Uint8ClampedArray(OUT_PX * 4);
  let baseFor = null, layerFor = null;                          // caches: the static base per (layers, marks); mask + overlay per (layers, marks, slot)

  function paint(engine, layers, marks, slot, fx, angle = 0) {
    if (!FX.includes(fx)) throw new Error('unknown fx ' + fx);
    if (baseFor === null || baseFor.layers !== layers || baseFor.marks !== marks) {
      composeFrame(layers, marks, null, null, frame);          // the whole Argonaut, static (marks included)
      sctx.putImageData(new ImageData(frame, OUT, OUT), 0, 0);
      baseFor = { layers, marks };
    }
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(small, 0, 0, size, size);                     // crisp pixel blocks (nearest)
    const L = engine && slot !== null && slot !== undefined ? layers.find(x => x.slot === slot) : null;
    if (!L) return canvas;                                      // a static Argonaut (or a slot it lacks): nothing animates
    if (layerFor === null || layerFor.layers !== layers || layerFor.marks !== marks || layerFor.slot !== slot) {
      const img = new ImageData(SIZE, SIZE);
      for (let c = 0; c < PX; c++) img.data[c * 4 + 3] = L.mask[c] ? 255 : 0;   // the same cells composeFrame gives the engine
      mctx.putImageData(img, 0, 0);
      // only over the glyph cells: everywhere else the static base ALREADY holds those layers / marks (no double blend)
      const top8 = overlay(layers, marks, slot);
      for (let c = 0; c < PX; c++) if (!L.mask[c]) top8[c * 4 + 3] = 0;
      tctx.clearRect(0, 0, SIZE, SIZE);
      tctx.putImageData(new ImageData(top8, SIZE, SIZE), 0, 0);
      layerFor = { layers, marks, slot };
    }
    if (fx === 'check') engine.paintToBadge(glyphs, gctx, { full: true });
    else engine.paintToStars(glyphs, gctx, { pal: fx, angle });
    gctx.save();
    gctx.globalCompositeOperation = 'destination-in';           // keep the glyphs only on the animated layer's cells
    gctx.imageSmoothingEnabled = false;
    gctx.drawImage(cellMask, 0, 0, size, size);
    gctx.restore();
    ctx.drawImage(glyphs, 0, 0);
    ctx.drawImage(top, 0, 0, size, size);                       // later layers + marks over the glyphs, real alpha (nearest)
    return canvas;
  }
  return { canvas, paint };
}
