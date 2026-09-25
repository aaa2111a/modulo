// ENS forward resolution, fully on-chain through the same RPC (delta D7 + A10): name → namehash → Registry.resolver
// → resolver.addr. Only lowercase-ASCII `.eth` names (ASCII uppercase is folded, as ENSIP-15 does); anything else →
// "use a 0x address". Off-chain (CCIP-Read / wildcard ENSIP-10) names are NOT supported and report "not found".
import { keccak256, utf8 } from './keccak.js?v=231a6f8be6';
import { selectorOf, decAddress, AbiError } from './abi.js?v=37c56b03cf';

export const ENS_REGISTRY = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const SEL = { resolver: selectorOf('resolver(bytes32)'), addr: selectorOf('addr(bytes32)') };
export class EnsError extends Error { constructor(code, msg) { super(msg); this.name = 'EnsError'; this.code = code; } }

/** Returns the normalized name, or throws EnsError('unsupported'). No network. */
export function normalizeEnsName(input) {
  const name = String(input).trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/.test(name)) throw new EnsError('unsupported', 'only plain .eth names (a-z, 0-9, -) are supported — or paste a 0x address');
  for (const label of name.split('.')) if (label.length >= 4 && label.slice(2, 4) === '--') throw new EnsError('unsupported', 'labels with "--" at positions 3-4 are not supported');
  return name;
}
export const looksLikeEns = s => /\.eth\s*$/i.test(String(s));

/** EIP-137 namehash → '0x' + 64 hex */
export function namehash(name) {
  let node = new Uint8Array(32);
  if (name) for (const label of name.split('.').reverse()) {
    const buf = new Uint8Array(64); buf.set(node); buf.set(keccak256(utf8(label)), 32);
    node = keccak256(buf);
  }
  return '0x' + Array.from(node, b => b.toString(16).padStart(2, '0')).join('');
}

/** an eth_call revert as reported by a JSON-RPC node (EIP-1474 code 3, or the geth-style "execution reverted") */
const isRevert = e => !!e && e.kind === 'rpc' && (e.code === 3 || /revert/i.test(String(e.message)));

/** name → lowercase 0x address. EnsError: 'unsupported' | 'not-found' | 'rpc'. */
export async function resolveEns(rpc, input) {
  const name = normalizeEnsName(input);
  const node = namehash(name).slice(2);
  let resolver, addr;
  try { resolver = decAddress(await rpc.ethCall(ENS_REGISTRY, SEL.resolver + node)); }
  catch { throw new EnsError('rpc', 'could not reach the ENS registry'); }
  if (/^0x0{40}$/.test(resolver)) throw new EnsError('not-found', `${name} has no resolver`);
  try { addr = decAddress(await rpc.ethCall(resolver, SEL.addr + node)); }
  catch (e) {
    // only a REVERT (off-chain / CCIP-Read resolver, no addr()) or undecodable returndata means "does not resolve";
    // a transport failure, rate limit or any other RPC error is a failed read → 'rpc' (retryable), never a negative
    if (isRevert(e) || e instanceof AbiError) throw new EnsError('not-found', `${name} does not resolve on-chain (off-chain names are not supported)`);
    throw new EnsError('rpc', `could not resolve ${name}: ${(e && e.message) || e}`);
  }
  if (/^0x0{40}$/.test(addr)) throw new EnsError('not-found', `${name} has no address`);
  return addr;
}
