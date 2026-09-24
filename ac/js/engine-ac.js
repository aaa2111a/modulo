// The ONLY constructor of artifact engines in the app (delta A4): every engine the app builds — stage, PNG,
// cubes, thumbnails — goes through makeAcEngine, so none can forget the Credit injection and silently paint
// the artifact's own colours. tests/test-engine.mjs greps app/ for any other `_createArtifactEngine(` call.
import { _createArtifactEngine, _normalizeComposition, _extractComposition } from './engine.js';

export const GRID_W = 450, GRID_H = 250, GRID_CELLS = GRID_W * GRID_H;
export const VIEW = Object.freeze({ x: 213, y: 113, w: 24, h: 24 });   // the 24×24 window Punks shows (1 cell = 1 px)

export class EngineError extends Error { constructor(msg) { super(msg); this.name = 'EngineError'; } }

/**
 * @param canvas  any object with getContext('2d') (the engine keeps it for render(); the app paints via paintToNativeCrop)
 * @param comp    a NORMALIZED composition (from normalizeComposition / the getArtifact adapter)
 * @param credit  { pal: [[r,g,b], …] (2..15 colours), init: Uint8Array(112500) of palette indices }
 */
export function makeAcEngine(canvas, comp, credit) {
  if (!comp || !Array.isArray(comp.tokens) || comp.tokens.length === 0) throw new EngineError('composition without tokens');
  if (!credit || !Array.isArray(credit.pal)) throw new EngineError('missing Credit palette');
  const N = credit.pal.length;
  if (N < 2 || N > 15) throw new EngineError(`Credit palette size ${N} outside 2..15`);
  for (const c of credit.pal) if (!Array.isArray(c) || c.length !== 3 || c.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw new EngineError('bad palette colour');
  const init = credit.init;
  if (!(init instanceof Uint8Array) || init.length !== GRID_CELLS) throw new EngineError('initial pattern must be a Uint8Array of 450×250');
  for (let i = 0; i < init.length; i++) if (init[i] >= N) throw new EngineError('initial pattern index outside the palette');
  const eng = _createArtifactEngine(canvas, comp, { pal: credit.pal.map(c => c.slice()), init });
  if (!eng) throw new EngineError('no 2d context for the engine canvas');   // the factory returns null without a ctx
  return eng;
}

export const normalizeComposition = _normalizeComposition;
export const extractComposition = _extractComposition;
