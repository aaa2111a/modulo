// MP4 export (chunk 9, design app-plan/18-chunk9-mp4-synthesis.md M1-M6 + N1-N11). The ACTIVE view, 20 s, 1440² (1152²
// fallback), 60 fps (30 fps fallback at 2 engine steps per frame → the same speed), H.264 via WebCodecs, muxed by the
// self-hosted mp4-muxer 5.1.3 (js/vendor/, pinned + SRI; CSP script-src 'self').
//  - The export owns its engine: built SYNCHRONOUSLY from stage.exportInputs() in the click handler (prepare2D), before
//    any await (N2) — nothing live is shared, so the user may keep browsing while it encodes (M5).
//  - Frame f = the state after 1 + f·stepsPerFrame engine steps (frame 0 == the frame setEngine drew), through the SAME
//    stepPaintCompose the stage uses (N3) → byte-identical 144² frames, then an integer nearest upscale (×10 / ×8).
//  - Driven by frame index, never the wall clock; the loop yields with setTimeout, pauses while the tab is hidden and
//    aborts if the browser reclaimed the encoder meanwhile (N4); backpressure + a no-output watchdog.
//  - Desktop: straight into the file picked in "Save as" (opts.writable). Phones: in memory, moov first (fastStart) —
//    at most ≈60 MB (2016 at 24 Mb/s × 20 s; ≈30 MB at 1440), far from the ArrayBufferTarget OOM zone.
// Everything the browser provides is injectable (env) so tests/test-mp4.mjs runs the real loop in Node.
import { makeAcEngine } from './engine-ac.js?v=8410dea0c1';
import { stepPaintCompose } from './stage.js?v=0c44884967';
import { OUT, OUT_PX, composeFrame } from './compose.js?v=2eedc96065';
import { wantsBackSlab } from './cubes-feed.js?v=36e2245c37';

export const MUXER_SRC = 'js/vendor/mp4-muxer-5.1.3.js?v=5.1.3';                   // document-relative (N10)
export const MUXER_SRI = 'sha256-u6iAggU1EbiYySHnGoZUeIIaZ013m6DHAox4ySH+yvY=';   // = sha256 bba88082… (tests/test-mp4.mjs)
export const SECONDS = 20, BITRATE = 12_000_000, WATCHDOG_MS = 10_000;
// High 4.2/5.0/5.1/5.2, Main 4.2/5.0. 2016²@60 = 952 560 macroblocks/s → needs 5.1+ (limit 983 040); Punks HQ uses 5.2/5.1
export const LADDER = ['avc1.64002a', 'avc1.640032', 'avc1.640033', 'avc1.640034', 'avc1.4d402a', 'avc1.4d4032'];
// ×14 / ×10 / ×8 of the 144 render (integer nearest, every Argonaut pixel the same size). 2016 = Le 2026-09-24 ("2000×2000")
export const SIZES = [2016, 1440, 1152];
export const bitrateFor = size => (size >= 2016 ? 24_000_000 : BITRATE);          // ~same bits per pixel as 1440 @ 12 Mb/s

export class ExportError extends Error { constructor(code, msg) { super(msg || code); this.code = code; this.name = 'ExportError'; } }

const G = globalThis;
export const supported = (env = G) => typeof env.VideoEncoder === 'function' && typeof env.VideoFrame === 'function';

let muxerP = null;
/** load the vendored muxer once (classic script → global Mp4Muxer); a failure clears the cache so a retry works (N10) */
export function loadMuxer(env = G) {
  if (env.Mp4Muxer) return Promise.resolve(env.Mp4Muxer);
  if (muxerP) return muxerP;
  muxerP = new Promise((resolve, reject) => {
    const doc = env.document, s = doc.createElement('script');
    s.src = MUXER_SRC; s.integrity = MUXER_SRI; s.async = true;
    // only the IN-FLIGHT load is cached (after it, the global is the cache); 9b GO fable P3: a load without the global is retryable
    s.onload = () => { muxerP = null; if (env.Mp4Muxer) resolve(env.Mp4Muxer); else { s.remove(); reject(new ExportError('muxer', 'the video muxer did not load')); } };
    s.onerror = () => { muxerP = null; s.remove(); reject(new ExportError('muxer', 'could not load the video muxer')); };
    doc.head.append(s);
  });
  return muxerP;
}

/** the first encoder config the browser accepts, probed with the EXACT config that will be used (N9) */
export async function pickConfig(env = G, sizes = SIZES) {
  for (const fps of [60, 30]) for (const size of sizes) for (const codec of LADDER) for (const hardwareAcceleration of ['prefer-hardware', 'prefer-software']) {
    const config = { codec, width: size, height: size, bitrate: bitrateFor(size), framerate: fps, bitrateMode: 'constant', latencyMode: 'quality', hardwareAcceleration };
    try { const r = await env.VideoEncoder.isConfigSupported(config); if (r && r.supported) return { config, fps, size, stepsPerFrame: 60 / fps }; } catch { /* next rung */ }
  }
  return null;
}

/** the size menu (Le 2026-09-24): which of SIZES this device can encode, asked up front → Map size → {fps} | null */
export async function probeSizes(env = G) {
  const out = new Map();
  for (const size of SIZES) { const p = await pickConfig(env, [size]); out.set(size, p ? { fps: p.fps } : null); }
  return out;
}

/** integer nearest-neighbour upscale of a 144×144 RGBA frame into an S×S RGBA buffer (S a multiple of 144) */
export function upscale(src, dst, S) {
  const k = S / OUT;
  if (!Number.isInteger(k)) throw new Error('size must be a multiple of 144');
  for (let y = 0; y < OUT; y++) {
    const row = y * k * S * 4;
    for (let x = 0; x < OUT; x++) {
      const s = (y * OUT + x) * 4, r = src[s], g = src[s + 1], b = src[s + 2], a = src[s + 3];
      for (let i = 0, d = row + x * k * 4; i < k; i++, d += 4) { dst[d] = r; dst[d + 1] = g; dst[d + 2] = b; dst[d + 3] = a; }
    }
    for (let i = 1; i < k; i++) dst.copyWithin(row + i * S * 4, row, row + S * 4);
  }
  return dst;
}

/** the frame source shared by both views: its OWN engine (or none), frame f = the state after 1 + f·spf steps (N9) */
function frameSource(inputs, env) {
  const eng = inputs.engine ? makeAcEngine(env.document.createElement('canvas'), inputs.engine.comp, inputs.engine.credit) : null;
  const target = { width: OUT, height: OUT };
  const cap = { createImageData: (w, h) => new env.ImageData(w, h), putImageData(img) { this.last = img; } };
  const { layers, bgLayers, marks } = inputs, slot = inputs.engine ? inputs.engine.slot : null;
  const frame = new Uint8ClampedArray(OUT_PX * 4), bgFrame = new Uint8ClampedArray(OUT_PX * 4);
  if (!eng) { composeFrame(layers, marks, null, null, frame); composeFrame(bgLayers, null, null, null, bgFrame); }   // static: once
  return {
    frame, bgFrame, back: wantsBackSlab(eng, slot),
    step(f, spf, withBg) {
      if (!eng) return;
      const rgb = stepPaintCompose(eng, f === 0 ? 1 : spf, target, cap, layers, marks, slot, frame);
      if (withBg) composeFrame(bgLayers, null, slot, rgb, bgFrame);
    },
  };
}

/** 2D job — call SYNCHRONOUSLY in the click handler (N2): its own engine from what the stage applied */
export function prepare2D(inputs, env = G) {
  if (!inputs || !inputs.engine) throw new ExportError('no-engine', 'MP4 needs a running engine');
  const src = frameSource(inputs, env);
  return {
    kind: '2d',
    render(f, spf) { src.step(f, spf, false); },
    frame: () => src.frame,                                    // (tests)
    draw(ctx, img, size) { upscale(src.frame, img.data, size); ctx.putImageData(img, 0, 0); },
    dispose() {},
  };
}

/** Cubes job (9c) — SYNCHRONOUS part now (the engine, N2); the GL instance is made in setup(size) once the size is known.
 *  `makeGL(inputs, size)` = cubes.js createCubesExport (the only importer of the core, CC4), injected by the caller. */
const SETUP_TEXT = {
  empty: 'this Argonaut has nothing to build in cubes', size: 'this device cannot draw cubes that large', webgl: 'Cubes need WebGL2 to export',
};
export function prepareCubes(inputs, makeGL, env = G) {
  if (!inputs) throw new ExportError('no-argonaut', 'no Argonaut on the stage');
  const src = frameSource(inputs, env);
  const grey = new Uint8ClampedArray(OUT_PX * 4);
  for (let i = 0; i < OUT_PX; i++) { grey[i * 4] = 0xf4; grey[i * 4 + 1] = 0xf5; grey[i * 4 + 2] = 0xf6; grey[i * 4 + 3] = 255; }
  let gl = null;
  return {
    kind: 'cubes',
    setup(size) {
      try { gl = makeGL({ layers: inputs.layers, back: src.back }, size, env); }
      catch (e) {                                              // 9c GO sonnet P3: an unexpected throw keeps its own text (console), never only "WebGL2"
        const code = e.message === 'empty' ? 'empty' : e.message === 'size' ? 'size' : 'webgl';
        if (code === 'webgl' && e.message !== 'webgl' && env.console) env.console.error('[mp4] cubes setup', e);
        throw new ExportError(code, SETUP_TEXT[code]);
      }
    },
    render(f, spf) { src.step(f, spf, true); },
    draw(ctx, img, size, f, N, fps) {
      upscale(src.back ? grey : src.bgFrame, img.data, size); ctx.putImageData(img, 0, 0);   // the flat backdrop (or the page grey)
      gl.render(src.frame, src.bgFrame, f, N, fps);
      if (gl.lost()) throw new ExportError('lost', 'the graphics context was lost');
      ctx.drawImage(gl.canvas, 0, 0, size, size);
    },
    dispose() { if (gl) gl.dispose(); gl = null; },
  };
}

/**
 * Encode the job. opts: { onProgress(p), shouldAbort(), isHidden(), waitVisible() → Promise, writable?, size?, env }.
 * With `writable` the result has blob: null (the video is in the file).
 * Resolves { blob, fps, size, frames }; rejects ExportError('cancelled' | 'unsupported' | 'interrupted' | 'stalled' | …).
 */
const TIMEOUT_TEXT = {                                         // 9c GO opus P3-3: one message per guarded await
  muxer: 'the video muxer did not load', unsupported: 'this browser did not answer the video check', stalled: 'the video encoder stopped responding',
};
export async function runExport(job, opts = {}) {
  const env = opts.env || G, now = () => env.performance.now();
  const tick = () => new Promise(r => env.setTimeout(r, 0));
  const shouldAbort = opts.shouldAbort || (() => false), isHidden = opts.isHidden || (() => !!(env.document && env.document.hidden));
  const waitVisible = opts.waitVisible || (() => new Promise(r => {
    const h = () => { if (!env.document.hidden) { env.document.removeEventListener('visibilitychange', h); r(); } };
    env.document.addEventListener('visibilitychange', h);
  }));
  let encoder = null, err = null, lastOut = 0;                 // cleanup handles OUTSIDE the try (lesson: video-export)
  const abortCheck = () => { if (shouldAbort()) throw new ExportError('cancelled'); };
  /** 9b GO opus P2-1: every await outside the frame loop can be cancelled (polled every 250 ms) and has a ceiling */
  const guarded = (p, limitMs, code) => new Promise((resolve, reject) => {
    const t0 = now();
    const poll = () => {
      if (shouldAbort()) return reject(new ExportError('cancelled'));
      if (now() - t0 > limitMs) return reject(new ExportError(code, TIMEOUT_TEXT[code]));
      timer = env.setTimeout(poll, 250);
    };
    let timer = env.setTimeout(poll, 250);
    p.then(v => { env.clearTimeout && env.clearTimeout(timer); resolve(v); }, e => { env.clearTimeout && env.clearTimeout(timer); reject(e); });
  });
  const pauseWhileHidden = async () => {                       // N4 (+ 9b GO sonnet/opus P3-4: also inside backpressure)
    if (!isHidden()) return;
    await waitVisible();
    abortCheck();
    if (encoder && encoder.state === 'closed') throw new ExportError('interrupted', 'the browser stopped the video encoder while the tab was hidden — try again');
    lastOut = now();                                           // the watchdog does not count the hidden time
  };
  try {
    const Mp4Muxer = await guarded(loadMuxer(env), 30_000, 'muxer'); abortCheck();
    const pick = await guarded(pickConfig(env, opts.size ? [opts.size] : SIZES), 30_000, 'unsupported'); abortCheck();   // opts.size: the menu's choice
    if (!pick) throw new ExportError('unsupported', 'this browser cannot encode the video');
    const { config, fps, size, stepsPerFrame } = pick, N = Math.round((opts.seconds || SECONDS) * fps);   // opts.seconds: tests only
    if (job.setup) job.setup(size);                            // Cubes: the GL instance at the exact size (9c)
    const canvas = env.document.createElement('canvas'); canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(size, size);
    // opts.writable (desktop, Punks' way): the file picked in "Save as" BEFORE the export — the video is written straight
    // into it (plain MP4, moov at the end; the muxer seeks back to patch sizes). Otherwise in memory, moov first (phones).
    const toFile = !!opts.writable;
    const muxer = new Mp4Muxer.Muxer({
      target: toFile ? new Mp4Muxer.FileSystemWritableFileStreamTarget(opts.writable) : new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: 'avc', width: size, height: size, frameRate: fps }, fastStart: toFile ? false : 'in-memory',
    });
    encoder = new env.VideoEncoder({
      output: (chunk, meta) => { lastOut = now(); try { muxer.addVideoChunk(chunk, meta); } catch (e) { err = err || e; } },   // 9b GO opus P3-5
      error: e => { err = err || e; },
    });
    encoder.configure(config);
    lastOut = now();
    for (let f = 0; f < N; f++) {
      abortCheck();
      if (err) throw err;
      await pauseWhileHidden();
      job.render(f, stepsPerFrame);
      job.draw(ctx, img, size, f, N, fps);
      const vf = new env.VideoFrame(canvas, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
      try { encoder.encode(vf, { keyFrame: f % (fps * 2) === 0 }); } finally { vf.close(); }
      while (encoder.encodeQueueSize > 2) {                    // backpressure + watchdog
        abortCheck();
        if (err) throw err;
        await pauseWhileHidden();
        if (now() - lastOut > WATCHDOG_MS) throw new ExportError('stalled', 'the video encoder stopped responding');
        await tick();
      }
      if (opts.onProgress) opts.onProgress((f + 1) / N);
      await tick();                                            // let the encoder output drain (muxer) between frames
    }
    await guarded(encoder.flush(), WATCHDOG_MS * 3, 'stalled'); // a flush that never resolves no longer hangs the export
    abortCheck();
    if (err) throw err;
    muxer.finalize();                                          // with a file: the caller then close()s it (and abort()s it on any error)
    return { blob: toFile ? null : new env.Blob([muxer.target.buffer], { type: 'video/mp4' }), fps, size, frames: N };
  } finally {
    if (encoder && encoder.state !== 'closed') { try { encoder.close(); } catch { /* already gone */ } }
    try { job.dispose(); } catch { /* best effort */ }
  }
}
