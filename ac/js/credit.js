// Credits (Jack Butcher) — JS port of CreditDrawing.sol / CreditArt.sol (verified-sources/credits/src),
// plus the engine input derived from a Credit (delta synthesis D4/D5, Le's FD1-FD4, amendments A6/A7).
// The port is proven by tests/test-credit.mjs: `creditSvg(seed, paidAt)` must equal the chain's
// `CreditArt.svg(seed, paidAt)` STRING, byte for byte, on ≥50 fixtures covering every rule.
import { sha256 } from './sha256.js?v=7d4b8416df';
import { GRID_W, GRID_H, VIEW } from './engine-ac.js?v=8410dea0c1';

const INKS = [0x00b5e2, 0xe4007c, 0xffd100, 0x111111];   // C M Y K
export const WHITE = 0xffffff, BLACK_GROUND = 0x111111;
// Max palette size is 15 BY CONSTRUCTION: masks 1..15 give 14 distinct inks (7 and 15 are both #000000; mask 8 is
// #111111 = the black ground), + white = 15 (chunk-4 GO: 49k-pair differential, 60k-Credit census).

export class CreditError extends Error { constructor(msg) { super(msg); this.name = 'CreditError'; } }

/** seed: '0x' + 42 hex (bytes21) or Uint8Array(21) → Uint8Array(21) of [0-9A-Za-z] */
export function seedBytes(seed) {
  let b;
  if (seed instanceof Uint8Array) b = seed;
  else {
    const hex = String(seed).replace(/^0x/, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new CreditError('seed is not even-length hex');
    b = Uint8Array.from(hex.match(/../g) || [], h => parseInt(h, 16));
  }
  if (b.length !== 21) throw new CreditError('seed must be 21 bytes');
  for (const c of b) if (!((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a))) throw new CreditError('seed is not alphanumeric (CreditArt.valid)');
  return b;
}
function checkPaidAt(paidAt) {
  const v = BigInt(paidAt);
  if (v < 1n || v >= 1n << 64n) throw new CreditError('payment time outside uint64 (> 0)');
  return v;
}
export const seedAscii = seed => String.fromCharCode(...seedBytes(seed));
const bit = (hash, index) => (hash[index >> 3] >> (7 - (index & 7))) & 1;   // MSB-first, as shr(sub(255,i),hash)

/** CreditDrawing.palette(): 16 multiplied colours, index = CMYK mask */
export function palette() {
  const colors = [];
  for (let mask = 0; mask < 16; mask++) {
    let r = 255, g = 255, b = 255;
    for (let layer = 0; layer < 4; layer++) {
      if (!(mask & (1 << layer))) continue;
      const ink = INKS[layer];
      r = Math.floor((r * ((ink >> 16) & 255) + 127) / 255);
      g = Math.floor((g * ((ink >> 8) & 255) + 127) / 255);
      b = Math.floor((b * (ink & 255) + 127) / 255);
    }
    colors.push((r << 16) | (g << 8) | b);
  }
  return colors;
}
const PALETTE = palette();

/** CreditDrawing.platesAt: the payment second picks one of the 15 non-empty CMYK masks */
export function platesAt(paidAt) {
  const mask = Number(checkPaidAt(paidAt) % 15n) + 1;
  return [0, 1, 2, 3].map(i => (mask & (1 << i)) !== 0);
}
export const eights = seed => seedBytes(seed).reduce((n, c) => n + (c === 0x38 ? 1 : 0), 0);

const misprintHash = seed => { const s = seedBytes(seed), m = new Uint8Array(30); m.set(s); m.set([...'/misprint'].map(c => c.charCodeAt(0)), 21); return sha256(m); };

/** CreditArt._register */
export function register(seed) {
  const h = misprintHash(seed);
  if (h[0] >= 32) return 'Registered';
  const d = h[1];
  return d < 80 ? 'Nudge' : d < 160 ? 'Slip' : d < 210 ? 'Skew' : d < 240 ? 'Drift' : 'Loose';
}

/** CreditDrawing.slips → {dx:[4], dy:[4]} */
export function slips(seed) {
  const h = misprintHash(seed);
  const dx = [0, 0, 0, 0], dy = [0, 0, 0, 0];
  if (h[0] >= 32) return { dx, dy };
  const dice = h[1];
  let maxStep = 1, movers = 1, kMoves = false;
  if (dice < 80) movers = 1;
  else if (dice < 160) movers = 2;
  else if (dice < 210) movers = 3;
  else if (dice < 240) { maxStep = 2; movers = 2 + (h[2] % 2); }
  else { maxStep = 2; movers = 3 + (h[2] % 2); kMoves = true; }
  const pool = [0, 1, 2, 3];
  let poolLen = kMoves ? 4 : 3, cursor = 3, chosen = 0;
  const selected = [];
  while (chosen < movers && poolLen > 0) {
    const idx = h[cursor++ % 32] % poolLen;
    selected[chosen++] = pool[idx];
    for (let j = idx; j + 1 < poolLen; j++) pool[j] = pool[j + 1];   // JS-splice order, as the contract
    poolLen--;
  }
  const UX = [-1, 1, 0, 0, -1, -1, 1, 1], UY = [0, 0, -1, 1, -1, 1, -1, 1];
  for (let i = 0; i < chosen; i++) {
    const layer = selected[i];
    const b = h[(layer + cursor) % 32], c = h[(layer + cursor + 4) % 32];
    let x, y;
    if (maxStep === 1) { const d = b % 8; x = UX[d]; y = UY[d]; }
    else { x = (b % 5) - 2; y = (c % 5) - 2; if (x === 0 && y === 0) x = (b & 1) ? 2 : -2; }
    dx[layer] = x; dy[layer] = y;
  }
  return { dx, dy };
}

/** CreditDrawing.raster → Uint8Array(144) of CMYK masks on a 12×12 grid (plates at 2+slip) */
export function raster(hash, dx, dy, enabled) {
  const px = new Uint8Array(144);
  for (let layer = 0; layer < 4; layer++) {
    if (!enabled[layer]) continue;
    const ox = 2 + dx[layer], oy = 2 + dy[layer];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
      if (bit(hash, layer * 64 + y * 8 + x)) px[(y + oy) * 12 + (x + ox)] |= 1 << layer;
  }
  return px;
}

/** CreditDrawing.center (signed, as the EVM wrap-around resolves) */
export function center(hash, dx, dy) {
  const px = raster(hash, dx, dy, [true, true, true, true]);
  let minX = 12, minY = 12, maxX = 0, maxY = 0;
  for (let i = 0; i < 144; i++) if (px[i]) {
    const x = i % 12, y = Math.floor(i / 12);
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x + 1 > maxX) maxX = x + 1; if (y + 1 > maxY) maxY = y + 1;
  }
  if (minX >= 12) return { ox: 80, oy: 80 };
  return { ox: 80 + (12 - minX - maxX) * 10, oy: 80 + (12 - minY - maxY) * 10 };
}

const d3 = n => { if (n < 0 || n >= 1000) throw new CreditError('SVG coordinate'); return String(n).padStart(3, '0'); };   // == the contract's require → revert
const hex6 = c => c.toString(16).padStart(6, '0');
const rect = (x, y, w, h, c) => `<rect x="${d3(x)}" y="${d3(y)}" width="${d3(w)}" height="${d3(h)}" fill="#${hex6(c)}"/>`;

/** Everything about one Credit, from its seed + payment time. */
export function describeCredit(seed, paidAt) {
  const s = seedBytes(seed);
  const hash = sha256(s);
  const { dx, dy } = slips(s);
  const enabled = platesAt(paidAt);
  const n8 = eights(s);
  let pad = 0;
  for (let i = 0; i < 4; i++) pad = Math.max(pad, Math.abs(dx[i]), Math.abs(dy[i]));
  const { ox, oy } = pad !== 0 ? center(hash, dx, dy) : { ox: 80, oy: 80 };
  return { seed: s, hash, dx, dy, pad, enabled, eights: n8, register: register(s), ox, oy, pixels: raster(hash, dx, dy, enabled) };
}

/** CreditArt.svg(seed, paidAt) — the non-compact CreditDrawing.body, as a string */
export function creditSvg(seed, paidAt) {
  const c = describeCredit(seed, paidAt);
  let out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 320" shape-rendering="crispEdges">';
  out += `<rect width="320" height="320" fill="${c.eights >= 5 ? '#111111' : '#ffffff'}"/>`;
  out += rect(c.ox, c.oy, 160, 160, WHITE);
  for (let y = -c.pad; y < 8 + c.pad; y++) for (let x = -c.pad; x < 8 + c.pad; x++) {
    const mask = c.pixels[(y + 2) * 12 + x + 2];
    if (mask) out += rect(c.ox + x * 20, c.oy + y * 20, 20, 20, PALETTE[mask]);
  }
  const n = Math.min(c.eights, 4);
  for (let i = 0; i < n; i++) out += rect((16 - n + i) * 20, 300, 20, 20, PALETTE[1 << (4 - n + i)]);
  return out + '</svg>';
}

// ── engine input (delta D4/D5 + Le: FD1 present colours only, FD2 faithful, FD3 plain outside) ──
const VIEW_X = VIEW.x, VIEW_Y = VIEW.y;   // the engine's visible 24×24 window (single source: engine-ac.js)

/** colour + ordering key of raster cell i: ink → palette[mask] (key=mask); empty inside paper (2..9) → white
 *  (key 0); empty outside → ground: #111111 (key 8) when ≥5 "8"s, else white (key 0). */
export function cellColor(c, i) {
  const mask = c.pixels[i];
  if (mask) return { rgb: PALETTE[mask], key: mask };
  const x = i % 12, y = Math.floor(i / 12);
  const inPaper = x >= 2 && x <= 9 && y >= 2 && y <= 9;
  if (!inPaper && c.eights >= 5) return { rgb: BLACK_GROUND, key: 8 };
  return { rgb: WHITE, key: 0 };
}

/**
 * The Credit as engine input: { pal: [[r,g,b]…] (2..15), init: Uint8Array(450×250), fill, cells }.
 * PAL = distinct colours PRESENT in the 12×12 raster, most frequent first, ties by key (A7).
 * Initial pattern: the 12×12 raster at 2× exactly on the visible 24×24 window (213,113); every other cell is
 * the plain ground (paper white, or #111111 when ≥5 "8"s) — FD3 "liso".
 */
export function creditEngineInput(seed, paidAt) {
  const c = describeCredit(seed, paidAt);
  const stats = new Map();   // rgb → {count, key}
  const cells = [];
  for (let i = 0; i < 144; i++) {
    const { rgb, key } = cellColor(c, i);
    cells.push(rgb);
    const s = stats.get(rgb);
    if (s) { s.count++; if (key < s.key) s.key = key; } else stats.set(rgb, { count: 1, key });
  }
  const groundRgb = c.eights >= 5 ? BLACK_GROUND : WHITE;
  if (!stats.has(groundRgb)) stats.set(groundRgb, { count: 0, key: c.eights >= 5 ? 8 : 0 });
  const order = [...stats.entries()].sort((a, b) => b[1].count - a[1].count || a[1].key - b[1].key).map(([rgb]) => rgb);
  if (order.length < 2 || order.length > 15) throw new CreditError(`Credit palette size ${order.length} outside 2..15`);
  const index = new Map(order.map((rgb, i) => [rgb, i]));
  const init = new Uint8Array(GRID_W * GRID_H).fill(index.get(groundRgb));
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const v = index.get(cells[y * 12 + x]);
    for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) init[(VIEW_Y + 2 * y + yy) * GRID_W + VIEW_X + 2 * x + xx] = v;
  }
  return { pal: order.map(rgb => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255]), init, fill: groundRgb, cells, credit: c };
}
