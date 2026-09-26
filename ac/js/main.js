// Project AC — UI controller (mobile-first, one screen). Paste a wallet (0x or name.eth) → read ONLY that wallet's
// Argonauts + Credits → pick one of each + a Modulo Artifact as the engine → the chosen Argonaut layer animates
// with the artifact's motion in the Credit's colours/pattern.
// Rules honoured here: a failed read is an ERROR (never "you own nothing"); burned Argonauts are not available;
// every async step carries a turn/generation token so a stale answer never paints over a newer choice; what the UI
// shows as selected is what the stage shows (a failed switch reverts the highlight); chain SVGs only as
// <img src="data:…">; DOM only through el()/textContent; engines only via makeAcEngine (A4).
import { createRpc } from './rpc.js?v=3037fe4613';
import { RPC_URL, MAX_BATCH } from './config.js?v=761d2a9845';
import { normalizeAddress, toChecksumAddress, ADDR } from './abi.js?v=0e6f5624d9';
import { looksLikeEns, resolveEns, EnsError } from './ens.js?v=09e749d09f';
import { readArgonauts, readCredits, readCreditData, readArgonautTraits } from './holdings.js?v=603cbc0ecb';
import { loadRendererConfig, createBlobStore, renderVerified, collectionTraits, drawList, LAYER, LAYER_LABEL, ArgonautError } from './argonaut.js?v=daf77ad712';
import { prepareLayers, composeFrame, downsample, offeredLayers, OUT } from './compose.js?v=607ac14ea1';
import { creditEngineInput, creditSvg } from './credit.js?v=0a4863eedb';
import { readTotalArtifacts, readArtifactComposition } from './artifacts.js?v=8b62b12a0e';
import { makeAcEngine } from './engine-ac.js?v=8410dea0c1';
import { createStage } from './stage.js?v=871ea22760';
import { createCubes, createCubesExport } from './cubes.js?v=35624bc995';
import { FX } from './fx.js?v=abd4dbc130';
import { supported as mp4Supported, prepare2D, prepareCubes, prepareFx, runExport, probeSizes } from './mp4.js?v=bf17af48e0';
import { el, $, svgDataUrl, shortAddr } from './dom.js?v=cc96e51d51';
import './metal.js?v=7488ca6bd5';                                          // tilt + light of the metal buttons (wallet arrow, 2D)
import './dock-space.js?v=3b537f7f7b';
import { createLoadingUI } from './loading-ui.js?v=3c31eafae4';

const rpc = createRpc(RPC_URL, { maxBatch: MAX_BATCH, timeoutMs: 30000 });
let storage = null;
try { storage = window.sessionStorage; } catch { /* blocked storage: memory cache only */ }
const blobs = createBlobStore(rpc, { storage });
const stage = createStage($('stage'), {
  onError: e => { S.engineOn = null; appliedEngine = null; markOn($('engineStrip'), null); syncEngineLabel(); note('Engine stopped · ' + msg(e), true); },
  onViewError: e => cubesFailed('error', e),                  // a throw that escaped the Cubes view (the stage already fell back to 2D)
  onFxError: e => fxFailed(e),                                // Checks/Stars could not paint (the 2D frame underneath is current)
});

const CREDIT_PAGE = 24, THUMB_BATCH = 24, BOOT_DEADLINE_MS = 6000;
const S = {
  walletTurn: 0, argoTurn: 0, engTurn: 0, gen: 0,            // gen = one opened wallet (openApp); guards pages/strips
  wallet: null, cfgPromise: null,
  argoIds: [], creditIds: [], creditBlock: null, creditData: new Map(), creditsShown: 0, creditsLoadingGen: null,
  argo: null, shown: null, argoBlobOf: null, credit: null, creditInput: null,
  artifactId: 1, engineOn: null, total: 0, comps: new Map(), slot: LAYER.BODY,
  loadingArgo: false, loadingEngine: false, booting: false,
  view: '2d',                                                 // '2d' | 'cubes' — a UI preference; survives Argonaut/Credit/engine changes, not a wallet change
  fx: null,                                                   // Checks & Stars over 2D or Cubes: null | 'check' | 'gold' | 'silver' (Le 2026-09-26); same lifetime as view
};
const msg = e => (e && e.message) || String(e);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const loadingUI = createLoadingUI($('stageLoader'), $('loaderText'), { reduced: reducedMotion });
reducedMotion.addEventListener('change', () => syncLoader(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) syncLoader(true); });
let appliedEngine = null, pipRevision = 0, stageReveal = 0;
let screenTimer = 0, finishScreen = null;
/** the sheets (<dialog> children of <body>): every screen change closes them first (chunk 8 H2) */
const SHEETS = ['traitsDlg', 'howDlg', 'mp4Dlg'];
function closeSheets() { for (const id of SHEETS) { const d = $(id); if (d && d.open) d.close(); } }
function changeScreen(from, to, focus, onHidden = () => {}) {
  closeSheets();
  if (finishScreen) finishScreen();
  from.inert = true;
  const finish = () => {
    clearTimeout(screenTimer); finishScreen = null;
    from.hidden = true; from.classList.remove('screen-leaving'); from.inert = false;
    onHidden();
    to.hidden = false; to.inert = false;
    focus.focus({ preventScroll: true });
  };
  finishScreen = finish;
  if (reducedMotion.matches || document.hidden || from.hidden) finish();
  else { from.classList.add('screen-leaving'); screenTimer = setTimeout(finish, 220); }
}
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) finishScreen?.(); });

// ── Cubes view (chunk 7c) ── the 3D is a pure view of the stage's composed frame; it owns no async state (D4)
const cubes = createCubes($('cubes'), {
  reduced: reducedMotion,
  kick: () => stage.kick(),
  onFail: (reason, e) => cubesFailed(reason, e),
  onChange: () => syncViewUI(),
  onRestored: () => {                                         // Codex review P2 (+ GO): only the lost-context note goes away — never an engine error, never "Cubes unavailable"
    if (cubesNote === FAIL_TEXT.lost && $('stageNote').textContent === cubesNote) note('');
    if (cubesNote === FAIL_TEXT.lost) cubesNote = '';
    syncViewUI();
  },
});
reducedMotion.addEventListener('change', () => stage.kick());   // motion allowed again → the idle spin resumes (7b G8 condition)
const FAIL_TEXT = { empty: 'This Argonaut has nothing to build in cubes', lost: 'Cubes paused · the graphics context was lost', webgl: 'Cubes unavailable on this browser (no WebGL2)', error: 'Cubes unavailable' };
let cubesNote = '';                                            // the Cubes note on screen (cleared by a successful re-entry, never an engine error)
function cubesFailed(reason, e) {
  cubes.leave();                                              // 7c GO opus P3-2: idempotent — the GL canvas never stays over the 2D
  S.view = '2d'; syncViewUI();
  cubesNote = FAIL_TEXT[reason] + (reason === 'error' && e ? ' · ' + msg(e) : '');
  note(cubesNote, reason !== 'empty');
  // never re-enter the stage from inside its sink (view contract); the style carries over to the 2D after the detach
  queueMicrotask(() => { stage.setView(null); applyFx(); });
}
// ── Checks & Stars (Le 2026-09-26): a STYLE over the 2D or the Cubes view, chosen in the pill inside the render (tap the
// active one again = off). 2D → the stage paints the engine's check / star glyphs on #fx; Cubes → the voxel core's own
// check / gold / silver modes, on the animated layer only (cubes.js). Only one of the two canvases ever carries it.
function applyFx() {
  const on2d = !!S.fx && S.view === '2d';
  if (on2d) stage.setFx(S.fx, $('fx'), { reduced: reducedMotion }); else stage.setFx(null);
  cubes.setFx(S.view === 'cubes' ? S.fx : null);
  syncViewUI();
}
function fxFailed(e) {                                        // the stage already dropped the fx; the 2D frame is current
  S.fx = null; cubes.setFx(null); syncViewUI();
  note('Checks unavailable · ' + msg(e), true);
}
function setViewMode(mode) {
  if (mode === S.view) return;
  if (mode === 'cubes') {
    if (!S.argo) { syncViewUI(); return; }
    if (!cubes.available()) { syncViewUI(); cubesNote = cubes.lost ? FAIL_TEXT.lost : FAIL_TEXT.webgl; note(cubesNote, true); return; }   // 7c GO fable P2: a refused entry says why
    stage.setFx(null);                                        // the 2D style canvas never runs under the Cubes view
    if (!cubes.enter()) { applyFx(); return; }                // enter() failing already went through fail() → cubesFailed (note + UI)
    if (cubesNote && $('stageNote').textContent === cubesNote) note('');   // a previous Cubes failure note goes away on a good re-entry
    cubesNote = '';
    S.view = 'cubes'; cubes.setFx(S.fx); stage.setView(cubes);
  } else {
    S.view = '2d'; cubes.leave(); stage.setView(null);
  }
  applyFx();
}
/** the pill (Le 2026-09-26): its first button IS the check — closed it is grey and alone; a tap turns checks on and opens
 *  gold / silver beside it. Tapping another style switches; tapping the ACTIVE one = off (the pill folds, plain render). */
function setFxStyle(name) {
  if (!FX.includes(name)) return;
  S.fx = S.fx === name ? null : name;
  applyFx();
  syncMp4UI();                                                // (the kept-clip key ignores the view/style, like Cubes: the file name says which)
}
// ── MP4 (chunk 9b, app-plan/18-…) ── idle "MP4 ↓" → busy "Cancel · NN%" → done "Save MP4" (a fresh tap = a fresh user
// gesture for share/download, N5). The export reads ONLY its click-time snapshot (own engine), so the UI stays live;
// a wallet change (S.gen) aborts it. The live stage is held (paused) meanwhile and always released (N6).
// 9c: in the Cubes view the clip is the Cubes view (one full turn, M4); a static Argonaut is fine there (it still spins).
const MP4 = { state: 'idle', pct: 0, abort: false, file: null, note: '', at: 0 };
const IN_WEBVIEW = /\bwv\b/.test(navigator.userAgent);        // Android in-app WebView: cannot save a file (9b GO P3: say so BEFORE the 20 s)
function mp4State(state) { MP4.state = state; MP4.at = performance.now(); }   // `at`: a double tap right after a change is ignored
/** 9c GO fable P3 (+ delta P1): "Save MP4" is offered ONLY while the stage shows the content the clip was made from
 *  (Argonaut / engine / layer — the key is taken at the CLICK, with the same applied state as the file name). Otherwise the
 *  button is a plain "MP4 ↓" but the clip is KEPT: back on that content, "Save MP4" returns; a new export replaces it.
 *  The 2D/Cubes view is not part of the key (peeking at the other view keeps it; the name already says -cubes). */
const mp4Key = () => S.argo ? pngName(S.argo, appliedEngine, '') + '@' + (appliedEngine ? appliedEngine.slot : '') : '';
/** the file-name variant of what is on screen: the view ('' 2D · 'cubes') and the style when it shows (an engine runs):
 *  '' · 'cubes' · 'check' · 'cubes-gold' … (pngName spells 'check' as '-checks') */
const fxShows = () => !!S.fx && S.engineOn !== null;
const viewVariant = () => [S.view === 'cubes' ? 'cubes' : '', fxShows() ? S.fx : ''].filter(Boolean).join('-');
const mp4Ready = () => MP4.state === 'done' && !!MP4.file && (MP4.saving || MP4.key === mp4Key());
function syncMp4UI() {
  const b = $('mp4Btn'); if (!b) return;                      // H10: an old cached index.html has no MP4 button
  const label = b.querySelector('b') || b;
  if (MP4.state === 'busy') {
    label.textContent = `Cancel · ${MP4.pct}%`; b.disabled = false; b.title = 'Cancel the MP4';
    b.setAttribute('aria-label', `Cancel the MP4 · ${MP4.pct - MP4.pct % 5}%`);   // 9b GO P3: a screen reader hears 5 % steps, not every 1 %
    return;
  }
  b.removeAttribute('aria-label');
  if (mp4Ready()) { label.textContent = 'Save MP4'; b.disabled = false; b.title = MP4.file ? MP4.file.name : ''; return; }
  label.textContent = 'MP4';                                  // no arrow (Le 2026-09-26: the three-position row must fit a phone)
  const inp = S.argo ? stage.exportInputs() : null, cubed = S.view === 'cubes';
  const why = !mp4Supported() ? 'MP4 needs Chrome, Edge or Safari 16.4+' : IN_WEBVIEW ? 'Open this page in Chrome to make the MP4' : !inp ? ''
    : cubed ? (cubes.available() ? '' : 'Cubes are unavailable on this device') : !inp.engine ? 'MP4 needs a running engine' : '';
  b.disabled = !inp || !!why; b.title = why;
}
function mp4Note(text, err = false) {                         // only ever clears its OWN note (never an engine / Cubes error)
  if (text) { MP4.note = text; note(text, err); } else { if (MP4.note && $('stageNote').textContent === MP4.note) note(''); MP4.note = ''; }
}
// the size menu (Le 2026-09-24): which sizes this device can encode is asked ONCE, up front; until it answers the
// choices say "Checking…"; if the check itself fails, every size stays tappable (the export then reports what it can't do)
let sizeCheck = null;
function checkMp4Sizes() {
  if (sizeCheck || !mp4Supported()) return;
  sizeCheck = probeSizes().then(m => { MP4.sizes = m; }, () => { MP4.sizes = null; }).finally(syncMp4Sizes);
}
function syncMp4Sizes() {
  document.querySelectorAll('#mp4Dlg [data-size]').forEach(b => {
    const r = MP4.sizes === undefined ? undefined : MP4.sizes && MP4.sizes.get(+b.dataset.size);
    const sub = r === undefined ? 'Checking…' : r === null && MP4.sizes ? 'Not supported on this device' : b.dataset.sub + (r && r.fps === 30 ? ' · 30 fps' : '');
    b.disabled = r === undefined || (r === null && !!MP4.sizes);
    b.querySelector('span').textContent = sub;
  });
}
function startMp4(size) {
  const inp = S.argo ? stage.exportInputs() : null, cubed = S.view === 'cubes', fx = S.fx;
  if (!inp || (cubed ? !cubes.available() : !inp.engine)) return;
  let job;
  try { job = cubed ? prepareCubes(inp, createCubesExport, undefined, fx) : fx ? prepareFx(inp, fx) : prepare2D(inp); }   // N2: the export's own engine, built NOW (before any await)
  catch (e) { mp4Note('MP4 unavailable · ' + msg(e), true); return; }
  const name = pngName(S.argo, appliedEngine, viewVariant()).replace(/\.png$/, '.mp4');   // named from the same applied state (+ -cubes and/or -checks / -gold / -silver)
  const gen = S.gen, key = mp4Key();                           // both from THIS tap (the picker may stay open a while)
  // Desktop = the Modulo Punks way (Le 2026-09-24: "tap MP4, it finishes, nothing happens" is not intuitive): "Save as"
  // opens IN this tap — before any await, it needs the tap's activation — and the video is written straight into the
  // chosen file. Cancelling it = nothing happens. Denied / failed → the in-memory export + "Save MP4" (the phone flow).
  if (!matchMedia('(pointer: coarse)').matches && !IN_WEBVIEW && typeof window.showSaveFilePicker === 'function') {
    MP4.saving = true; MP4.at = performance.now(); syncMp4UI();
    let picked;
    try { picked = window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] }); }
    catch (e) { picked = Promise.reject(e); }                  // a sync throw never leaves `saving` stuck
    picked.then(h => h.createWritable()).then(w => {
      MP4.saving = false;
      if (gen !== S.gen) { w.abort().catch(() => {}); job.dispose(); return; }   // the wallet changed while the dialog was open
      encodeMp4(job, name, gen, key, w, size);
    }, e => {
      MP4.saving = false;
      if (gen !== S.gen || (e && e.name === 'AbortError')) { job.dispose(); return; }   // cancelled: nothing happens
      encodeMp4(job, name, gen, key, null, size);             // no file dialog here → the video is kept for "Save MP4"
    }).finally(() => { MP4.at = performance.now(); syncMp4UI(); });
    return;
  }
  encodeMp4(job, name, gen, key, null, size);
}
/** the export itself. `writable` = a file from "Save as" (desktop): written as it encodes, closed at the end, discarded
 *  (abort) on any failure or cancel — never a half file. Without it: in memory, then "Save MP4" (phones, no picker). */
function encodeMp4(job, name, gen, key, writable, size) {
  Object.assign(MP4, { pct: 0, abort: false, file: null, plain: false, key }); mp4State('busy');
  stage.hold(true); mp4Note('Exporting MP4 · keep this tab open'); syncMp4UI();
  runExport(job, {
    shouldAbort: () => MP4.abort || gen !== S.gen,
    onProgress: p => { const pct = Math.floor(p * 100); if (pct !== MP4.pct) { MP4.pct = pct; syncMp4UI(); } },
    writable, size,                                            // size: the menu's choice (undefined → the best this device can)
  }).then(async r => {
    if (writable) {                                            // the file is complete: keep it even if the screen moved on
      await writable.close(); writable = null;
      if (gen === S.gen) { const text = 'MP4 saved'; mp4Note(text); setTimeout(() => { if (MP4.note === text) mp4Note(''); }, 4000); }
      return;
    }
    if (gen !== S.gen) return;
    if (MP4.abort) { mp4Note(''); return; }                    // 9b GO P3: Cancel tapped after the last check = cancelled, not "Save"
    MP4.file = new File([r.blob], name, { type: 'video/mp4' }); mp4State('done');
    const text = 'Video ready · tap Save MP4';                 // the second tap is unavoidable without a file dialog: say so
    mp4Note(text); setTimeout(() => { if (MP4.note === text) mp4Note(''); }, 6000);
  }).catch(e => {
    if (writable) writable.abort().catch(() => {});             // no half-written file is left behind…
    // …but the browser created the picked file (0 bytes) when "Save as" was confirmed: say it can go (GO opus P3-1)
    const empty = writable ? ' · the empty file you picked can be deleted' : '';
    if (gen === S.gen) mp4Note(e && e.code === 'cancelled' ? (empty ? 'MP4 cancelled' + empty : '') : 'MP4 failed · ' + msg(e) + empty, !(e && e.code === 'cancelled'));
  }).finally(() => {
    if (MP4.state !== 'done') { mp4State('idle'); MP4.file = null; }
    stage.hold(false); syncMp4UI();
  });
}
function saveMp4() {
  const f = MP4.file;
  const finish = () => { MP4.file = null; MP4.plain = false; mp4State('idle'); syncMp4UI(); };
  if (!f) return finish();
  if (IN_WEBVIEW) { mp4Note('Open this page in Chrome to save the video', true); return; }   // Android in-app WebView
  // The plain download ALWAYS runs inside a tap (a script-clicked blob link without the tap's activation is what Chrome
  // dropped silently for Le) and KEEPS the clip armed: if nothing arrived, "Save MP4" is still there (save GO opus P2/P3).
  const download = () => {
    const url = URL.createObjectURL(f), a = el('a', { href: url, download: f.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    const text = 'Download started · tap Save MP4 again if nothing arrived';
    mp4Note(text); setTimeout(() => { if (MP4.note === text) mp4Note(''); }, 6000);   // the note covers the render: short-lived
  };
  if (MP4.plain) { download(); return; }                      // a dialog failed earlier → this tap is the fresh gesture
  // One OS dialog at a time, opened with NO await before it (the tap's user activation). Closing it yourself (AbortError)
  // keeps "Save MP4" armed as it was. Anything else — incl. NotAllowedError, which can mean the permission is BLOCKED, not
  // just an expired tap (Codex review: retrying the same dialog would fail again) — never downloads from here (no gesture
  // left) and never loops: it says why, and the NEXT tap downloads directly (MP4.plain). `saving` blocks a 2nd tap meanwhile.
  const viaDialog = (open, done) => {
    MP4.saving = true;
    let p;
    try { p = open(); } catch (e) { p = Promise.reject(e); }   // a sync throw never leaves `saving` stuck
    p.then(done).then(finish, e => {
      if (e && e.name === 'AbortError') return;
      MP4.plain = true;
      mp4Note((e && e.name === 'NotAllowedError' ? 'This browser did not allow saving there' : 'Saving there failed') + ' · tap Save MP4 again to download', true);
    }).finally(() => { MP4.saving = false; MP4.at = performance.now(); syncMp4UI(); });
  };
  const coarse = matchMedia('(pointer: coarse)').matches;
  // N5: phones → the share sheet (desktop canShare() opens an OS share dialog instead of saving)
  if (coarse && navigator.canShare && navigator.canShare({ files: [f] })) { viaDialog(() => navigator.share({ files: [f] }), () => {}); return; }
  // Desktop → the native "Save as" dialog, the Modulo / Punks way (CHANGELOG MP4 card export: desktop = showSaveFilePicker):
  // Chrome may drop a script-clicked blob download without a word (Le 2026-09-24, localhost Chrome).
  if (!coarse && typeof window.showSaveFilePicker === 'function') {
    viaDialog(() => window.showSaveFilePicker({ suggestedName: f.name, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] }),
      async h => { const w = await h.createWritable(); try { await w.write(f); await w.close(); } catch (e) { try { await w.abort(); } catch { /* gone */ } throw e; } });
    return;
  }
  download();                                                 // no share / no picker (Firefox, older Safari): inside this tap
}
function syncViewUI() {
  // D4 + 7c GO sonnet P3: no verified Argonaut (chain image only / none) → the control shows 2D and is disabled; the
  // 'cubes' preference itself is kept and resumes with the next verified Argonaut (G6)
  const shown = S.argo ? S.view : '2d';
  const LABEL = { '2d': '2D', cubes: 'Cubes' };
  document.querySelectorAll('.seg.views [data-view]').forEach(b => {
    const v = b.dataset.view, on = v === shown;
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !S.argo || (v === 'cubes' && !on && !cubes.available());
  });
  const knob = $('viewKnob'); if (knob) knob.textContent = LABEL[shown];
  // Checks & Stars: the pill shows while an engine runs on a verified Argonaut (the style means nothing on a static one);
  // the preference itself is kept meanwhile. #fx = the 2D style canvas: only over the 2D (Checks GO sonnet P2: an
  // unverified Argonaut / reset hides it too, not only blanks it)
  $('fxStyles').hidden = !(S.argo && S.engineOn !== null);
  $('fxStyles').classList.toggle('open', !!S.fx);             // open ⇔ a style is on (closed = plain render)
  $('fxToggle').setAttribute('aria-expanded', String(!!S.fx));
  $('fxOpts').inert = !S.fx;                                  // the folded styles are neither tappable nor focusable
  document.querySelectorAll('#fxStyles [data-fx]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fx === S.fx)));
  $('fx').hidden = !(S.argo && fxShows() && shown === '2d');   // GO fable P2: same rule as the file name (the style needs an engine)
  syncMp4UI();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) finishScreen?.(); });

function revealStage() {
  const box = $('stage').parentElement;
  clearTimeout(stageReveal);
  box.classList.remove('stage-changing');
  if (reducedMotion.matches) return;
  // Restart just the canvas entry; never animate the metal controls or engine clock.
  void box.offsetWidth;
  box.classList.add('stage-changing');
  stageReveal = setTimeout(() => box.classList.remove('stage-changing'), 170);
}

// ── helpers ──
function status(text, { err = false, retry = null } = {}) {
  const s = $('walletStatus');
  s.classList.toggle('err', err);
  s.replaceChildren(el('span', { text }), retry ? el('button', { class: 'retry', type: 'button', text: 'retry', onclick: retry }) : '');
}
function note(text, err = false) { const n = $('stageNote'); n.hidden = !text; n.classList.toggle('err', err); n.textContent = text || ''; }
/** the loading screen inside the stage card: shown while the Argonaut (or its first engine) is not ready yet.
 *  S.loadingArgo / S.loadingEngine hold the text of what is loading (or false), so the text always matches. */
function syncLoader(immediate = false) {
  const text = S.loadingArgo || S.loadingEngine;
  loadingUI(text, immediate || document.hidden);
}
function chainImage(svg) { const i = $('stageImg'); i.hidden = !svg; if (svg) i.src = svgDataUrl(svg); else i.removeAttribute('src'); }
function syncEngineLabel() {                                  // the engine state now lives in the Traits sheet (chunk 8; H7 loading text)
  const label = $('engineLabel');
  if (label) label.textContent = S.engineOn !== null ? 'Engine ' + pad(S.engineOn, 2) : S.shown && !S.argo ? 'On-chain image only'
    : S.loadingEngine ? 'Starting engine…' : S.shown ? 'No engine' : '';
  const tb = $('traitsBtn'), dlg = $('traitsDlg');
  if (tb) tb.disabled = !S.shown && !(dlg && dlg.open);        // H8: never disable the button whose sheet is open (focus returns there)
  $('pngBtn').disabled = !S.argo;                             // PNG only of a verified Argonaut actually on the canvas
  syncViewUI();
}
function getCfg() {
  if (!S.cfgPromise) S.cfgPromise = loadRendererConfig(rpc).catch(e => { S.cfgPromise = null; throw e; });
  return S.cfgPromise;
}
async function blobOfFor(blobIds) {
  const cfg = await getCfg();
  const ids = [...new Set(blobIds)];
  const got = await blobs.get(ids.map(i => cfg.blobPtr[i]));
  const m = new Map(ids.map((b, k) => [b, got[k]]));
  return b => m.get(b);
}
function markOn(strip, id) { strip.querySelectorAll('.tile').forEach(t => t.classList.toggle('on', id !== null && id !== undefined && String(id) === t.dataset.id)); }
const pad = (n, w) => String(n).padStart(w, '0');

/** lazy thumbnails: tiles observed inside their (horizontally scrolling) strip; visible ones are painted in batches,
 *  ONE batch at a time (single flight — a fast fling never fans out parallel RPC batches). */
function lazy(strip, paintBatch) {
  let queue = [], timer = 0, busy = false, alive = true;
  const grid = matchMedia('(pointer: fine)').matches;         // same condition as the CSS grid (@media (pointer: fine))
  const kick = delay => { if (!timer && !busy && alive && queue.length) timer = setTimeout(flush, delay); };
  const io = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting && !en.target.dataset.queued) { en.target.dataset.queued = '1'; queue.push(en.target); }
    kick(60);
  // Root = whichever element SCROLLS: on mouse/desktop the strip wraps into a grid and the PANEL scrolls vertically
  // (root = strip there would count every tile as visible → 99 thumbnails at once); on touch the STRIP scrolls
  // sideways, and rootMargin only extends the root — so it must be the strip for the side pre-load (opus GO P3).
  }, grid ? { root: strip.closest('.panel'), rootMargin: '160px 0px' } : { root: strip, rootMargin: '0px 240px' });
  async function flush() {
    timer = 0;
    if (!alive || busy) return;
    busy = true;
    const batch = queue.splice(0, THUMB_BATCH);
    try { await paintBatch(batch, () => alive); } catch { batch.forEach(t => t.classList.add('na', 'ready')); }   // cosmetic only; a failed thumb still appears (dimmed) so the tile stays selectable
    finally { busy = false; kick(0); }
  }
  return {
    async preload(tiles) {
      busy = true;
      tiles.forEach(t => { t.dataset.queued = '1'; });
      try { await paintBatch(tiles, () => alive); }
      catch { if (alive) tiles.forEach(t => t.classList.add('na', 'ready')); }
      finally { busy = false; kick(0); }
    },
    observe: tiles => tiles.forEach(t => io.observe(t)),
    /** re-evaluate (a panel became visible, or the thumbnails must be repainted) */
    refresh(tiles, repaint = false) { tiles.forEach(t => { if (repaint) delete t.dataset.queued; io.unobserve(t); io.observe(t); }); },
    disconnect() { alive = false; io.disconnect(); queue = []; if (timer) clearTimeout(timer); timer = 0; },
  };
}

// ── 1. wallet ──
async function submitWallet(raw) {
  const turn = ++S.walletTurn;
  const input = String(raw || '').trim();
  if (!input) return status('Paste a 0x address or a name.eth', { err: true });
  $('walletGo').disabled = true;
  try {
    let addr;
    if (looksLikeEns(input)) {
      status('Resolving ' + input.toLowerCase() + ' on-chain…');
      try { addr = await resolveEns(rpc, input); }
      catch (e) {
        if (turn !== S.walletTurn) return;
        if (e instanceof EnsError && e.code !== 'rpc') return status(e.message, { err: true });
        throw e;                                              // a failed read → error with retry
      }
    } else {
      try { addr = normalizeAddress(input); }
      catch { return status('Not a valid address — check the characters and the checksum', { err: true }); }
    }
    if (turn !== S.walletTurn) return;
    if (addr === ADDR.DEAD) return status('Burned Argonauts are not available', { err: true });
    const checksummed = toChecksumAddress(addr);
    status('Reading ' + checksummed);                         // full checksummed address, so the user can confirm it
    getCfg().catch(() => {});                                 // warm the renderer config in parallel
    const [argos, credits] = await Promise.all([readArgonauts(rpc, addr), readCredits(rpc, addr)]);
    if (turn !== S.walletTurn) return;
    if (!argos.ids.length && !credits.ids.length) return status(`${shortAddr(checksummed)} holds no Argonauts and no Credits`, { err: true });
    status('Paste any wallet · read only');
    Object.assign(S, { wallet: checksummed, argoIds: argos.ids, creditIds: credits.ids, creditBlock: credits.block, creditsShown: 0,
      argo: null, shown: null, credit: null, creditInput: null, engineOn: null });
    S.creditData.clear();
    await openApp();
  } catch (e) {
    if (turn !== S.walletTurn) return;
    status('Could not read the chain · ' + msg(e), { err: true, retry: () => submitWallet(input) });
  } finally { if (turn === S.walletTurn) $('walletGo').disabled = false; }
}

async function openApp() {
  const gen = ++S.gen;
  appliedEngine = null; ++pipRevision;
  S.loadingArgo = S.loadingEngine = false; syncLoader(true);
  S.booting = true;
  changeScreen($('landing'), $('pageLoader'), $('pageLoader'));
  $('walletShort').textContent = shortAddr(S.wallet);
  $('walletPill').title = S.wallet;
  $('argoCount').textContent = String(S.argoIds.length);
  $('creditCount').textContent = String(S.creditIds.length);
  $('argoTitle').textContent = ''; $('traitsList')?.replaceChildren(); $('layerChips').replaceChildren(); $('layerCount').textContent = '';
  $('pip').hidden = true; $('pipImg').removeAttribute('src'); chainImage(null); note('');   // no previous wallet's PiP to decode
  stage.reset(); syncEngineLabel();
  const thumbnails = renderArgoStrip(); renderCreditStrip(true);
  let bootStartsEngine = false;                               // true once the boot itself owns the first engine start
  const boot = (async () => {
    await Promise.all([
      thumbnails,
      renderEngineStrip(),
      S.argoIds.length ? selectArgo(S.argoIds[0]) : Promise.resolve(note('This wallet holds no Argonauts')),
      S.creditIds.length ? loadMoreCredits().then(() => {
        if (gen === S.gen && S.credit === null && S.creditData.has(S.creditIds[0])) selectCredit(S.creditIds[0]);
      }) : Promise.resolve(),
    ]);
    // After a deadline reveal (booting=false) every selection path starts its own engine → the boot must NOT start it
    // again (opus delta P2-A: double start = restart + flash of a user's newer choice).
    if (gen !== S.gen || !S.booting) return;
    bootStartsEngine = true;
    // setEngine paints its first frame synchronously before resolving.
    await startEngine();
    await Promise.all([...document.querySelectorAll('#creditStrip img, #pipImg')].filter(i => i.hasAttribute('src')).map(i => i.decode().catch(() => {})));
  })();
  boot.catch(() => {});                                       // a rejection after the deadline won the race is not unhandled (opus P3-A)
  try {
    // GO P2 (sonnet+opus): a slow RPC must not hold the full-screen boot for minutes. After BOOT_DEADLINE_MS the app is
    // revealed anyway; whatever is still loading keeps reporting through the stage loader / notes, and the boot keeps
    // running.
    await Promise.race([boot, new Promise(r => setTimeout(r, BOOT_DEADLINE_MS))]);
  } catch (e) {
    if (gen === S.gen) note('Could not prepare artwork · ' + msg(e), true);
  } finally {
    if (gen === S.gen) {
      S.booting = false;
      // Deadline reveal before the boot reached its engine start (e.g. the artifact strip is the slow member while the
      // Argonaut + Credit are ready): start it now from current state, else the stage stays static (opus P2-A).
      if (!bootStartsEngine) startEngine();
      changeScreen($('pageLoader'), $('app'), $('walletPill'));
    }
  }
}

// ── 2. Argonauts ──
let argoLazy = null;
function renderArgoStrip() {
  const strip = $('argoStrip');
  argoLazy?.disconnect();
  if (!S.argoIds.length) { strip.replaceChildren(el('div', { class: 'empty', text: 'No Argonauts in this wallet' })); return; }
  const tiles = S.argoIds.map(id => el('button', { class: 'tile', type: 'button', dataset: { id }, 'aria-label': 'Argonaut ' + id, onclick: () => selectArgo(id) },
    el('canvas', { width: 24, height: 24 }), el('div', { class: 'n', text: '#' + pad(id, 4) })));
  strip.replaceChildren(...tiles);
  argoLazy = lazy(strip, async (batch, alive) => {           // static thumbnails (no marks, no dragons variant — cosmetic)
    const cfg = await getCfg();
    const traits = await collectionTraits(rpc, await readArgonautTraits(rpc, batch.map(t => Number(t.dataset.id))));   // V6 re-assigned traits (GO opus P2)
    const lists = traits.map(x => drawList(cfg, x.traits, false));
    const blobOf = await blobOfFor(lists.flatMap(l => l.map(d => d.blobId)));
    if (!alive()) return;
    lists.forEach((l, k) => {
      const c = batch[k].querySelector('canvas');
      c.getContext('2d').putImageData(new ImageData(downsample(composeFrame(prepareLayers(l, blobOf), [], null, null)), 24, 24), 0, 0);
      batch[k].classList.add('ready');                          // tiles stay invisible until their thumbnail exists (Le)
    });
  });
  argoLazy.observe(tiles);
  if (S.booting) return argoLazy.preload(tiles.slice(0, 4));
}
async function selectArgo(id) {
  const turn = ++S.argoTurn;
  markOn($('argoStrip'), id);
  S.loadingArgo = 'Reading Argonaut #' + id; syncLoader();
  note('');
  try {
    const cfg = await getCfg();
    const argo = await renderVerified(rpc, cfg, blobs, id);
    if (turn !== S.argoTurn) return;
    if (!argo.verified) {                                     // our layers ≠ the chain's image: show ONLY the chain's image, no engine
      S.engTurn++; S.loadingEngine = false;
      stage.reset(); appliedEngine = null; S.argo = null; S.engineOn = null; S.shown = argo;
      markOn($('engineStrip'), null);                         // chain image only → no engine → no artifact highlighted
      pendingEngine(false); commitCreditUI();
      chainImage(argo.svg);
      $('argoTitle').textContent = 'Argonaut #' + pad(id, 4);
      renderLayerChips(); renderTags(argo); syncEngineLabel();
      return;
    }
    const blobOf = await blobOfFor(argo.drawList.map(d => d.blobId));
    if (turn !== S.argoTurn) return;
    stage.setArgonaut(argo, blobOf);                          // throws → caught below, previous state (and its pending engine) untouched
    appliedEngine = null; revealStage();
    S.engTurn++;                                              // only now: any engine still loading belongs to the previous Argonaut
    S.argo = argo; S.argoBlobOf = blobOf; S.shown = argo; S.engineOn = null; S.loadingEngine = false;
    chainImage(null);
    $('argoTitle').textContent = 'Argonaut #' + pad(id, 4);
    renderLayerChips(); renderTags(argo); syncEngineLabel();
    if (!S.booting) startEngine();
  } catch (e) {
    if (turn !== S.argoTurn) return;
    markOn($('argoStrip'), S.shown ? S.shown.tokenId : null);   // the highlight goes back to what the stage still shows
    note(e instanceof ArgonautError && e.code === 'renderer-changed' ? 'The Argonauts renderer changed · layers are off' : `Could not read Argonaut #${id} · ` + msg(e), true);
  } finally {
    if (turn === S.argoTurn) { S.loadingArgo = false; syncLoader(); }
  }
}
function renderTags(argo) {                                   // only the layers the renderer actually draws → the Traits sheet (chunk 8)
  const list = $('traitsList'); if (!list) return;             // H10: an old cached index.html without the sheet never breaks the app
  const drawn = argo ? [...new Set(argo.drawList.map(d => d.slot))].filter(s => typeof s === 'number').sort((a, b) => a - b) : [];
  const tags = drawn.map(layer => el('li', { class: 'tag', text: `${LAYER_LABEL[layer]} ${argo.traits[layer]}` }));
  if (S.creditInput) tags.push(el('li', { class: 'tag credit', text: `Credit #${S.credit} · ${S.creditInput.pal.length} inks` }));
  list.replaceChildren(...tags);
  const title = $('traitsTitle'); if (title) title.textContent = argo ? 'Argonaut #' + pad(argo.tokenId, 4) : 'Traits';
}

// ── 3. layers ──
function renderLayerChips() {
  const off = S.argo ? offeredLayers(S.argo.drawList, S.argoBlobOf) : [];
  if (!off.includes(S.slot)) S.slot = off.length ? off[0] : null;
  $('layerCount').textContent = String(off.length);
  if (!off.length) {
    const why = S.argo ? 'No layer of this Argonaut can be animated' : S.shown ? 'This Argonaut is shown as its on-chain image only' : 'Pick an Argonaut first';
    $('layerChips').replaceChildren(el('div', { class: 'empty', text: why }));
    return;
  }
  $('layerChips').replaceChildren(...off.map(slot => el('button', { class: 'chip' + (slot === S.slot ? ' on' : ''), type: 'button', dataset: { slot }, 'aria-pressed': String(slot === S.slot),
    onclick: () => { if (S.slot === slot) return; S.slot = slot; syncChips(); startEngine(); } },
    el('b', { text: LAYER_LABEL[slot] }), el('span', { text: 'trait ' + S.argo.traits[slot] }))));
}
function syncChips() {
  $('layerChips').querySelectorAll('.chip').forEach(b => {
    const on = Number(b.dataset.slot) === S.slot;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
}

// ── 4. Credits ──
function renderCreditStrip(reset) {
  const strip = $('creditStrip');
  if (!S.creditIds.length) { strip.replaceChildren(el('div', { class: 'empty', text: 'No Credits in this wallet — the Argonaut stays still' })); return; }
  if (reset) strip.replaceChildren();
  strip.querySelector('.more')?.remove();
  for (const id of S.creditIds.slice(strip.querySelectorAll('.tile').length, S.creditsShown)) {
    const d = S.creditData.get(id);
    strip.append(el('button', { class: 'tile', type: 'button', dataset: { id }, 'aria-label': 'Credit ' + id, onclick: () => selectCredit(id) },
      el('img', { alt: '', src: svgDataUrl(creditSvg(d.seed, d.paidAt)),
        onload: ev => ev.target.closest('.tile').classList.add('ready'),
        onerror: ev => ev.target.closest('.tile').classList.add('na', 'ready') }), el('div', { class: 'n', text: '#' + id })));
  }
  if (S.creditsShown < S.creditIds.length) strip.append(el('button', { class: 'tile more', type: 'button', text: `+${S.creditIds.length - S.creditsShown}`, onclick: loadMoreCredits }));
  markOn(strip, S.credit);
}
async function loadMoreCredits() {
  const gen = S.gen;
  if (S.creditsLoadingGen === gen) return;                   // one page at a time PER opened wallet (a stale load never blocks a new one)
  const next = S.creditIds.slice(S.creditsShown, S.creditsShown + CREDIT_PAGE);
  if (!next.length) return;
  S.creditsLoadingGen = gen;
  $('creditStrip').querySelector('.empty.err')?.remove();
  try {
    const data = await readCreditData(rpc, next, S.creditBlock);
    if (gen !== S.gen) return;
    for (const d of data) S.creditData.set(d.id, d);
    S.creditsShown += next.length;
    renderCreditStrip(false);
  } catch (e) {
    if (gen === S.gen) $('creditStrip').append(el('button', { class: 'empty err', type: 'button', text: 'Could not read Credits · ' + msg(e) + ' · retry', onclick: loadMoreCredits }));
  } finally { if (S.creditsLoadingGen === gen) S.creditsLoadingGen = null; }
}
function selectCredit(id) {
  if (S.credit === id && S.engineOn !== null) return;         // same Credit already running; otherwise a tap retries (GO P3)
  const d = S.creditData.get(id);
  if (!d) return;
  let input;
  try { input = creditEngineInput(d.seed, d.paidAt); }
  catch (e) { note('This Credit cannot drive the engine · ' + msg(e), true); return; }
  S.credit = id; S.creditInput = input;
  markOn($('creditStrip'), id);
  engineLazy?.refresh([...document.querySelectorAll('#engineStrip .tile')], true);
  if (!S.booting) startEngine();
}
function commitCreditUI() {
  const id = S.credit, d = S.creditData.get(id), revision = ++pipRevision, gen = S.gen;
  renderTags(S.shown);
  if (!d) { $('pip').hidden = true; return; }
  const src = svgDataUrl(creditSvg(d.seed, d.paidAt));
  const image = new Image();
  image.onload = () => {
    if (revision !== pipRevision || gen !== S.gen || id !== S.credit) return;
    $('pipImg').src = src; $('pipLabel').textContent = '#' + id; $('pip').hidden = false;
  };
  image.onerror = () => { if (revision === pipRevision) $('pip').hidden = true; };
  image.src = src;
}
function pendingEngine(on) {
  for (const id of ['creditStrip', 'engineStrip', 'layerChips']) {
    $(id).querySelectorAll('.tile, .chip').forEach(b => b.classList.toggle('pending', on && b.classList.contains('on')));
  }
}

// ── 5. engines (Modulo Artifacts 1..totalArtifacts(), open to future ones) ──
let engineLazy = null;
const getComp = id => {
  if (!S.comps.has(id)) S.comps.set(id, readArtifactComposition(rpc, id).catch(e => { S.comps.delete(id); throw e; }));
  return S.comps.get(id);
};
async function renderEngineStrip() {
  const gen = S.gen, strip = $('engineStrip');
  engineLazy?.disconnect(); engineLazy = null;
  let total;
  try { total = await readTotalArtifacts(rpc); }
  catch (e) {
    if (gen === S.gen) strip.replaceChildren(el('button', { class: 'empty err', type: 'button', text: 'Could not read the Modulo Artifacts · ' + msg(e) + ' · retry', onclick: renderEngineStrip }));
    return;
  }
  if (gen !== S.gen) return;                                  // another wallet opened meanwhile — its own call builds the strip
  S.total = total;
  if (S.artifactId > S.total) S.artifactId = 1;
  $('engineCount').textContent = String(S.total);
  const tiles = [];
  for (let id = 1; id <= S.total; id++) tiles.push(el('button', { class: 'tile', type: 'button', dataset: { id }, 'aria-label': 'Artifact ' + id, onclick: () => selectArtifact(id) },
    el('canvas', { width: OUT, height: OUT }), el('div', { class: 'n', text: 'ARTIFACT ' + pad(id, 2) })));
  strip.replaceChildren(...tiles);
  markOn(strip, S.engineOn);                                  // the strip highlights what RUNS (Le), even when it arrives late
  const cap = { createImageData: (w, h) => new ImageData(w, h), putImageData(img) { this.last = img; } };
  const scratch = el('canvas', { width: OUT, height: OUT });
  engineLazy = lazy(strip, async (batch, alive) => {
    const credit = S.creditInput;
    if (!credit) { batch.forEach(t => { delete t.dataset.queued; t.classList.add('ready'); }); return; }   // no Credit: show the (blank) tile, painted once one is chosen
    for (const tile of batch) {
      if (!alive()) return;
      try {
        const comp = await getComp(Number(tile.dataset.id));
        if (!alive()) return;
        if (credit !== S.creditInput) { delete tile.dataset.queued; continue; }
        const eng = makeAcEngine(scratch, comp, credit);
        for (let s = 0; s < 30; s++) { eng.step(eng.dtOps); eng.applyRects(); if (eng.tickRects) eng.tickRects(); }
        eng.paintTo({ width: OUT, height: OUT }, cap);
        tile.querySelector('canvas').getContext('2d').putImageData(cap.last, 0, 0);
        tile.classList.remove('na'); tile.classList.add('ready');
      } catch { tile.classList.add('na', 'ready'); }
      await new Promise(r => setTimeout(r, 0));             // keep the stage's rAF breathing between thumbnails
    }
  });
  engineLazy.observe(tiles);
  if ($('engineStrip').closest('.panel').classList.contains('on')) engineLazy.refresh(tiles);
}
function selectArtifact(id) { if (S.artifactId === id && S.engineOn === id) return; S.artifactId = id; markOn($('engineStrip'), id); startEngine(); }

// ── 6. the engine on the stage ──
async function startEngine() {
  const turn = ++S.engTurn;
  if (!S.argo || !S.creditInput || S.slot === null) {
    // Intentionally turn-agnostic: a synchronous UI reset from CURRENT state (nothing awaited). Any side effect added
    // here that depends on an earlier call's data must get a turn/gen guard (sonnet GO P3).
    if (S.argo) { stage.clearEngine(); S.engineOn = null; appliedEngine = null; }
    markOn($('engineStrip'), null);                           // no engine can run here → no artifact highlighted (Le)
    pendingEngine(false); commitCreditUI();
    S.loadingEngine = false; syncLoader(); syncEngineLabel();
    return;
  }
  const { argo, creditInput, credit, slot, artifactId } = S;
  ++pipRevision; pendingEngine(true);
  S.loadingEngine = 'Starting engine ' + pad(artifactId, 2); syncLoader(); syncEngineLabel();
  try {
    const comp = await getComp(artifactId);
    if (turn !== S.engTurn || argo !== S.argo) return;
    try { stage.setEngine(comp, creditInput, slot); }
    catch (e) { S.engineOn = null; appliedEngine = null; throw e; } // the stage is now the static Argonaut
    S.engineOn = artifactId;
    markOn($('engineStrip'), artifactId);                     // re-mark after a previous failure cleared it
    appliedEngine = { credit, creditInput, slot, artifactId };
    commitCreditUI(); revealStage();
    note('');
  } catch (e) {
    if (turn !== S.engTurn) return;
    if (S.engineOn !== null && appliedEngine) {
      Object.assign(S, appliedEngine);
      markOn($('engineStrip'), S.artifactId); markOn($('creditStrip'), S.credit); syncChips();
      engineLazy?.refresh([...document.querySelectorAll('#engineStrip .tile')], true);
    } else if (S.engineOn === null) markOn($('engineStrip'), null);   // nothing runs → no artifact shown as selected (Le)
    commitCreditUI();
    note(`Engine ${pad(artifactId, 2)} unavailable · ` + msg(e), true);
  } finally {
    if (turn === S.engTurn) { pendingEngine(false); S.loadingEngine = false; syncLoader(); syncEngineLabel(); }
  }
}

/** PNG filename from what PRODUCED the pixels (Codex review P2): the APPLIED engine, never the requested Credit /
 *  artifact of a switch still pending. No engine running → the static Argonaut → credit-x / engine-x. */
/** variant: '' (2D) · 'cubes' · 'check' → "-checks" · 'gold' · 'silver' (the view the pixels came from) */
function pngName(argo, applied, variant) {
  const suffix = !variant ? '' : '-' + variant.split('-').map(p => (p === 'check' ? 'checks' : p)).join('-');
  return `ac-argonaut-${argo.tokenId}-credit-${applied ? applied.credit : 'x'}-engine-${applied ? applied.artifactId : 'x'}${suffix}.png`;
}

// ── wiring ──
document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.classList.contains('on'))));
$('walletForm').addEventListener('submit', ev => { ev.preventDefault(); submitWallet($('walletInput').value); });
/** back to the landing, from the app or from the boot screen: invalidates every in-flight turn first */
function changeWallet(from) {
  S.walletTurn++; S.argoTurn++; S.engTurn++; S.gen++;
  S.booting = false;
  MP4.abort = true; if (MP4.state === 'done') { mp4State('idle'); MP4.file = null; }   // a running export stops (S.gen); a finished one is dropped
  stage.hold(false);                                          // 9b GO P3: never wait on the export's own finally to un-hold
  S.fx = null; setViewMode('2d'); applyFx();                  // neither the Cubes nor the style preference carries over to another wallet
  appliedEngine = null; ++pipRevision; S.argo = null; S.shown = null; S.engineOn = null; S.loadingArgo = S.loadingEngine = false; syncLoader(true);
  argoLazy?.disconnect(); engineLazy?.disconnect();
  changeScreen(from, $('landing'), $('walletInput'), () => stage.reset());
  status('Paste any wallet · read only'); $('walletGo').disabled = false;
}
$('walletPill').addEventListener('click', () => changeWallet($('app')));
$('bootCancel').addEventListener('click', () => changeWallet($('pageLoader')));   // GO P2: the boot screen always has a way out
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.dataset.p === b.dataset.p));
  if (b.dataset.p === 'argo') argoLazy?.refresh([...document.querySelectorAll('#argoStrip .tile')]);
  if (b.dataset.p === 'engine') engineLazy?.refresh([...document.querySelectorAll('#engineStrip .tile')]);
}));
$('pngBtn').addEventListener('click', () => {
  if (!S.argo || !stage.hasArgonaut()) return;
  const cubed = S.view === 'cubes', fx = !cubed && fxShows() && !!stage.fxName();   // = #fx on screen (GO fable P2); Cubes carries its style itself
  // 2016² = 14 × 144 (Le 2026-09-24); Cubes: render-then-read (D6/G10); Checks/Stars: the glyphs re-painted at 2016 (84 px per cell)
  const href = cubed ? cubes.png($('stage'), 2016) : fx ? stage.fxSnapshot(2016) : stage.snapshot(14);
  if (!href) { note((cubed ? 'Cubes' : 'Checks') + ' PNG unavailable right now · try again', true); return; }
  const variant = cubed ? ['cubes', cubes.drawnFx()].filter(Boolean).join('-') : viewVariant();   // Cubes: the style actually drawn (GO opus P3-1)
  const a = el('a', { href, download: pngName(S.argo, appliedEngine, variant) });
  document.body.append(a); a.click(); a.remove();
});
$('mp4Btn')?.addEventListener('click', () => {
  if (MP4.saving || performance.now() - MP4.at < 400) return;   // 9b GO P3: the 2nd tap of a double tap would cancel / save at once
  if (MP4.state === 'busy') { MP4.abort = true; return; }
  if (mp4Ready()) { saveMp4(); return; }
  // pick a size first (Le 2026-09-24); the choice's own tap then starts the export (and opens "Save as" on desktop).
  // Also from 'done' on OTHER content: the new clip replaces the kept one.
  checkMp4Sizes(); syncMp4Sizes(); openSheet('mp4Dlg');
});
document.querySelectorAll('.seg.views [data-view]').forEach(b => b.addEventListener('click', () => setViewMode(b.dataset.view)));
document.querySelectorAll('#fxStyles [data-fx]').forEach(b => b.addEventListener('click', () => setFxStyle(b.dataset.fx)));$('pip').addEventListener('click', () => document.querySelector('.tabs button[data-p="credit"]').click());
// sheets (chunk 8): native modal <dialog> — Esc and focus trapping come with showModal(); the close button and a click on
// the backdrop close it. H3: the dialog has no padding (the content sits in .sheet-in), and a click only counts as
// "backdrop" when BOTH its pointerdown and the click landed on the <dialog> itself (a drag-select from inside doesn't).
for (const id of SHEETS) {
  const d = $(id); if (!d) continue;                          // H10
  let downOnBackdrop = false;
  d.addEventListener('pointerdown', e => { downOnBackdrop = e.target === d; });
  d.addEventListener('click', e => { if (e.target === d && downOnBackdrop) d.close(); downOnBackdrop = false; });
  d.querySelector('[data-close]')?.addEventListener('click', () => d.close());
  d.addEventListener('close', () => syncEngineLabel());       // re-evaluate the Traits button once its sheet is gone (H8)
}
const openSheet = id => { const d = $(id); if (d && !d.open) d.showModal(); };
document.querySelectorAll('#mp4Dlg [data-size]').forEach(b => b.addEventListener('click', () => {
  $('mp4Dlg').close();
  if (MP4.state !== 'busy') startMp4(+b.dataset.size);         // synchronous: "Save as" (desktop) still has THIS tap
}));
checkMp4Sizes();                                              // ask the device once, early — the menu is ready when opened
$('traitsBtn')?.addEventListener('click', () => { if (S.shown) openSheet('traitsDlg'); });
// "What's this?" (Le 2026-09-24): two pages behind tabs (ARIA tabs: click, ←/→ between them). Always opens on Details.
const HOW_PAGES = [['howTabDetails', 'howDetails'], ['howTabModulo', 'howModulo']];
function howPage(i, focus = false) {
  HOW_PAGES.forEach(([tab, panel], k) => {
    const t = $(tab), on = k === i; if (!t) return;          // H10: an old cached index.html has no tabs
    t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1;
    $(panel).hidden = !on;
    if (on && focus) t.focus();
  });
  const d = $('howDlg'); if (d) d.scrollTop = 0;               // the sheet scrolls: a new page starts at its top
}
HOW_PAGES.forEach(([tab], k) => {
  $(tab)?.addEventListener('click', () => howPage(k));
  $(tab)?.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const n = HOW_PAGES.length;                               // GO sonnet P3: ← goes back, → forward (right for any page count)
    e.preventDefault(); howPage((k + (e.key === 'ArrowRight' ? 1 : n - 1)) % n, true);
  });
});
document.querySelectorAll('[data-how]').forEach(b => b.addEventListener('click', () => { howPage(0); openSheet('howDlg'); }));
