// Candidate helpers. Only actual execution calls these; status never does.
import http from 'node:http';
import crypto from 'node:crypto';

export function controlPost(route, value, { timeoutMs = route === '/begin' ? 5600 : 3800 } = {}) {
  if (!['/begin', '/heartbeat', '/end'].includes(route)) throw new Error('INVALID_PRIORITY_ROUTE');
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 1024) throw new Error('PRIORITY_BODY_TOO_LARGE');
  return fixedLoopbackPost(18774, route, body, timeoutMs);
}

export function cudaControlPost() {
  return fixedLoopbackPost(18768, '/preempt', '', 3000);
}

function fixedLoopbackPost(port, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => { clearTimeout(deadline); callback(value); };
    const req = http.request({ host: 'SETUP_REQUIRED_ADDRESS_1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let raw = '';
      res.on('data', b => { raw += b; if (Buffer.byteLength(raw) > 4096) req.destroy(Object.assign(new Error('PRIORITY_RESPONSE_TOO_LARGE'), { code: 'PRIORITY_RESPONSE_TOO_LARGE' })); });
      res.on('end', () => { try { const data = JSON.parse(raw); if (res.statusCode !== 200) throw Object.assign(new Error('PRIORITY_CONTROL_FAILED'), { code: 'PRIORITY_CONTROL_FAILED' }); finish(resolve, data); } catch (e) { finish(reject, e); } });
      res.on('error', e => finish(reject, e));
    });
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('PRIORITY_CONTROL_TIMEOUT'), { code: 'PRIORITY_CONTROL_TIMEOUT' })), timeoutMs);
    req.on('error', e => finish(reject, e)); req.end(body);
  });
}

const safeReason = e => /^[A-Z_]{1,80}$/.test(e?.code ?? '') ? e.code : 'PRIORITY_CONTROL_FAILED';
export async function beginCudaRadioPriority({ post = cudaControlPost } = {}) {
  try {
    const result = await post();
    return { installed: true, preempted: !!result?.status && typeof result.status === 'object' };
  } catch (e) {
    // Best effort only: the ordinary RTX acquisition must still inspect and
    // acquire the actual GPU lease; it decides whether the hardware is busy.
    return { installed: e.code !== 'ECONNREFUSED', preempted: false, reason: safeReason(e) };
  }
}

export async function beginHaloRadioPriority({ post = controlPost, heartbeatMs = 10000, onLost = () => {}, timeoutMs = 5600 } = {}) {
  const owner = crypto.randomUUID(), token = crypto.randomBytes(32).toString('hex');
  let claim;
  try { claim = await post('/begin', { owner, token }, { timeoutMs: Math.max(1, Math.min(5600, timeoutMs)) }); }
  catch (e) {
    // Radio coordination cannot cancel normal work. Existing resident health,
    // busy and lease checks remain authoritative after any failed preemption.
    return { installed: e.code !== 'ECONNREFUSED', acquired: false, reason: safeReason(e), close: async () => {} };
  }
  if (claim?.ok !== true) return { installed: true, acquired: false, reason: 'PRIORITY_CLAIM_FAILED', close: async () => {} };
  let ended = false, pending = Promise.resolve(), lost = false;
  const timer = setInterval(() => {
    pending = pending.then(async () => {
      if (ended || lost) return;
      try { const result = await post('/heartbeat', { owner, token }); if (result?.ok !== true) throw new Error('PRIORITY_CLAIM_LOST'); }
      catch { lost = true; try { onLost(); } catch {} }
    });
  }, heartbeatMs);
  timer.unref?.();
  return { installed: true, acquired: true, idleConfirmed: claim.idleConfirmed !== false, get lost() { return lost; }, close: async () => { if (ended) return; ended = true; clearInterval(timer); await pending; try { await post('/end', { owner, token }); } catch {} } };
}
