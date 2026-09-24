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
import { makeAcEngine } from './engine-ac.js?v=8410dea0c1';
import { prepareLayers, composeFrame, OUT, OUT_PX } from './compose.js?v=2eedc96065';
import { backgroundLayers, wantsBackSlab } from './cubes-feed.js?v=36e2245c37';

export const STEP_MS = 1000 / 60;                            // one engine step = 1/60 s, live AND in the MP4 (chunk 9a, Le: same speed on every screen)
const BACKDROP_GREY = [0xf4, 0xf5, 0xf6];                    // --bg: behind the back slab (Le 2026-09-24)
const STEP_SLACK_MS = 1.5;                                   // rAF jitter tolerance: a 60 Hz tick of 16.5 ms still steps once
const MAX_STEPS = 6;                                         // dt is clamped to 100 ms → at most 6 steps catch up in one tick

/** ONE frame of the 2D pipeline, shared by the stage and the MP4 exporter (chunk 9 N3) so they are byte-identical by
 *  construction: n engine steps → paintTo 144×144 (the artifact's dither/glyphs) → compose into the animated slot.
 *  Returns the engine's RGBA (for the view sink / the back slab). The caller owns target, cap and frame. */
export function stepPaintCompose(engine, n, target, cap, layers, marks, slot, frame) {
  for (let k = 0; k < n; k++) { engine.step(engine.dtOps); engine.applyRects(); if (engine.tickRects) engine.tickRects(); }
  engine.paintTo(target, cap);
  composeFrame(layers, marks, slot, cap.last.data, frame);
  return cap.last.data;
}

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
  let view = null, lastTs = 0, acc = 0, held = false;
  let engIn = null;                                          // {comp, credit, slot} of the engine that is RUNNING (N2: the MP4 snapshot's one source)
  const noEngine = () => { engine = null; engIn = null; acc = 0; };

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
  function stepAndDraw(n, dtMs) { out(stepPaintCompose(engine, n, target, cap, layers, marks, slot, frame), dtMs); }
  /** recompose + sink the CURRENT state without stepping (view switch, G3) */
  function redraw() {
    if (!layers) return;
    const eng = engine && cap.last ? cap.last.data : null;
    composeFrame(layers, marks, eng ? slot : null, eng, frame);
    out(eng, 0);
  }
  const wantsFrame = () => !held && (!!engine || !!(view && layers && view.wantsFrame()));   // G1: ONE gate for tick and schedule; N6: hold
  function fail(e) { stop(); noEngine(); drawStatic(); if (onError) onError(e); schedule(); }
  function tick(now) {
    raf = 0;
    if (destroyed || !wantsFrame()) { lastTs = 0; return; }   // 7b GO opus P3-1: an idle loop restarts with a fresh dt
    const dt = lastTs ? Math.min(now - lastTs, 100) : STEP_MS; lastTs = now;
    if (engine) {
      // chunk 9a (Le): the engine advances at 60 steps/s on EVERY display (a 120 Hz rAF used to run it twice as fast),
      // the same speed as the MP4. Ticks between steps redraw nothing in 2D; with a view they re-sink the last frame (spin).
      acc += dt;
      let n = Math.floor((acc + STEP_SLACK_MS) / STEP_MS);
      if (n > MAX_STEPS) { n = MAX_STEPS; acc = 0; } else acc -= n * STEP_MS;
      try {
        if (n > 0) { stepAndDraw(n, dt); frames++; }
        else if (view && cap.last) out(cap.last.data, dt);
      } catch (e) { fail(e); return; }
    }
    else { try { drawStatic(dt); } catch (e) { stop(); return; } }
    schedule();
  }
  function schedule() { if (!raf && !destroyed && !document.hidden && wantsFrame()) raf = requestAnimationFrame(tick); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; lastTs = 0; acc = 0; }
  const onVis = () => (document.hidden ? stop() : schedule());
  document.addEventListener('visibilitychange', onVis);

  return {
    /** Show an Argonaut: `argo` = renderVerified() result, `blobOf` = id → blob. Static until setEngine(). */
    setArgonaut(argo, blobOf) {
      const next = prepareLayers(argo.drawList, blobOf);   // may throw → the previous Argonaut stays, and stays static
      stop(); noEngine();
      layers = next; bgLayers = backgroundLayers(next); marks = argo.marks;
      if (view && view.onArgonaut) view.onArgonaut(layers);   // G15: the view rebuilds lazily on its next draw
      drawStatic();
      schedule();
    },
    /** Animate `animSlot` with the artifact `comp` fed by the Credit `credit` ({pal, init}). Throws on bad input
     *  (the stage then shows the static Argonaut — never the previous engine frozen). */
    setEngine(comp, credit, animSlot) {
      stop(); noEngine();
      if (!layers) throw new Error('setArgonaut first');
      try { engine = makeAcEngine(engCanvas, comp, credit); }
      catch (e) { noEngine(); drawStatic(); schedule(); throw e; }
      slot = animSlot; frames = 0; t0 = performance.now();
      try { stepAndDraw(1, 0); } catch (e) { stop(); noEngine(); drawStatic(); schedule(); throw e; }   // first frame now (even hidden); a failure is THROWN to the caller (not also sent to onError)
      engIn = { comp, credit, slot: animSlot };             // only once the engine really produced its first frame
      schedule();
    },
    clearEngine() { stop(); noEngine(); drawStatic(); schedule(); },
    /** forget the Argonaut and blank the canvas (chunk-6 GO: the canvas/PNG must never show a previous Argonaut) */
    reset() { stop(); noEngine(); layers = null; bgLayers = []; marks = []; slot = null; if (view && view.onReset) view.onReset(); dctx.clearRect(0, 0, OUT, OUT); },
    /** N6: pause the live loop (an MP4 export runs); hold(false) re-arms it — never leaves the stage frozen */
    hold(on) { held = !!on; if (held) stop(); else schedule(); },
    /** N2: everything that produced the pixels NOW, for the MP4 exporter's own instance (null without an Argonaut).
     *  engine = {comp, credit, slot} of the RUNNING engine, or null (static Argonaut). The arrays are never mutated
     *  by the stage (setArgonaut replaces them), and makeAcEngine copies the Credit's init/palette. */
    exportInputs() { return layers ? { layers, bgLayers, marks, engine: engIn } : null; },
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
    /** PAINTED frames per second since the last setEngine (ticks that took ≥1 step; advance() not counted). Since 9a the
     *  engine runs 60 steps/s whatever the display rate, so this is ≤60 and is not the rAF rate (9a GO opus P3-2). */
    fps() { const dt = (performance.now() - t0) / 1000; return dt > 0 ? frames / dt : 0; },
    running() { return !!raf; },
    destroy() { destroyed = true; stop(); noEngine(); document.removeEventListener('visibilitychange', onVis); },   // 9a GO opus P3-1
  };
}
