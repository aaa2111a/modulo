// JSON-RPC transport for Project AC. In production the page is served from modulo.ubk.art and talks
// to the SAME-ORIGIN Modulo Worker at /rpc (Alchemy key stays server-side). Worker limits (rpc-proxy/
// worker.js): ≤20 calls per batch, 64 KB request body, method allowlist (eth_call, eth_getCode,
// eth_blockNumber, … — NOT eth_getStorageAt), eth_getLogs pinned to Modulo's contracts.
//
// Contract of this module:
//  - transport failures (network, timeout, non-200, non-JSON) → RpcError kind 'transport' (retried)
//  - JSON-RPC error objects (reverts, method not allowed)      → RpcError kind 'rpc'       (NOT retried)
//  - a missing `result` is an error, never an empty value.

export const MAX_BATCH = 20;
export const MAX_BODY = 60 * 1024;   // stay under the Worker's 64 KB cap

export class RpcError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.name = 'RpcError'; this.kind = kind; Object.assign(this, extra); }
}

export function createRpc(url, { timeoutMs = 15000, retries = 2, fetchImpl = globalThis.fetch, maxBatch = MAX_BATCH } = {}) {
  let nextId = 1;
  const BATCH = Math.max(1, Math.min(MAX_BATCH, maxBatch | 0));

  async function post(body) {
    const text = JSON.stringify(body);
    if (text.length > MAX_BODY) throw new RpcError('client', `request body ${text.length} B exceeds ${MAX_BODY} B`);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text, signal: ctl.signal });
        if (!res.ok) {
          const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
          throw new RpcError('transport', `HTTP ${res.status}`, { status: res.status, retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : 0 });
        }
        let json;
        try { json = await res.json(); } catch { throw new RpcError('transport', 'non-JSON response'); }
        return json;
      } catch (e) {
        lastErr = e instanceof RpcError ? e : new RpcError('transport', e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e));
        // 4xx other than 429 is our request's fault (e.g. 403 method not allowed) — do not retry
        if (lastErr.status && lastErr.status >= 400 && lastErr.status < 500 && lastErr.status !== 429) break;
        // backoff with jitter (a shared Worker must not see synchronized retry waves); honour Retry-After (≤10 s)
        if (attempt < retries) await new Promise(r => setTimeout(r, Math.max(lastErr.retryAfterMs || 0, 400 * 2 ** attempt * (0.5 + Math.random()))));
      } finally { clearTimeout(timer); }
    }
    throw lastErr;
  }

  function unwrap(resp, method) {
    if (!resp || typeof resp !== 'object') throw new RpcError('transport', 'malformed JSON-RPC response');
    if (resp.error) throw new RpcError('rpc', resp.error.message || 'rpc error', { code: resp.error.code, data: resp.error.data, method });
    if (!('result' in resp) || resp.result === null || resp.result === undefined) throw new RpcError('rpc', 'missing result', { method });
    return resp.result;
  }

  async function request(method, params = []) {
    const id = nextId++;
    return unwrap(await post({ jsonrpc: '2.0', id, method, params }), method);
  }

  /** calls: [{method, params}] (≤ MAX_BATCH). Returns [{ok:true,value}|{ok:false,error}] in the SAME order. */
  async function batch(calls) {
    if (!Array.isArray(calls) || calls.length === 0) return [];
    if (calls.length > BATCH) throw new RpcError('client', `batch of ${calls.length} exceeds ${BATCH}`);
    const ids = calls.map(() => nextId++);
    const resp = await post(calls.map((c, i) => ({ jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params || [] })));
    if (!Array.isArray(resp)) {
      // a single error object for the whole batch (e.g. Worker 'Bad batch size')
      throw new RpcError('rpc', (resp && resp.error && resp.error.message) || 'batch rejected');
    }
    const byId = new Map(resp.map(r => [r && r.id, r]));
    return calls.map((c, i) => {
      const r = byId.get(ids[i]);
      if (!r) return { ok: false, error: new RpcError('transport', 'missing batch entry', { method: c.method }) };
      try { return { ok: true, value: unwrap(r, c.method) }; } catch (e) { return { ok: false, error: e }; }
    });
  }

  /** Runs any number of calls in sequential batches of ≤ BATCH. Throws on the FIRST failed call. */
  async function batchAll(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += BATCH) {
      const part = await batch(calls.slice(i, i + BATCH));
      for (const r of part) { if (!r.ok) throw r.error; out.push(r.value); }
    }
    return out;
  }

  const ethCall = (to, data, block = 'latest', extra = {}) => request('eth_call', [{ ...(to ? { to } : {}), data, ...extra }, block]);
  const blockNumber = async () => {
    const h = await request('eth_blockNumber');
    if (!/^0x[0-9a-f]+$/i.test(h)) throw new RpcError('rpc', 'bad block number');
    return h;
  };

  return { request, batch, batchAll, ethCall, blockNumber };
}
