// Project AC — UI controller (mobile-first, one screen). Paste a wallet (0x or name.eth) → read ONLY that wallet's
// Argonauts + Credits → pick one of each + a Modulo Artifact as the engine → the chosen Argonaut layer animates
// with the artifact's motion in the Credit's colours/pattern.
// Rules honoured here: a failed read is an ERROR (never "you own nothing"); burned Argonauts are not available;
// every async step carries a turn/generation token so a stale answer never paints over a newer choice; what the UI
// shows as selected is what the stage shows (a failed switch reverts the highlight); chain SVGs only as
// <img src="data:…">; DOM only through el()/textContent; engines only via makeAcEngine (A4).
import { createRpc } from './rpc.js';
import { RPC_URL, MAX_BATCH } from './config.js';
import { normalizeAddress, toChecksumAddress, ADDR } from './abi.js';
import { looksLikeEns, resolveEns, EnsError } from './ens.js';
import { readArgonauts, readCredits, readCreditData, readArgonautTraits } from './holdings.js';
import { loadRendererConfig, createBlobStore, renderVerified, drawList, LAYER, LAYER_LABEL, ArgonautError } from './argonaut.js';
import { prepareLayers, composeFrame, downsample, offeredLayers, OUT } from './compose.js';
import { creditEngineInput, creditSvg } from './credit.js';
import { readTotalArtifacts, readArtifactComposition } from './artifacts.js';
import { makeAcEngine } from './engine-ac.js';
import { createStage } from './stage.js';
import { createCubes } from './cubes.js';
import { el, $, svgDataUrl, shortAddr } from './dom.js';
import './metal.js';                                          // tilt + light of the metal buttons (wallet arrow, 2D)
import './dock-space.js';
import { createLoadingUI } from './loading-ui.js';

const rpc = createRpc(RPC_URL, { maxBatch: MAX_BATCH, timeoutMs: 30000 });
let storage = null;
try { storage = window.sessionStorage; } catch { /* blocked storage: memory cache only */ }
const blobs = createBlobStore(rpc, { storage });
const stage = createStage($('stage'), {
  onError: e => { S.engineOn = null; appliedEngine = null; markOn($('engineStrip'), null); syncEngineLabel(); note('Engine stopped · ' + msg(e), true); },
  onViewError: e => cubesFailed('error', e),                  // a throw that escaped the Cubes view (the stage already fell back to 2D)
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
};
const msg = e => (e && e.message) || String(e);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const loadingUI = createLoadingUI($('stageLoader'), $('loaderText'), { reduced: reducedMotion });
reducedMotion.addEventListener('change', () => syncLoader(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) syncLoader(true); });
let appliedEngine = null, pipRevision = 0, stageReveal = 0;
let screenTimer = 0, finishScreen = null;
function changeScreen(from, to, focus, onHidden = () => {}) {
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
  queueMicrotask(() => stage.setView(null));                  // never re-enter the stage from inside its sink (view contract)
}
function setViewMode(mode) {
  if (mode === S.view) return;
  if (mode === 'cubes') {
    if (!S.argo) { syncViewUI(); return; }
    if (!cubes.available()) { syncViewUI(); cubesNote = cubes.lost ? FAIL_TEXT.lost : FAIL_TEXT.webgl; note(cubesNote, true); return; }   // 7c GO fable P2: a refused entry says why
    if (!cubes.enter()) return;                               // enter() failing already went through fail() → cubesFailed (note + UI)
    if (cubesNote && $('stageNote').textContent === cubesNote) note('');   // a previous Cubes failure note goes away on a good re-entry
    cubesNote = '';
    S.view = 'cubes'; stage.setView(cubes);
  } else {
    S.view = '2d'; cubes.leave(); stage.setView(null);
  }
  syncViewUI();
}
function syncViewUI() {
  // D4 + 7c GO sonnet P3: no verified Argonaut (chain image only / none) → the control shows 2D and is disabled; the
  // 'cubes' preference itself is kept and resumes with the next verified Argonaut (G6)
  const on = S.view === 'cubes' && !!S.argo, can = !!S.argo && (on || cubes.available());
  const b = $('viewBtn'), alt = $('viewAlt');
  b.textContent = on ? 'Cubes' : '2D';
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? 'View: cubes. Switch to 2D' : 'View: 2D. Switch to cubes');
  b.disabled = !can;
  alt.replaceChildren(el('b', { text: on ? '2D' : 'Cubes' }));
  alt.disabled = !can;
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
function syncEngineLabel() {
  $('engineLabel').textContent = S.engineOn !== null ? 'Engine ' + pad(S.engineOn, 2) : S.shown && !S.argo ? 'on-chain image only' : '';
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
  $('argoTitle').textContent = ''; $('tags').replaceChildren(); $('layerChips').replaceChildren(); $('layerCount').textContent = '';
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
    const traits = await readArgonautTraits(rpc, batch.map(t => Number(t.dataset.id)));
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
function renderTags(argo) {                                   // only the layers the renderer actually draws
  const drawn = argo ? [...new Set(argo.drawList.map(d => d.slot))].filter(s => typeof s === 'number').sort((a, b) => a - b) : [];
  const tags = drawn.map(layer => el('span', { class: 'tag', text: `${LAYER_LABEL[layer]} ${argo.traits[layer]}` }));
  if (S.creditInput) tags.push(el('span', { class: 'tag credit', text: `Credit #${S.credit} · ${S.creditInput.pal.length} inks` }));
  $('tags').replaceChildren(...tags);
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
  S.loadingEngine = 'Starting engine ' + pad(artifactId, 2); syncLoader();
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
function pngName(argo, applied, cubed) {
  return `ac-argonaut-${argo.tokenId}-credit-${applied ? applied.credit : 'x'}-engine-${applied ? applied.artifactId : 'x'}${cubed ? '-cubes' : ''}.png`;
}

// ── wiring ──
document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.classList.contains('on'))));
$('walletForm').addEventListener('submit', ev => { ev.preventDefault(); submitWallet($('walletInput').value); });
/** back to the landing, from the app or from the boot screen: invalidates every in-flight turn first */
function changeWallet(from) {
  S.walletTurn++; S.argoTurn++; S.engTurn++; S.gen++;
  S.booting = false;
  setViewMode('2d');                                          // the Cubes preference does not carry over to another wallet
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
  const cubed = S.view === 'cubes';
  const href = cubed ? cubes.png($('stage')) : stage.snapshot();   // Cubes: 1152² (8 × 144), render-then-read (D6/G10)
  if (!href) { note('Cubes PNG unavailable right now · try again', true); return; }
  const a = el('a', { href, download: pngName(S.argo, appliedEngine, cubed) });
  document.body.append(a); a.click(); a.remove();
});
$('viewBtn').addEventListener('click', () => setViewMode(S.view === 'cubes' ? '2d' : 'cubes'));
$('viewAlt').addEventListener('click', () => setViewMode(S.view === 'cubes' ? '2d' : 'cubes'));
$('pip').addEventListener('click', () => document.querySelector('.tabs button[data-p="credit"]').click());
