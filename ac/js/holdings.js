// Holdings of ONE pasted wallet — Argonauts (via the deployless OwnedScan) and Credits (via tokensOf).
// Invariants (synthesis S3/E1/E2/E3 + chunk-1 GO):
//  - Argonauts: the 0..9999 range is scanned in SEGMENTS (each ≤ SEGMENT_GAS, under EIP-7825's 2^24
//    per-tx cap — the full loop needs ~37M gas), all pinned to ONE block. Every segment also returns
//    balanceOf(wallet): they must all agree, and the ids found across segments must add up to it.
//    Token #0 is the collection's "site" token (not an Argonaut) → counted for the invariant, never shown.
//  - Credits: tokensOf(wallet) — unique ids — and its length == balanceOf(wallet), same pinned block.
//  - Every failure (transport, revert, malformed/empty returndata, mismatch) → HoldingsError.
//    NEVER "you own nothing" from a failed read.
//  - Dead/burned Argonauts are not available: pasting 0x…dEaD is refused up front (Le 2026-09-24).
import { ADDR, enc, decSmallUint, decUintArray, decBytes21, decUint8x7, normalizeAddress, strip, word, addrWord } from './abi.js?v=00a5fa96ea';
import { SCANNER_BYTECODE } from './scanner-bytecode.js?v=0738094b3d';

export class HoldingsError extends Error {
  constructor(code, message, cause) { super(message); this.name = 'HoldingsError'; this.code = code; if (cause) this.cause = cause; }
}
const wrap = (code, what) => e => { throw e instanceof HoldingsError ? e : new HoldingsError(code, `${what}: ${e && e.message || e}`, e); };

export const SITE_TOKEN_ID = 0;
export const ARGO_MAX_ID = 9999;
export const SEGMENT = 2000;            // ids per scanner call → 5 calls for 0..9999
const SEGMENT_GAS = '0xe4e1c0';         // 15,000,000 — below the 16,777,216 (2^24) EIP-7825 cap
const MAX_ID_SAFE = 2 ** 32;

/** Parses the raw OwnedScan output. Exported for tests. */
export function parseScan(hex) {
  const h = strip(hex);
  if (h.length < 14) throw new HoldingsError('scan-malformed', 'scanner output too short');
  if (h.slice(0, 2) !== '00') throw new HoldingsError('scan-malformed', 'scanner prefix mismatch');
  const balance = parseInt(h.slice(2, 10), 16);
  const count = parseInt(h.slice(10, 14), 16);
  if (h.length !== 14 + 4 * count) throw new HoldingsError('scan-malformed', 'scanner length mismatch');
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(parseInt(h.slice(14 + 4 * i, 18 + 4 * i), 16));
  for (let i = 1; i < ids.length; i++) if (ids[i] <= ids[i - 1]) throw new HoldingsError('scan-malformed', 'ids not strictly increasing');
  return { balance, ids };
}

export function scanSegments(maxId = ARGO_MAX_ID, size = SEGMENT) {
  const segs = [];
  for (let from = 0; from <= maxId; from += size) segs.push([from, Math.min(maxId, from + size - 1)]);
  return segs;
}

async function scanOnce(rpc, who, block) {
  const calls = scanSegments().map(([from, to]) => ({
    method: 'eth_call',
    params: [{ data: SCANNER_BYTECODE + word(BigInt(ADDR.ARGONAUTS)) + addrWord(who) + word(from) + word(to), gas: SEGMENT_GAS }, block],
  }));
  const outs = await rpc.batchAll(calls).catch(wrap('rpc', 'could not read Argonauts'));
  const parts = outs.map(parseScan);
  const balance = parts[0].balance;
  if (parts.some(p => p.balance !== balance)) throw new HoldingsError('mismatch', 'balanceOf differs between scan segments');
  const segs = scanSegments();
  const ids = [];
  parts.forEach((p, i) => {
    const [from, to] = segs[i];
    if (p.ids.some(id => id < from || id > to)) throw new HoldingsError('scan-malformed', 'id outside its segment');
    ids.push(...p.ids);
  });
  return { balance, ids };
}

/** @returns {{ids:number[], siteToken:boolean, balance:number, block:string}} */
export async function readArgonauts(rpc, wallet) {
  const who = normalizeAddress(wallet);
  if (who === ADDR.DEAD) throw new HoldingsError('dead', 'burned Argonauts are not available');
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {           // S3: one retry on mismatch, then error
    const block = await rpc.blockNumber().catch(wrap('rpc', 'could not read the block number'));
    const { balance, ids } = await scanOnce(rpc, who, block);
    if (ids.length === balance) {
      const siteToken = ids[0] === SITE_TOKEN_ID;
      return { ids: siteToken ? ids.slice(1) : ids, siteToken, balance, block };
    }
    last = new HoldingsError('mismatch', `Argonauts found ${ids.length} ≠ balanceOf ${balance}`);
  }
  throw last;
}

/** @returns {{ids:number[], balance:number, block:string}} */
export async function readCredits(rpc, wallet, block) {
  const who = normalizeAddress(wallet);
  const blk = block || await rpc.blockNumber().catch(wrap('rpc', 'could not read the block number'));
  const [rTokens, rBal] = await rpc.batch([
    { method: 'eth_call', params: [{ to: ADDR.CREDITS, data: enc.tokensOf(who) }, blk] },
    { method: 'eth_call', params: [{ to: ADDR.CREDITS, data: enc.balanceOf(who) }, blk] },
  ]).catch(wrap('rpc', 'could not read Credits'));
  if (!rTokens.ok || !rBal.ok) throw new HoldingsError('rpc', 'could not read Credits: ' + ((rTokens.error || rBal.error).message), rTokens.error || rBal.error);
  let ids, balance;
  try {
    ids = decUintArray(rTokens.value, 1_000_000).map(v => { if (v >= BigInt(MAX_ID_SAFE)) throw new Error('id out of range'); return Number(v); });
    balance = decSmallUint(rBal.value, 1_000_000);
  } catch (e) {
    throw new HoldingsError('malformed', 'unexpected Credits returndata: ' + (e && e.message || e), e);
  }
  // tokensOf is swap-and-pop maintained (Credits.sol _removeOwned) ⇒ NOT sorted; check uniqueness, not order
  if (new Set(ids).size !== ids.length) throw new HoldingsError('malformed', 'duplicate ids in tokensOf');
  if (ids.length !== balance) throw new HoldingsError('mismatch', `Credits tokensOf ${ids.length} ≠ balanceOf ${balance}`);
  return { ids, balance, block: blk };
}

/** seed + paidAt for the given Credit ids (only the ones the UI needs). Pinned to `block`. */
export async function readCreditData(rpc, ids, block = 'latest') {
  const calls = [];
  for (const id of ids) {
    calls.push({ method: 'eth_call', params: [{ to: ADDR.CREDITS, data: enc.seedOf(id) }, block] });
    calls.push({ method: 'eth_call', params: [{ to: ADDR.CREDITS, data: enc.timestampOf(id) }, block] });
  }
  const vals = await rpc.batchAll(calls).catch(wrap('rpc', 'could not read Credit data'));
  try {
    return ids.map((id, i) => {
      const seed = decBytes21(vals[2 * i]);
      const paidAt = decSmallUint(vals[2 * i + 1], 2 ** 53 - 1);
      if (seed === '0x' + '0'.repeat(42) || paidAt === 0) throw new HoldingsError('malformed', `Credit #${id} has no seed/timestamp`);
      return { id, seed, paidAt };
    });
  } catch (e) { return wrap('malformed', 'unexpected Credit data')(e); }
}

/** traitsOf for the given Argonaut ids. */
export async function readArgonautTraits(rpc, ids, block = 'latest') {
  const vals = await rpc.batchAll(ids.map(id => ({ method: 'eth_call', params: [{ to: ADDR.ARGONAUTS, data: enc.traitsOf(id) }, block] })))
    .catch(wrap('rpc', 'could not read Argonaut traits'));
  try { return ids.map((id, i) => ({ id, traits: decUint8x7(vals[i]) })); }
  catch (e) { return wrap('malformed', 'unexpected traits returndata')(e); }
}
