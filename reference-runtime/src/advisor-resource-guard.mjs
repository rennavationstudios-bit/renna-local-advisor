import os from 'node:os';

export const availableHostMiB = () => os.freemem() / 1048576;
const fault = code => Object.assign(new Error(code), { code });
export function assertHostHeadroom(availableMiB, minimumMiB = 8192) {
  if (!Number.isFinite(availableMiB) || availableMiB < minimumMiB) throw fault('HOST_MEMORY_PRESSURE');
}

// The guard owns no process or lease. Its caller stops only its registered child
// and retains the reservation until exit has actually been confirmed.
export function startResourceGuard({ sample, onPressure, intervalMs = 1000, minimumHostMiB = 8192, minimumGpuMiB = 2048 }) {
  const controller = new AbortController();
  let stopped = false, pending = null;
  const check = () => {
    if (stopped || controller.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      try {
        const value = await sample();
        if (stopped) return;
        assertHostHeadroom(value.availableHostMiB, minimumHostMiB);
        if (!Number.isFinite(value.freeGpuMiB) || value.freeGpuMiB < minimumGpuMiB) throw fault('GPU_MEMORY_PRESSURE');
      } catch (error) {
        if (stopped) return;
        const reason = ['HOST_MEMORY_PRESSURE', 'GPU_MEMORY_PRESSURE'].includes(error.code) ? error : fault('RESOURCE_PROBE_FAILED');
        if (reason.code === 'RESOURCE_PROBE_FAILED') {
          // Retain fixed, non-sensitive failure categories, never command lines,
          // stdout/stderr, arbitrary exception text or environment data.
          reason.probeDiagnostic = {
            category: error.killed === true ? 'process-killed-or-timeout'
              : error.name === 'AbortError' ? 'cancelled'
              : error.code === 'RTX3090_GPU_IDENTITY_MISMATCH' ? 'invalid-gpu-observation'
              : error.code === 'ENOENT' ? 'executable-missing'
              : 'probe-execution-failed'
          };
        }
        controller.abort(reason);
        // Cleanup failures are owned by the runtime's idempotent close method.
        Promise.resolve().then(() => onPressure(reason)).catch(() => {});
      } finally { pending = null; }
    })();
    return pending;
  };
  const timer = setInterval(() => { void check(); }, intervalMs);
  timer.unref?.();
  return { signal: controller.signal, check, stop() { stopped = true; clearInterval(timer); } };
}
