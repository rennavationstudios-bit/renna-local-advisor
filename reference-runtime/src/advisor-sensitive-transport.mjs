import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HALO_BASE = 'https://worker-2.invalid/v1';
const R9700_BASE = 'https://worker-7.invalid/v1';
const RTX3090_BASE = 'https://worker-5.invalid/v1';
const HALO_SSH_HOST = 'SETUP_REQUIRED_SSH_HOST';
const fail = code => { throw Object.assign(new Error(code), { code }); };

function exactChatUrl(pin) {
  if (!pin || ![HALO_BASE, R9700_BASE, RTX3090_BASE].includes(pin.base)) fail('LOCAL_SENSITIVE_ENDPOINT_DENIED');
  const target = new URL(`${pin.base.replace(/\/$/, '')}/chat/completions`);
  if (target.protocol !== 'http:' || target.username || target.password || target.search || target.hash) fail('LOCAL_SENSITIVE_ENDPOINT_DENIED');
  return target;
}

function assignedLocally(hostname, networkInterfacesImpl) {
  if (hostname === 'SETUP_REQUIRED_ADDRESS_1' || hostname === '::1' || hostname === 'localhost') return true;
  return Object.values(networkInterfacesImpl()).flat().some(address => address?.address === hostname);
}

async function boundedFetch(target, options, fetchImpl) {
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: options.headers,
    body: options.body,
    signal: options.signal,
    redirect: 'error',
  });
  const reader = response.body?.getReader?.();
  if (!reader) fail('LOCAL_SENSITIVE_RESPONSE_INVALID');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > options.limitBytes) {
        await reader.cancel().catch(() => {});
        fail('LOCAL_SENSITIVE_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { ok: response.ok, status: response.status, raw: Buffer.concat(chunks).toString('utf8') };
}

function haloSshPost(target, options, spawnImpl) {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const statusMarker = 'ADVISOR_HTTP_STATUS:';
    const argv = [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=5', HALO_SSH_HOST,
      'curl', '--silent', '--show-error', '--max-time', '180', '--request', 'POST',
      '--header', 'Content-Type:application/json', '--data-binary', '@-',
      '--write-out', `%{stderr}\\n${statusMarker}%{http_code}\\n`, target.toString(),
    ];
    const systemRoot = process.env.SystemRoot ?? '/SETUP_REQUIRED/path-5';
    const sshDirectory = path.join(systemRoot, 'System32', 'OpenSSH');
    const ssh = path.join(sshDirectory, 'ssh.exe');
    const env = Object.fromEntries(['SystemRoot','WINDIR','USERPROFILE','HOMEDRIVE','HOMEPATH','TEMP','TMP','USERNAME','USERDOMAIN','APPDATA','LOCALAPPDATA','ProgramData','ProgramFiles','ProgramFiles(x86)']
      .map(name => [name, process.env[name]]).filter(([, value]) => typeof value === 'string' && value));
    env.Path = [sshDirectory, path.join(systemRoot, 'System32'), systemRoot].join(';');
    const child = spawnImpl(ssh, argv, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let oversized = false;
    let aborted = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      handler(value);
    };
    const stop = () => { if (child.exitCode === null) child.kill('SIGKILL'); };
    const onAbort = () => { aborted = true; stop(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.limitBytes) { oversized = true; stop(); return; }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 16_384) { oversized = true; stop(); return; }
      stderr.push(Buffer.from(chunk));
    });
    child.on('error', () => finish(reject, Object.assign(new Error('LOCAL_SENSITIVE_TRANSPORT_FAILED'), { code: 'LOCAL_SENSITIVE_TRANSPORT_FAILED' })));
    child.on('close', exitCode => {
      if (aborted) return finish(reject, Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }));
      if (oversized) return finish(reject, Object.assign(new Error('LOCAL_SENSITIVE_RESPONSE_TOO_LARGE'), { code: 'LOCAL_SENSITIVE_RESPONSE_TOO_LARGE' }));
      const diagnostic = Buffer.concat(stderr).toString('utf8');
      const matches = [...diagnostic.matchAll(new RegExp(`${statusMarker}(\\d{3})`, 'g'))];
      const status = Number(matches.at(-1)?.[1]);
      if (exitCode !== 0 || !Number.isInteger(status)) return finish(reject, Object.assign(new Error('LOCAL_SENSITIVE_TRANSPORT_FAILED'), { code: 'LOCAL_SENSITIVE_TRANSPORT_FAILED' }));
      finish(resolve, { ok: status >= 200 && status < 300, status, raw: Buffer.concat(stdout).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.body);
  });
}

export function sensitiveTransportLabel(pin) {
  const target = exactChatUrl(pin);
  if (pin.base === HALO_BASE) return 'ssh-encrypted-fixed-host';
  if (pin.base === RTX3090_BASE) return 'loopback-fixed-endpoint';
  if (pin.base === R9700_BASE) return 'host-local-fixed-address';
  fail('LOCAL_SENSITIVE_ENDPOINT_DENIED');
}

export async function postSensitiveLocalJson(pin, options, {
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  networkInterfacesImpl = os.networkInterfaces,
} = {}) {
  const target = exactChatUrl(pin);
  if (pin.base === HALO_BASE) return haloSshPost(target, options, spawnImpl);
  if (!assignedLocally(target.hostname, networkInterfacesImpl)) fail('LOCAL_SENSITIVE_ENDPOINT_DENIED');
  return boundedFetch(target.toString(), options, fetchImpl);
}
