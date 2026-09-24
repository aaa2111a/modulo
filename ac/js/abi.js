// Minimal, STRICT ABI codec for Project AC's read calls. Every decoder validates the exact returndata
// length/shape and THROWS on anything malformed — an empty `0x` (RPC hiccup, revert passthrough) must
// surface as an error, never as "0" / "[]" / the zero address (synthesis E2: empty ≠ error).
import { keccak256, utf8 } from './keccak.js';

export class AbiError extends Error { constructor(msg) { super(msg); this.name = 'AbiError'; } }

// ── contracts (Ethereum mainnet) ──
export const ADDR = Object.freeze({
  ARGONAUTS: '0x387c41b0b2f1128de44db1bcf8baad085f26392c',
  ARGO_RENDERER: '0xae592592ab03768bd7cd1a6ec6db9ac3e822f02a',
  CREDITS: '0x97630aa70ab14ed9883b41dafccbc11349723043',
  SETTLE_ARTIFACT: '0xbfb21e5b736e85160a2fa2056764a7d5f4ab2cd9',
  DEAD: '0x000000000000000000000000000000000000dead',
});

// ── selectors (4-byte), each re-derived from its signature by tests/test-abi-keccak.mjs ──
export const SEL = Object.freeze({
  balanceOf: '0x70a08231',      // balanceOf(address)
  ownerOf: '0x6352211e',        // ownerOf(uint256)
  tokensOf: '0x5a3f2672',       // tokensOf(address)            — Credits
  seedOf: '0x82829f74',         // seedOf(uint256)              — Credits (bytes21)
  timestampOf: '0x2d9c77e1',    // timestampOf(uint256)         — Credits (uint64)
  traitsOf: '0x5efab6e4',       // traitsOf(uint256)            — Argonauts (uint8[7])
  renderer: '0x8ada6b0f',       // renderer()                   — Argonauts
  totalArtifacts: '0xb4287d8a', // totalArtifacts()             — SettleArtifact
});
export const SIGNATURES = Object.freeze({
  balanceOf: 'balanceOf(address)', ownerOf: 'ownerOf(uint256)', tokensOf: 'tokensOf(address)',
  seedOf: 'seedOf(uint256)', timestampOf: 'timestampOf(uint256)', traitsOf: 'traitsOf(uint256)',
  renderer: 'renderer()', totalArtifacts: 'totalArtifacts()',
});

// ── hex helpers ──
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;
export function strip(hex) {
  if (typeof hex !== 'string' || !HEX_RE.test(hex)) throw new AbiError('not an even-length 0x hex string');
  return hex.slice(2).toLowerCase();
}
export const word = n => {
  const b = BigInt(n);
  if (b < 0n || b >= 1n << 256n) throw new AbiError('uint out of range');
  return b.toString(16).padStart(64, '0');
};
export const addrWord = a => normalizeAddress(a).slice(2).padStart(64, '0');

// ── addresses ──
/** Accepts all-lower, all-upper, or a VALID EIP-55 mixed-case address. Returns lowercase 0x…; throws otherwise. */
export function normalizeAddress(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.trim())) throw new AbiError('not a 20-byte hex address');
  const s = a.trim(), body = s.slice(2);
  const lower = '0x' + body.toLowerCase();
  if (body === body.toLowerCase() || body === body.toUpperCase()) return lower;
  if (toChecksumAddress(lower) !== s) throw new AbiError('bad EIP-55 checksum');
  return lower;
}
export function toChecksumAddress(a) {
  const body = a.slice(2).toLowerCase();
  const h = keccak256(utf8(body));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nib = (h[i >> 1] >> (i % 2 ? 0 : 4)) & 0xf;
    out += nib >= 8 ? body[i].toUpperCase() : body[i];
  }
  return out;
}
export const selectorOf = sig => '0x' + Array.from(keccak256(utf8(sig)).slice(0, 4), b => b.toString(16).padStart(2, '0')).join('');

// ── call-data builders ──
export const enc = {
  balanceOf: a => SEL.balanceOf + addrWord(a),
  ownerOf: id => SEL.ownerOf + word(id),
  tokensOf: a => SEL.tokensOf + addrWord(a),
  seedOf: id => SEL.seedOf + word(id),
  timestampOf: id => SEL.timestampOf + word(id),
  traitsOf: id => SEL.traitsOf + word(id),
  renderer: () => SEL.renderer,
  totalArtifacts: () => SEL.totalArtifacts,
};

// ── strict decoders ──
function words(hex, n) {
  const h = strip(hex);
  if (h.length !== 64 * n) throw new AbiError(`expected exactly ${n} word(s), got ${h.length / 2} bytes`);
  return Array.from({ length: n }, (_, i) => h.slice(64 * i, 64 * i + 64));
}
export function decUint(hex) { return BigInt('0x' + words(hex, 1)[0]); }
export function decSmallUint(hex, max = Number.MAX_SAFE_INTEGER) {
  const v = decUint(hex);
  if (v > BigInt(max)) throw new AbiError('uint exceeds expected bound');
  return Number(v);
}
export function decAddress(hex) {
  const w = words(hex, 1)[0];
  if (!/^0{24}/.test(w)) throw new AbiError('dirty address word');
  return '0x' + w.slice(24);
}
/** uint8[7] (static) — Argonauts.traitsOf */
export function decUint8x7(hex) {
  return words(hex, 7).map(w => {
    const v = BigInt('0x' + w);
    if (v > 255n) throw new AbiError('uint8 out of range');
    return Number(v);
  });
}
/** bytes21 — left-aligned in its word, the 11 low bytes must be zero */
export function decBytes21(hex) {
  const w = words(hex, 1)[0];
  if (!/0{22}$/.test(w)) throw new AbiError('dirty bytes21 word');
  return '0x' + w.slice(0, 42);
}
/** bytes / string (dynamic, single return value) — offset 0x20, exact zero-padded length. Returns Uint8Array. */
export function decBytes(hex, maxLen = 4_000_000) {
  const h = strip(hex);
  if (h.length < 128) throw new AbiError('dynamic bytes returndata too short');
  if (BigInt('0x' + h.slice(0, 64)) !== 32n) throw new AbiError('unexpected dynamic offset');
  const n = BigInt('0x' + h.slice(64, 128));
  if (n > BigInt(maxLen)) throw new AbiError('bytes length above bound');
  const len = Number(n), padded = Math.ceil(len / 32) * 64;
  if (h.length !== 128 + padded) throw new AbiError('bytes returndata length mismatch');
  if (!/^0*$/.test(h.slice(128 + 2 * len))) throw new AbiError('dirty bytes padding');
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(h.slice(128 + 2 * i, 130 + 2 * i), 16);
  return out;
}
export const decString = (hex, maxLen) => new TextDecoder('utf-8', { fatal: true }).decode(decBytes(hex, maxLen));

/** uint256[] (dynamic, single return value) — offset must be 0x20 and the length must match exactly */
export function decUintArray(hex, maxLen = 1_000_000) {
  const h = strip(hex);
  if (h.length < 128) throw new AbiError('dynamic array returndata too short');
  const off = BigInt('0x' + h.slice(0, 64));
  if (off !== 32n) throw new AbiError('unexpected dynamic offset');
  const n = BigInt('0x' + h.slice(64, 128));
  if (n > BigInt(maxLen)) throw new AbiError('array length above bound');
  const len = Number(n);
  if (h.length !== 128 + 64 * len) throw new AbiError('array returndata length mismatch');
  return Array.from({ length: len }, (_, i) => BigInt('0x' + h.slice(128 + 64 * i, 192 + 64 * i)));
}
