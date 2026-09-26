// Modulo Artifacts (SettleArtifact v7) — the "engines". Reads a composition from `getArtifact(id)` (~2 KB)
// instead of the 88 KB `animationURI`, rebuilding exactly what HTMLBuilder._slotToJson writes into the
// COMPOSITION literal (mainnet/src/libs/HTMLBuilder.sol:762-816), then Punks' own _normalizeComposition.
// G5 (tests/test-artifacts.mjs): adapter(getArtifact) deep-equals extractComposition(animationURI), every id.
import { ADDR, selectorOf, word, strip, decSmallUint } from './abi.js?v=0e6f5624d9';
import { normalizeComposition } from './engine-ac.js?v=8410dea0c1';

export class ArtifactError extends Error {
  constructor(code, message, cause) { super(message); this.name = 'ArtifactError'; this.code = code; if (cause) this.cause = cause; }
}
const SEL = { getArtifact: selectorOf('getArtifact(uint256)'), totalArtifacts: selectorOf('totalArtifacts()') };
const UNSET = 0xff;
const MAX_COMPOSITION = 8;

export async function readTotalArtifacts(rpc, block = 'latest') {
  try { return decSmallUint(await rpc.ethCall(ADDR.SETTLE_ARTIFACT, SEL.totalArtifacts, block), 1_000_000); }
  catch (e) { throw new ArtifactError('rpc', 'could not read totalArtifacts: ' + (e && e.message || e), e); }
}

/** ABI-decode SettleArtifact.ArtifactData (a dynamic tuple). Strict: every offset/length is bounds-checked. */
export function decodeArtifactData(hex) {
  const h = strip(hex);
  const W = i => { const s = h.slice(64 * i, 64 * i + 64); if (s.length !== 64) throw new ArtifactError('malformed', 'returndata truncated'); return BigInt('0x' + s); };
  const small = (v, max) => { if (v > BigInt(max)) throw new ArtifactError('malformed', 'value out of range'); return Number(v); };
  if (h.length % 64) throw new ArtifactError('malformed', 'returndata not word-aligned');
  const off = v => { if (v % 32n) throw new ArtifactError('malformed', 'misaligned offset'); return small(v, 1 << 20) / 32; };
  const base = off(W(0));
  if (base !== 1) throw new ArtifactError('malformed', 'unexpected tuple offset');
  const at = k => base + k;                                          // tuple head words
  const dyn = k => base + off(W(at(k)));                             // word index of a dynamic member (word-aligned)
  const moduloId = small(W(at(0)), 2 ** 32);
  const tStart = dyn(1), n = small(W(tStart), MAX_COMPOSITION);
  if (n < 1) throw new ArtifactError('malformed', 'empty composition');
  const traits = [];
  for (let i = 0; i < n; i++) {
    const o = tStart + 1 + 11 * i;
    const f = j => W(o + j);
    traits.push({
      tokenNum: small(f(0), 2 ** 32), owner: '0x' + f(1).toString(16).padStart(40, '0'),
      colorSel: small(f(2), 255), mode: small(f(3), 255), sz: small(f(4), 255), rs: small(f(5), 255),
      rv: small(f(6), 255), rd: small(f(7), 255), dx: small(f(8), 255), speedOps: small(f(9), 255), bios: small(f(10), 255),
    });
  }
  const sStart = dyn(2), ns = small(W(sStart), MAX_COMPOSITION);
  const seeds = Array.from({ length: ns }, (_, i) => W(sStart + 1 + i));
  const rStart = dyn(3), nr = small(W(rStart), MAX_COMPOSITION);
  const ranks = Array.from({ length: nr }, (_, i) => small(W(rStart + 1 + i), 65535));
  if (ns !== n || nr !== n) throw new ArtifactError('malformed', 'traits/seeds/ranks length mismatch');
  return { moduloId, traits, seeds, ranks };
}

/** HTMLBuilder._slotToJson → the raw composition object (before Punks' normalization) */
export function compositionFromArtifactData(artifactId, data) {
  const tokens = data.traits.map((s, i) => {
    const hasMode = s.mode !== UNSET, hasSize = s.sz !== UNSET, hasRS = s.rs !== UNSET, hasRD = s.rd !== UNSET, hasDX = s.dx !== UNSET;
    return {
      tokenId: s.tokenNum, rank: data.ranks[i], seed: '0x' + data.seeds[i].toString(16).padStart(64, '0'),
      hasMode, hasSize, hasRS, hasRD, hasBios: s.bios !== 0, hasDX,
      modes: hasMode ? [s.mode] : [], dx: hasDX ? [s.dx] : [], rv: s.rv !== UNSET ? [s.rv] : [],
      size: hasSize ? s.sz : 0, rectSize: hasRS ? s.rs : 0, rectDim: hasRD ? s.rd : 0,
      biosOn: s.bios === 2, colorIndex: s.colorSel, speed: s.speedOps,
    };
  });
  return { artifactId, moduloId: data.moduloId, tokens };
}

const NONEXISTENT_ARTIFACT = selectorOf('NonexistentArtifact()');   // SettleArtifact.getArtifact revert

/** getArtifact(id) → normalized composition (what the engine consumes).
 *  Errors: 'nonexistent' (the contract reverted NonexistentArtifact), 'rpc' (transport / any other RPC error),
 *  'malformed' (returndata or composition did not decode). */
export async function readArtifactComposition(rpc, artifactId, block = 'latest') {
  let raw;
  try { raw = await rpc.ethCall(ADDR.SETTLE_ARTIFACT, SEL.getArtifact + word(artifactId), block); }
  catch (e) {
    const data = e && typeof e.data === 'string' ? e.data.toLowerCase() : '';
    const code = data.startsWith(NONEXISTENT_ARTIFACT) ? 'nonexistent' : 'rpc';
    throw new ArtifactError(code, `artifact ${artifactId}: ${e && e.message || e}`, e);
  }
  try { return normalizeComposition(compositionFromArtifactData(artifactId, decodeArtifactData(raw))); }
  catch (e) { throw e instanceof ArtifactError ? e : new ArtifactError('malformed', `artifact ${artifactId}: ${e && e.message || e}`, e); }
}
