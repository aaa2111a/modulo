// The Cubes view (chunk 7c, design app-plan/13-chunk7-synthesis.md D2'-D6, G4-G6, G9-G12, G15-G21): the adapter
// between the stage's sink contract (stage.js `out()`) and the verbatim Modulo Punks voxel core (cubes-core.js —
// the ONLY importer of it, CC4). Written by hand after Punks' modal adapter (_3dEnsure / _3dSpin / _3dSetOn, drag):
//  - show the canvas BEFORE init (a hidden canvas measures 0 → oversized GL buffer); context listeners added ONCE;
//    never loseContext() (the canvas is reused);
//  - lazy rebuild INSIDE draw() (G15): the geometry depends on the Argonaut and on `back` (engine on Background);
//    a false from setPunk / 0 figure cells / any GL throw → fail() (G9, G2) — never into the engine's try;
//  - D7 relief (Le): every cell covered by a layer above Bones gets a second cube at z=+1 (`raised`, a core param);
//  - rgb always 1152 cells (G17): 0..575 = figure colours (centre of each 6×6 cell of the full frame), 576..1151 =
//    back slab (the Background layer alone, already opaque, G19);
//  - spin = Punks' curve (faster edge-on), scaled by dt so it is frame-rate independent; reduced motion: no idle spin
//    and no inertia, drag only (the single reduced-motion source for the loop gate, 7b G8 deviation).
// Contract with the stage: draw() never calls back into the stage (it may only request kick() OUTSIDE draw).
import { create3d } from './cubes-core.js';
import { figureMask, raisedMask, countCells, silhouettePixels, sampleCells, RGB_CELLS, CELLS } from './cubes-feed.js';

const MARGIN = 1.15, MARGIN_SLAB = 1.5;                        // Punks modal fit; wider with the back slab (G18)
const START_PITCH = -0.10, START_YAW = -0.52;                   // Punks _td initial pose
const FRAME_MS = 1000 / 60;

/**
 * @param canvas  the #cubes canvas (sibling right after #stage, G4)
 * @param opts    { reduced: MediaQueryList, kick(), onFail(reason, err), onChange(), onRestored() }
 *                onChange = availability changed while idle (context lost in 2D); onRestored = the context came back
 */
export function createCubes(canvas, { reduced, kick, onFail, onChange, onRestored }) {
  const core = create3d();
  const rgb = new Uint8ClampedArray(RGB_CELLS * 4);
  const idx = new Uint8Array(CELLS);                           // unused by mode 'normal' (L3374-3376), required by the signature
  let inited = false, active = false, lost = false, unavailable = false;
  let mask = null, raised = null, cells = 0, builtBack = null;                // builtBack: null = must rebuild; else the `back` it was built with
  let pitch = START_PITCH, yaw = START_YAW, vYaw = 0, vPitch = 0, dragging = false, px = 0, py = 0, clock = 0;

  function fail(reason, err) {
    active = false; dragging = false; builtBack = null; canvas.hidden = true;
    if (reason !== 'empty') unavailable = reason !== 'lost';     // no WebGL2 / compile failure: stays off for this page
    onFail(reason, err);
    return false;
  }

  /** time-scaled Punks _3dSpin (per 60 Hz frame: inertia ×0.94, idle 0.0015 + 0.004·(1 − |cos yaw|)) */
  function spin(dtMs) {
    if (dragging || reduced.matches || !dtMs) return;
    const k = dtMs / FRAME_MS;
    if (vYaw || vPitch) {
      yaw += vYaw * k; pitch = Math.max(-1.45, Math.min(1.45, pitch + vPitch * k));
      const d = Math.pow(0.94, k); vYaw *= d; vPitch *= d;
      if (Math.abs(vYaw) < 0.0028) vYaw = 0; if (Math.abs(vPitch) < 0.0028) vPitch = 0;
    } else yaw += (0.0015 + 0.004 * (1 - Math.abs(Math.cos(yaw)))) * k;
  }

  // ── drag (Pointer Events; touch-action: pan-y in the CSS → a vertical swipe scrolls the page and cancels the drag) ──
  const endDrag = () => { dragging = false; };
  canvas.addEventListener('pointerdown', e => {
    if (!active) return;
    dragging = true; vYaw = vPitch = 0; px = e.clientX; py = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the window listeners below still end the drag */ }
    kick();
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dy = (e.clientX - px) * 0.01, dx = e.pointerType === 'touch' ? 0 : (e.clientY - py) * 0.01;   // touch: yaw only (Le)
    yaw += dy; pitch = Math.max(-1.45, Math.min(1.45, pitch + dx));
    if (!reduced.matches) { vYaw = Math.max(-0.05, Math.min(0.05, dy)); vPitch = Math.max(-0.05, Math.min(0.05, dx)); }
    px = e.clientX; py = e.clientY;
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(ev, endDrag);
  window.addEventListener('pointerup', endDrag);               // G5: a release / cancel that lands elsewhere still ends it
  window.addEventListener('pointercancel', endDrag);

  function ensureInit() {
    if (inited) return true;
    if (!core.init(canvas, MARGIN)) return false;
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); core.lost(); lost = true; builtBack = null;
      if (active) fail('lost'); else onChange();                  // 7c GO fable P2: lost while in 2D → the toggle is re-synced (disabled) too
    });
    canvas.addEventListener('webglcontextrestored', () => { lost = false; builtBack = null; onRestored(); });   // re-enable only; rebuild on next use
    inited = true;
    return true;
  }

  return {
    /** 2D → Cubes. The canvas is shown FIRST (it must be laid out before the core measures it). */
    enter() {
      if (unavailable || lost) return false;
      canvas.hidden = false;
      if (!ensureInit()) { fail('webgl'); return false; }
      active = true; dragging = false; vYaw = vPitch = 0; builtBack = null;
      return true;
    },
    /** Cubes → 2D (G5: a drag in progress is dropped here, not left to a pointercancel that may never come) */
    leave() { active = false; dragging = false; vYaw = vPitch = 0; canvas.hidden = true; },

    // ── the stage's view contract ──
    draw(frame, bgFrame, back, dtMs) {
      if (!active) return false;
      if (lost) return fail('lost');
      try {
        canvas.hidden = false;                                  // G6: back from a reset (unverified Argonaut) → shown again
        if (builtBack !== back) {
          if (!mask || !cells) return fail('empty');
          if (!core.init(canvas, back ? MARGIN_SLAB : MARGIN)) return fail('webgl');   // init() only sets canvas + fit margin
          if (!core.setPunk(silhouettePixels(mask), 0, back, raised)) return fail('webgl');   // G9: false = no WebGL2 / no context; D7 relief
          builtBack = back;
        }
        sampleCells(frame, rgb, 0);
        if (back) sampleCells(bgFrame, rgb, CELLS);
        spin(dtMs); clock += dtMs;
        core.render(rgb, idx, 0, pitch, yaw, clock, null);      // G21: mode 'normal' only
        return true;
      } catch (e) {                                               // 7c GO opus P3-1: a throw on a context lost before its event arrived is 'lost' (recoverable)
        let gone = false; try { gone = !!canvas.getContext('webgl2')?.isContextLost(); } catch { /* treat as a real error */ }
        return fail(gone ? 'lost' : 'error', e);
      }
    },
    wantsFrame: () => active && !lost && (dragging || !reduced.matches),
    // mask/raised/cells change ONLY together with `builtBack = null` — that is what forces the next draw() to rebuild
    // (the rebuild guard compares builtBack with `back`, not the masks). Keep them in one place (D7 GO sonnet P2).
    onArgonaut(layers) { mask = figureMask(layers); raised = raisedMask(layers); cells = countCells(mask); builtBack = null; },
    onReset() {
      mask = null; raised = null; cells = 0; builtBack = null; dragging = false;
      // 7c GO opus P3-3: only clear a context the core already created (never create a default-attribute one here)
      if (inited && !lost && core.isReady()) { try { const gl = canvas.getContext('webgl2'); if (gl) gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); } catch { /* nothing to clear */ } }
      canvas.hidden = true;                                     // pDB: never show the previous Argonaut (G6, chunk-6 invariant)
    },

    // ── UI helpers ──
    get active() { return active; },
    get lost() { return lost; },
    /** can Cubes be offered? (the figure is only known once attached — an empty one fails on entry with its own note) */
    available: () => !unavailable && !lost,
    /** PNG of the cubes view: the 2D backdrop (nearest, 144 → size) + the GL image (smoothed), centre square. null if not ready. */
    png(backdrop, size = 1152) {
      if (!active || lost || !core.isReady() || builtBack === null) return null;
      core.render(rgb, idx, 0, pitch, yaw, clock, null);        // a fresh frame in the same task (render-then-read)
      const c = document.createElement('canvas'); c.width = c.height = size;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false; x.drawImage(backdrop, 0, 0, size, size);
      const w = canvas.width, h = canvas.height, s = Math.min(w, h);
      x.imageSmoothingEnabled = true; x.drawImage(canvas, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
      return c.toDataURL('image/png');
    },
  };
}
