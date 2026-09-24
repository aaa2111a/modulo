// Argonauts rendering for Project AC — layer-by-layer from the renderer's own on-chain data, with a
// per-token ORACLE against the renderer's `renderSeeded` (synthesis S5 + E4 + D6/A8/A9; chunk-2 GO).
//
// Source of truth: ArgonautsRendererV5 (verified-sources/argonauts/renderer/src/RendererV5.sol).
// One DRAW LIST (which blob, in which slot, with which tone) feeds BOTH the SVG emitter (checked by the
// oracle) and the pixel decoder the engine uses — so G1 also covers what the engine is fed.
// The per-id variance marks come from the oracle: the ONLY allowed difference between our string and
// `renderSeeded` is ONE insertion right after the BODY rects, made of 0 or 3 1×1 rects with the exact
// literals of RendererV5.sol:297-298 (unmistakable: `_opacity` always prints 3 digits, the marks 2).
import { ADDR, selectorOf, word, strip, decString, decBytes, decAddress, decSmallUint, decUint8x7 } from './abi.js';

export class ArgonautError extends Error {
  constructor(code, message, cause) { super(message); this.name = 'ArgonautError'; this.code = code; if (cause) this.cause = cause; }
}
const fail = (code, what) => e => { throw e instanceof ArgonautError ? e : new ArgonautError(code, `${what}: ${e && e.message || e}`, e); };
const dec = (what, fn) => { try { return fn(); } catch (e) { return fail('malformed', what)(e); } };

export const PINNED_RENDERER = ADDR.ARGO_RENDERER;   // V5, locked()==true
export const LAYER = Object.freeze({ BACKGROUND: 0, BODY: 1, HOODIE: 2, NECK: 3, EYES: 4, MOUTH: 5, HEAD: 6 });
export const LAYER_LABEL = ['Palette', 'Bones', 'Cloak', 'Relic', 'Sight', 'Artifact', 'Crown'];
export const SMOKE_SLOT = 'smoke';
const SVG_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">';
const S = sig => selectorOf(sig);
const SEL = {
  renderer: S('renderer()'), blobs: S('blobs(uint256)'), blobCount: S('blobCount()'), layout: S('layout()'),
  locked: S('locked()'), vapeMouthIndex: S('vapeMouthIndex()'), vapeSmokeBlob: S('vapeSmokeBlob()'),
  vapeBlueberryBlob: S('vapeBlueberryBlob()'), vapeDragonsBlob: S('vapeDragonsBlob()'),
  bandHeadIndex: S('bandHeadIndex()'), crownHeadIndex: S('crownHeadIndex()'), crownClipBlob: S('crownClipBlob(uint8)'),
  smokerMouth: S('smokerMouth(uint8)'), smokeTone: S('smokeTone(uint8)'), isDragonsBreath: S('isDragonsBreath(uint256)'),
  renderSeeded: S('renderSeeded(uint8[7],uint256)'), traitsOf: S('traitsOf(uint256)'),
};
const call = (to, data, block) => ({ method: 'eth_call', params: [{ to, data }, block] });
const u8 = h => decSmallUint(h, 255);
const bool = h => decSmallUint(h, 1) === 1;

/** Layout helper: blob id per trait index, per layer (RendererV5._blobId). */
export function parseLayout(bytes) {
  const layers = [];
  let pos = 0;
  for (let layer = 0; layer < 7; layer++) {
    if (pos >= bytes.length) throw new ArgonautError('config', 'layout truncated');
    const count = bytes[pos];
    if (pos + 1 + count > bytes.length) throw new ArgonautError('config', 'layout truncated');
    layers.push(Array.from(bytes.slice(pos + 1, pos + 1 + count)));
    pos += 1 + count;
  }
  return layers;
}

/**
 * Everything the compositor needs, once per session (~140 eth_calls, batched).
 * ArgonautError('renderer-changed') if Argonauts.renderer() is not the pinned, locked V5 — the UI then shows
 * only the chain's own image (no layer engine).
 */
export async function loadRendererConfig(rpc, { block = 'latest' } = {}) {
  const r = await rpc.batchAll([call(ADDR.ARGONAUTS, SEL.renderer, block), call(PINNED_RENDERER, SEL.locked, block), call(PINNED_RENDERER, SEL.blobCount, block)])
    .catch(fail('rpc', 'could not read the renderer'));
  const renderer = dec('renderer()', () => decAddress(r[0]));
  if (renderer !== PINNED_RENDERER) throw new ArgonautError('renderer-changed', `Argonauts.renderer() is ${renderer}, expected the pinned V5`);
  if (!dec('locked()', () => bool(r[1]))) throw new ArgonautError('renderer-changed', 'renderer is not locked');
  const blobCount = dec('blobCount()', () => decSmallUint(r[2], 255));

  const calls = [
    call(PINNED_RENDERER, SEL.layout, block), call(PINNED_RENDERER, SEL.vapeMouthIndex, block),
    call(PINNED_RENDERER, SEL.vapeSmokeBlob, block), call(PINNED_RENDERER, SEL.vapeBlueberryBlob, block),
    call(PINNED_RENDERER, SEL.vapeDragonsBlob, block), call(PINNED_RENDERER, SEL.bandHeadIndex, block),
    call(PINNED_RENDERER, SEL.crownHeadIndex, block),
  ];
  const BODIES = 10, MOUTHS = 3, BGS = 34;   // TraitDefs table sizes
  for (let b = 0; b < BODIES; b++) calls.push(call(PINNED_RENDERER, SEL.crownClipBlob + word(b), block));
  for (let m = 0; m < MOUTHS; m++) calls.push(call(PINNED_RENDERER, SEL.smokerMouth + word(m), block));
  for (let g = 0; g < BGS; g++) calls.push(call(PINNED_RENDERER, SEL.smokeTone + word(g), block));
  for (let i = 0; i < blobCount; i++) calls.push(call(PINNED_RENDERER, SEL.blobs + word(i), block));
  const v = await rpc.batchAll(calls).catch(fail('rpc', 'could not read renderer config'));
  return dec('renderer config', () => {
    let k = 0;
    const cfg = {
      renderer, blobCount, layout: parseLayout(decBytes(v[k++], 4096)),
      vapeMouth: u8(v[k++]), vapeSmoke: u8(v[k++]), vapeBlue: u8(v[k++]), vapeDragons: u8(v[k++]),
      bandHead: u8(v[k++]), crownHead: u8(v[k++]),
      crownClip: [], smoker: [], tone: [], blobPtr: [],
    };
    for (let b = 0; b < BODIES; b++) cfg.crownClip.push(u8(v[k++]));
    for (let m = 0; m < MOUTHS; m++) cfg.smoker.push(bool(v[k++]));
    for (let g = 0; g < BGS; g++) { const t = BigInt('0x' + strip(v[k++])); cfg.tone.push((t >> 24n) & 1n ? Number(t & 0xffffffn) | 0x1000000 : 0); }
    for (let i = 0; i < blobCount; i++) cfg.blobPtr.push(decAddress(v[k++]));
    return cfg;
  });
}

/** Blob cache keyed by chain + SSTORE2 pointer (immutable code ⇒ safe to cache for the session). */
export function createBlobStore(rpc, { storage = null, chainId = 1 } = {}) {
  const mem = new Map();
  const key = p => `ac:${chainId}:blob:${p}`;
  async function get(ptrs) {
    const need = [...new Set(ptrs)].filter(p => !mem.has(p));
    for (const p of need) {
      const cached = storage && (() => { try { return storage.getItem(key(p)); } catch { return null; } })();
      if (cached && /^([0-9a-f]{2})+$/.test(cached)) mem.set(p, Uint8Array.from(cached.match(/../g), x => parseInt(x, 16)));
    }
    const miss = need.filter(p => !mem.has(p));
    if (miss.length) {
      const codes = await rpc.batchAll(miss.map(p => ({ method: 'eth_getCode', params: [p, 'latest'] }))).catch(fail('rpc', 'could not read layer sprites'));
      miss.forEach((p, i) => {
        const h = dec('sprite code', () => strip(codes[i]));
        if (h.length < 4 || h.slice(0, 2) !== '00') throw new ArgonautError('blob', `sprite ${p} is not an SSTORE2 blob`);
        const hex = h.slice(2);
        mem.set(p, Uint8Array.from(hex.match(/../g), x => parseInt(x, 16)));
        if (storage) try { storage.setItem(key(p), hex); } catch { /* quota — memory cache still works */ }
      });
    }
    return ptrs.map(p => mem.get(p));
  }
  return { get };
}

// ── RendererV5 mirrors ──
function blobId(cfg, layer, idx) {
  const row = cfg.layout[layer];
  if (idx >= row.length) throw new ArgonautError('traits', `trait index ${idx} out of range for layer ${layer}`);
  return row[idx];
}
/** RendererV5._layerBlob with seeded=true */
export function layerBlob(cfg, t, layer, dragons) {
  if (layer === LAYER.MOUTH && t[LAYER.MOUTH] === cfg.vapeMouth) return dragons ? cfg.vapeDragons : cfg.vapeBlue;
  const id = blobId(cfg, layer, t[layer]);
  if (layer === LAYER.BODY && t[LAYER.HEAD] === cfg.crownHead) { const clip = cfg.crownClip[t[layer]]; if (clip !== 0) return clip; }
  return id;
}
export function paintOrder(cfg, t) {
  return t[LAYER.HEAD] === cfg.bandHead ? [0, 1, 2, 3, 5, 6, 4] : [0, 1, 4, 2, 3, 5, 6];
}

/**
 * THE draw list (RendererV5._render seeded): [{slot, blobId, tone}] in paint order. `slot` is a LAYER index or
 * SMOKE_SLOT for the vape vapor. Both the SVG emitter and the pixel decoder consume exactly this.
 */
export function drawList(cfg, t, dragons) {
  const band = t[LAYER.HEAD] === cfg.bandHead;
  const vaped = t[LAYER.MOUTH] === cfg.vapeMouth;
  const tone = cfg.smoker[t[LAYER.MOUTH]] ? cfg.tone[t[LAYER.BACKGROUND]] : 0;
  const smokeAt = band ? LAYER.MOUTH : LAYER.EYES;
  const out = [];
  for (const layer of paintOrder(cfg, t)) {
    if (vaped && layer === smokeAt) out.push({ slot: SMOKE_SLOT, blobId: cfg.vapeSmoke, tone });
    const id = layerBlob(cfg, t, layer, dragons);
    if (id === 0xff) continue;
    out.push({ slot: layer, blobId: id, tone: layer === LAYER.MOUTH ? tone : 0 });
  }
  return out;
}
export const neededBlobIds = (cfg, t, dragons) => [...new Set(drawList(cfg, t, dragons).map(d => d.blobId))];

/** Painted runs of a blob, tone applied (RendererV5._rects / _lay semantics). */
export function* runs(blob, tone) {
  const p = (blob[0] << 8) | blob[1]; let off = 2 + p * 4, pixel = 0;
  while (off < blob.length) {
    const ci = (blob[off] << 8) | blob[off + 1], run = blob[off + 2];
    if (ci !== 0) {
      const e = 2 + (ci - 1) * 4; let r = blob[e], g = blob[e + 1], b = blob[e + 2]; const a = blob[e + 3];
      if (tone !== 0 && a !== 0 && a !== 255) { r = (tone >> 16) & 255; g = (tone >> 8) & 255; b = tone & 255; }
      yield { pixel, run, r, g, b, a };
    }
    pixel += run; off += 3;
  }
}
const hex2 = n => n.toString(16).padStart(2, '0');
function opacity(a) { if (a === 255) return '"/>'; let d = String(Math.floor(a * 1000 / 255)); while (d.length < 3) d = '0' + d; return '" fill-opacity="0.' + d + '"/>'; }
/** RendererV5._rects */
export function rects(blob, tone) {
  let out = '';
  for (const { pixel, run, r, g, b, a } of runs(blob, tone))
    out += `<rect x="${pixel % 24}" y="${Math.floor(pixel / 24)}" width="${run}" height="1" fill="#${hex2(r)}${hex2(g)}${hex2(b)}` + opacity(a);
  return out;
}
/** 24×24 straight-alpha RGBA of ONE drawn blob (for the engine's layer masks). Runs never cross rows (asserted in G1). */
export function layerPixels(blob, tone) {
  const px = new Uint8ClampedArray(24 * 24 * 4);
  for (const { pixel, run, r, g, b, a } of runs(blob, tone))
    for (let k = 0; k < run; k++) { const i = (pixel + k) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; }
  return px;
}
/** true if any PAINTED pixel is partly transparent (A8: such layers are not hard masks). */
export function blobHasSemi(blob) {
  for (const { a } of runs(blob, 0)) if (a !== 0 && a !== 255) return true;
  return false;
}

/** RendererV5._render(t, id, seeded=true) WITHOUT the variance marks, from the draw list. */
export function composeSeededNoMarks(cfg, t, dragons, blobOf) {
  let body = '', bodyEnd = null;
  for (const d of drawList(cfg, t, dragons)) {
    body += rects(blobOf(d.blobId), d.tone);
    if (d.slot === LAYER.BODY) bodyEnd = SVG_HEAD.length + body.length;
  }
  return { svg: SVG_HEAD + body + '</svg>', bodyEnd };
}

const MARK_RE = /^<rect x="(\d{1,2})" y="(\d{1,2})" width="1" height="1" fill="#000000" fill-opacity="0\.14"\/><rect x="(\d{1,2})" y="(\d{1,2})" width="1" height="1" fill="#000000" fill-opacity="0\.14"\/><rect x="(\d{1,2})" y="(\d{1,2})" width="1" height="1" fill="#ffffff" fill-opacity="0\.11"\/>$/;

/** E4 oracle. @returns {{ok:true, marks:[number,number][]}|{ok:false, reason:string}} */
export function matchOracle(mine, chain) {
  const { svg, bodyEnd } = mine;
  if (bodyEnd === null) return chain === svg ? { ok: true, marks: [] } : { ok: false, reason: 'no body layer but strings differ' };
  if (chain.length < svg.length) return { ok: false, reason: 'chain string shorter than ours' };
  const head = svg.slice(0, bodyEnd), tail = svg.slice(bodyEnd);
  if (!chain.startsWith(head)) return { ok: false, reason: 'prefix (layers up to BODY) differs' };
  if (!chain.endsWith(tail)) return { ok: false, reason: 'suffix (layers after BODY) differs' };
  const inserted = chain.slice(bodyEnd, chain.length - tail.length);
  if (inserted === '') return { ok: true, marks: [] };
  const m = MARK_RE.exec(inserted);
  if (!m) return { ok: false, reason: 'insertion after BODY is not the 3 variance marks' };
  const marks = [[+m[1], +m[2]], [+m[3], +m[4]], [+m[5], +m[6]]];
  if (marks.some(([x, y]) => x > 23 || y > 23)) return { ok: false, reason: 'mark outside 24×24' };
  return { ok: true, marks };
}

/**
 * Per-token check. Traits are read FROM THE CHAIN in the same batch as renderer() + isDragonsBreath +
 * renderSeeded (chunk-2 GO: never trust caller-supplied/cached traits; re-check the pin every time).
 * `svg` is the CHAIN's string — UI must show it ONLY via <img src="data:image/svg+xml…">, never innerHTML.
 * @returns {{tokenId, traits, dragons, svg, marks, drawList, verified:boolean, reason?:string}}
 */
export async function renderVerified(rpc, cfg, blobs, tokenId, { block = 'latest' } = {}) {
  const pre = await rpc.batchAll([
    call(ADDR.ARGONAUTS, SEL.renderer, block),
    call(ADDR.ARGONAUTS, SEL.traitsOf + word(tokenId), block),
    call(PINNED_RENDERER, SEL.isDragonsBreath + word(tokenId), block),
  ]).catch(fail('rpc', 'could not read the token'));
  const renderer = dec('renderer()', () => decAddress(pre[0]));
  if (renderer !== PINNED_RENDERER) throw new ArgonautError('renderer-changed', `Argonauts.renderer() is ${renderer}, expected the pinned V5`);
  const traits = dec('traitsOf()', () => decUint8x7(pre[1]));
  const dragons = dec('isDragonsBreath()', () => bool(pre[2]));
  const [raw] = await rpc.batchAll([call(PINNED_RENDERER, SEL.renderSeeded + traits.map(word).join('') + word(tokenId), block)])
    .catch(fail('rpc', 'could not read the on-chain render'));
  const chainSvg = dec('renderSeeded()', () => decString(raw, 200_000));
  const ids = neededBlobIds(cfg, traits, dragons);
  const got = await blobs.get(ids.map(i => cfg.blobPtr[i]));
  const byId = new Map(ids.map((id, i) => [id, got[i]]));
  const mine = composeSeededNoMarks(cfg, traits, dragons, id => byId.get(id));
  const o = matchOracle(mine, chainSvg);
  const list = drawList(cfg, traits, dragons);
  return o.ok
    ? { tokenId, traits, dragons, svg: chainSvg, marks: o.marks, drawList: list, verified: true }
    : { tokenId, traits, dragons, svg: chainSvg, marks: [], drawList: list, verified: false, reason: o.reason };
}
