// The 2D stage: ONE rAF loop that steps the engine (artifact motion + Credit colours/pattern), paints its window
// with `paintTo` at 144×144 (6 px per cell, with the artifact's dither/glyphs — exactly like Modulo Punks'
// fusion), composes it into the chosen Argonaut layer, and puts it on a fixed 144×144 canvas that CSS scales
// with `image-rendering: pixelated` (no per-frame resize / drawImage; every cell stays 6 px in the bitmap).
// Lifecycle (S9): a single loop, torn down on every change, paused while the tab is hidden; engine errors stop
// the loop visibly (static frame + onError), never a silent freeze. Engines only via makeAcEngine (A4).
// Chunk 7b (app-plan/13-chunk7-synthesis.md D3, G1-G3, G12, G15): an optional VIEW (the Cubes adapter) is a sink at
// the end of every composed frame. The loop stays ONE loop: `tick` and `schedule` share wantsFrame() (engine OR a view
// that wants frames — spin/drag). With a view, the 2D canvas becomes the flat backdrop (the Background layer, or the
// page grey while the engine animates the Background = back slab), and a view failure never reaches onError (G2).
import { makeAcEngine } from './engine-ac.js';
import { prepareLayers, composeFrame, OUT, OUT_PX } from './compose.js';
import { backgroundLayers, wantsBackSlab } from './cubes-feed.js';

const STEP_MS = 1000 / 60;                                   // dt for advance() and the first frame (G12)
const BACKDROP_GREY = [0xf4, 0xf5, 0xf6];                    // --bg: behind the back slab (Le 2026-09-24)

export function createStage(display, { onError = null, onViewError = null } = {}) {
  display.width = OUT; display.height = OUT;                 // intrinsic 144×144; size it with CSS + image-rendering:pixelated
  const dctx = display.getContext('2d');
  const target = { width: OUT, height: OUT };                // paintTo only reads width/height from its target
  const cap = { createImageData: (w, h) => new ImageData(w, h), putImageData(img) { this.last = img; } };
  const frame = new Uint8ClampedArray(OUT_PX * 4);
  const img = new ImageData(frame, OUT, OUT);                // reused every frame (shares `frame`)
  const bgFrame = new Uint8ClampedArray(OUT_PX * 4);         // the Background layer alone (backdrop / back-slab colours)
  const bgImg = new ImageData(bgFrame, OUT, OUT);
  const grey = new Uint8ClampedArray(OUT_PX * 4);
  for (let i = 0; i < OUT_PX; i++) { grey[i * 4] = BACKDROP_GREY[0]; grey[i * 4 + 1] = BACKDROP_GREY[1]; grey[i * 4 + 2] = BACKDROP_GREY[2]; grey[i * 4 + 3] = 255; }
  const greyImg = new ImageData(grey, OUT, OUT);
  const engCanvas = document.createElement('canvas'); engCanvas.width = OUT; engCanvas.height = OUT;

  let layers = null, bgLayers = [], marks = [], slot = null, engine = null, raf = 0, frames = 0, t0 = 0, destroyed = false;
  let view = null, lastTs = 0;

  const put = () => dctx.putImageData(img, 0, 0);
  /** the sink: 2D → the frame; with a view → backdrop on the 2D canvas + the view draws its own canvas.
   *  VIEW CONTRACT: draw(frame, bgFrame, back, dtMs) samples both buffers synchronously (never keeps them), never calls
   *  back into the stage except kick(), and signals failure ONLY by returning false (it already handled its own
   *  fallback + UI) or by throwing (→ onViewError). Either way the stage drops the view and puts the full frame (G3). */
  function out(engineRGB, dtMs) {
    const v = view;
    if (v) {
      const back = wantsBackSlab(engineRGB, slot);
      let ok = false, err = null;
      try {                                                  // G2: nothing view-side ever throws into the engine's try (7b GO sonnet P3-1)
        composeFrame(bgLayers, null, engineRGB ? slot : null, engineRGB, bgFrame);
        ok = v.draw(frame, bgFrame, back, dtMs) !== false;
      } catch (e) { err = e; }
      if (view !== v) return;                                // 7b GO opus P2-1: draw() re-entered setView → that call already painted
      if (ok) { dctx.putImageData(back ? greyImg : bgImg, 0, 0); return; }
      view = null;                                           // G3: the view gave up → the 2D shows the FULL frame now
      put();
      if (err && onViewError) onViewError(err);              // after the put: a handler that attaches a new view is not overpainted
      return;
    }
    put();
  }
  function drawStatic(dtMs = 0) { if (layers) { composeFrame(layers, marks, null, null, frame); out(null, dtMs); } }
  function stepAndDraw(n, dtMs) {
    for (let k = 0; k < n; k++) { engine.step(engine.dtOps); engine.applyRects(); if (engine.tickRects) engine.tickRects(); }
    engine.paintTo(target, cap);
    composeFrame(layers, marks, slot, cap.last.data, frame);
    out(cap.last.data, dtMs);
  }
  /** recompose + sink the CURRENT state without stepping (view switch, G3) */
  function redraw() {
    if (!layers) return;
    const eng = engine && cap.last ? cap.last.data : null;
    composeFrame(layers, marks, eng ? slot : null, eng, frame);
    out(eng, 0);
  }
  const wantsFrame = () => !!engine || !!(view && layers && view.wantsFrame());   // G1: ONE gate for tick and schedule
  function fail(e) { stop(); engine = null; drawStatic(); if (onError) onError(e); schedule(); }
  function tick(now) {
    raf = 0;
    if (destroyed || !wantsFrame()) { lastTs = 0; return; }   // 7b GO opus P3-1: an idle loop restarts with a fresh dt
    const dt = lastTs ? Math.min(now - lastTs, 100) : STEP_MS; lastTs = now;
    if (engine) { try { stepAndDraw(1, dt); frames++; } catch (e) { fail(e); return; } }
    else { try { drawStatic(dt); } catch (e) { stop(); return; } }
    schedule();
  }
  function schedule() { if (!raf && !destroyed && !document.hidden && wantsFrame()) raf = requestAnimationFrame(tick); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; lastTs = 0; }
  const onVis = () => (document.hidden ? stop() : schedule());
  document.addEventListener('visibilitychange', onVis);

  return {
    /** Show an Argonaut: `argo` = renderVerified() result, `blobOf` = id → blob. Static until setEngine(). */
    setArgonaut(argo, blobOf) {
      const next = prepareLayers(argo.drawList, blobOf);   // may throw → the previous Argonaut stays, and stays static
      stop(); engine = null;
      layers = next; bgLayers = backgroundLayers(next); marks = argo.marks;
      if (view && view.onArgonaut) view.onArgonaut(layers);   // G15: the view rebuilds lazily on its next draw
      drawStatic();
      schedule();
    },
    /** Animate `animSlot` with the artifact `comp` fed by the Credit `credit` ({pal, init}). Throws on bad input
     *  (the stage then shows the static Argonaut — never the previous engine frozen). */
    setEngine(comp, credit, animSlot) {
      stop(); engine = null;
      if (!layers) throw new Error('setArgonaut first');
      try { engine = makeAcEngine(engCanvas, comp, credit); }
      catch (e) { drawStatic(); schedule(); throw e; }
      slot = animSlot; frames = 0; t0 = performance.now();
      try { stepAndDraw(1, 0); } catch (e) { stop(); engine = null; drawStatic(); schedule(); throw e; }   // first frame now (even hidden); a failure is THROWN to the caller (not also sent to onError)
      schedule();
    },
    clearEngine() { stop(); engine = null; drawStatic(); schedule(); },
    /** forget the Argonaut and blank the canvas (chunk-6 GO: the canvas/PNG must never show a previous Argonaut) */
    reset() { stop(); engine = null; layers = null; bgLayers = []; marks = []; slot = null; if (view && view.onReset) view.onReset(); dctx.clearRect(0, 0, OUT, OUT); },
    /** attach / detach the Cubes view (null = plain 2D). Redraws synchronously so neither canvas keeps a stale frame (G3). */
    setView(v) {
      stop(); view = v || null;
      if (view && layers && view.onArgonaut) view.onArgonaut(layers);   // 7c: a view attached AFTER setArgonaut learns the current Argonaut
      redraw(); schedule();
    },
    /** the view started wanting frames (drag start / spin resumed) → arm the loop if it is idle */
    kick() { schedule(); },
    /** true while an Argonaut is on the canvas (PNG is only offered then) */
    hasArgonaut() { return !!layers; },
    /** advance n steps without rAF (tests / hidden-tab verification) and draw the result; a view spins by n·STEP_MS (G12) */
    advance(n = 1) {
      n = Math.max(1, n | 0);
      if (destroyed) return;
      if (engine) { try { stepAndDraw(n, n * STEP_MS); } catch (e) { fail(e); } }
      else if (view && layers) drawStatic(n * STEP_MS);
    },
    /** current frame as a PNG data URL, upscaled nearest (for "PNG ↓") — the 2D frame; Cubes PNG lives in the view */
    snapshot(scale = 4) {
      const c = document.createElement('canvas'); c.width = c.height = OUT * scale;
      const x = c.getContext('2d'); x.imageSmoothingEnabled = false; x.drawImage(display, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    },
    /** the last composed frames, or null without an Argonaut (7b GO opus P3-2: never a previous Argonaut's pixels).
     *  bgFrame is only current while a view is attached; the Cubes PNG must use the view's own built state. */
    lastFrames() { return layers ? { frame, bgFrame, back: wantsBackSlab(engine, slot) } : null; },
    /** rAF frames per second since the last setEngine (advance() steps are not counted) */
    fps() { const dt = (performance.now() - t0) / 1000; return dt > 0 ? frames / dt : 0; },
    running() { return !!raf; },
    destroy() { destroyed = true; stop(); engine = null; document.removeEventListener('visibilitychange', onVis); },
  };
}
