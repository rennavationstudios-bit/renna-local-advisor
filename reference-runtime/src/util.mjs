import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { FleetError } from "./errors.mjs";

export function nowIso() {
  return new Date().toISOString();
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function fileSha256(file) {
  return sha256(await fsp.readFile(file));
}

export async function ensureDir(directory) {
  await fsp.mkdir(directory, { recursive: true });
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    if (error instanceof SyntaxError) {
      throw new FleetError("INVALID_JSON", `Invalid JSON in ${file}`, { file, cause: error.message });
    }
    throw error;
  }
}

export async function atomicJson(file, value) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, file);
}

export async function atomicText(file, value) {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, String(value), "utf8");
  await fsp.rename(temporary, file);
}

export async function appendJsonl(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

export function normalizeRelativePath(value) {
  const rendered = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!rendered || path.posix.isAbsolute(rendered) || /^[a-z]:\//i.test(rendered)) {
    throw new FleetError("INVALID_PATH", `Path must be repository-relative: ${value}`);
  }
  const normalized = path.posix.normalize(rendered);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new FleetError("PATH_TRAVERSAL", `Path escapes repository: ${value}`);
  }
  if (normalized.split("/").some((part) => !part || part === ".")) {
    throw new FleetError("INVALID_PATH", `Path is not canonical: ${value}`);
  }
  return normalized;
}

export function uniquePaths(values = []) {
  const seen = new Map();
  for (const value of values) {
    const normalized = normalizeRelativePath(value);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) seen.set(key, normalized);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolvedTarget;
  throw new FleetError("PATH_OUTSIDE_ROOT", `Resolved path is outside the allowed root`, {
    root: resolvedRoot,
    target: resolvedTarget,
  });
}

export async function assertResolvedInside(root, target) {
  const resolvedRoot = await fsp.realpath(path.resolve(root));
  let existing = path.resolve(target);
  while (true) {
    try {
      existing = await fsp.realpath(existing);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  assertInside(resolvedRoot, existing);
  return path.resolve(target);
}

const SECRET_KEY = /(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential)/i;
const SECRET_VALUE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bcsk-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}|\bsk_live_[A-Za-z0-9]{16,}\b|\bAIza[A-Za-z0-9_-]{30,}\b|\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9._~-]{12,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b|\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)[A-Za-z0-9_-]{8,}\b|\b(?:password|passwd|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|credential)\s*[:=]\s*\S+)/i;
const SECRET_VALUE_GLOBAL = new RegExp(SECRET_VALUE.source, "gi");
const PUBLIC_CONFIG_IDENTIFIER = /^(?:[A-Za-z][A-Za-z0-9]*[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)(?:[_-](?:binding|name|env|variable|identifier|id|reference|placeholder))+$/i;

function containsSecretValue(value) {
  const rendered = String(value);
  SECRET_VALUE_GLOBAL.lastIndex = 0;
  for (const match of rendered.matchAll(SECRET_VALUE_GLOBAL)) {
    // Symbolic configuration names such as CLOUDFLARE_API_KEY_BINDING are
    // public identifiers, not credential values. If such a name is used as an
    // assignment key, exempt it only when the assigned value is another public
    // symbolic identifier. A generic token assigned to the binding still fails.
    if (PUBLIC_CONFIG_IDENTIFIER.test(match[0])) {
      const tail = rendered.slice((match.index ?? 0) + match[0].length);
      const assignment = tail.match(/^(?:["']?\s*)?[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;}]+))/u);
      if (!assignment) continue;
      const assigned = assignment[1] ?? assignment[2] ?? assignment[3] ?? '';
      const symbolic = assigned.split('.').at(-1);
      if (PUBLIC_CONFIG_IDENTIFIER.test(symbolic)) continue;
    }
    return true;
  }
  return false;
}

export function assertNoSecretValues(value, location = "root") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretValues(entry, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && containsSecretValue(value)) {
      throw new FleetError("SECRET_VALUE_REJECTED", `Credential-shaped value rejected at ${location}`);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const refKey = /(?:ref|reference|profile)$/i.test(key);
    if (SECRET_KEY.test(key) && !refKey && entry !== null) {
      throw new FleetError("SECRET_FIELD_REJECTED", `Secret-bearing field rejected at ${location}.${key}`);
    }
    if (refKey && typeof entry === "string" && /^(?:vault|credential):\/\/[A-Za-z0-9._/-]+$/u.test(entry)) continue;
    assertNoSecretValues(entry, `${location}.${key}`);
  }
}

const SECRET_ASSIGNMENT = /[A-Za-z0-9_.-]*(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential)[A-Za-z0-9_.-]*\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;}#]+))/giu;

export function assertNoSensitiveSourceEcho(value, sourceContents, location = "root") {
  const rendered = JSON.stringify(value);
  if (!Array.isArray(sourceContents) || typeof rendered !== "string") return;
  for (const content of sourceContents) {
    if (typeof content !== "string") continue;
    for (const match of content.matchAll(SECRET_ASSIGNMENT)) {
      const assigned = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (assigned.length < 8 || PUBLIC_CONFIG_IDENTIFIER.test(assigned.split(".").at(-1))) continue;
      if (rendered.includes(assigned)) {
        throw new FleetError("SENSITIVE_SOURCE_ECHO_REJECTED", `Sensitive source value echoed at ${location}`);
      }
    }
  }
}

// Withhold an entire untrusted tool result when it contains credential-shaped
// text. Keep its protocol identity and the original stored transcript intact.
// Callers still validate message shapes and reject secrets in every other field.
export function withholdCredentialToolResults(messages) {
  return messages.map((message) => {
    if (message?.role !== "tool") return message;
    try { assertNoSecretValues(message.content, "tool-result-content"); }
    catch (error) {
      if (!["SECRET_VALUE_REJECTED", "SECRET_FIELD_REJECTED"].includes(error.code)) throw error;
      return { ...message, content: "[Host: this tool result was withheld because it contains credential-shaped text, which can include authentication diagnostics. It is not a provider outage or successful result. Do not repeat that command unchanged, read credentials, or infer its hidden contents. Explain the limitation and continue with another appropriate tool if available.]" };
    }
    return message;
  });
}

export function commandIdentity(argv) {
  return sha256(stableJson(argv.map(String)));
}

function executableArgv(argv) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(argv[0])) {
    return { command: argv[0], args: argv.slice(1) };
  }
  if (argv.some((entry) => /[\r\n\0"&|<>^%]/.test(entry))) {
    throw new FleetError("CMD_SHIM_ARGUMENT_UNSAFE", "Windows command-shim arguments contain unsupported shell metacharacters.");
  }
  const commandLine = argv.map((entry) => /\s/.test(entry) ? `"${entry}"` : entry).join(" ");
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", commandLine] };
}

export function runCommand(argv, { cwd, timeoutMs = 120_000, env = process.env, input = undefined } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((entry) => typeof entry !== "string")) {
    throw new FleetError("INVALID_COMMAND", "Commands must be a non-empty argv string array.");
  }
  const executable = executableArgv(argv);
  const startedAt = nowIso();
  const result = spawnSync(executable.command, executable.args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    argv,
    cwd: cwd ? path.resolve(cwd) : process.cwd(),
    commandIdentity: commandIdentity(argv),
    startedAt,
    finishedAt: nowIso(),
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function runCommandBuffer(argv, { cwd, timeoutMs = 120_000, env = process.env, input = undefined } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((entry) => typeof entry !== "string")) {
    throw new FleetError("INVALID_COMMAND", "Commands must be a non-empty argv string array.");
  }
  const executable = executableArgv(argv);
  const result = spawnSync(executable.command, executable.args, {
    cwd,
    env,
    input,
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    argv,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? result.error?.message ?? ""),
  };
}

export function runCommandAsync(argv, { cwd, timeoutMs = 120_000, env = process.env, input = undefined, signal: abortSignal } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some((entry) => typeof entry !== "string")) {
    throw new FleetError("INVALID_COMMAND", "Commands must be a non-empty argv string array.");
  }
  const executable = executableArgv(argv);
  const startedAt = nowIso();
  return new Promise((resolve) => {
    const child = spawn(executable.command, executable.args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let canceled = false;
    let termination = null;
    const terminateTree = (reason) => {
      if (termination) return;
      timedOut = reason === "timeout";
      canceled = reason === "cancellation";
      if (process.platform === "win32" && Number.isInteger(child.pid)) {
        const nativeTreeKiller = path.resolve(import.meta.dirname, "..", "native", "FleetSandboxLauncher", "bin", "Release", "fleet-sandbox-v1", "FleetSandboxLauncher.exe");
        const useNative = fs.existsSync(nativeTreeKiller);
        const command = useNative ? nativeTreeKiller : path.join(process.env.SystemRoot ?? "/SETUP_REQUIRED/path-5", "System32", "taskkill.exe");
        const args = useNative ? ["--kill-tree", String(child.pid)] : ["/PID", String(child.pid), "/T", "/F"];
        const killed = spawnSync(command, args, {
          encoding: "utf8", windowsHide: true, shell: false, timeout: 15_000,
        });
        termination = {
          method: useNative ? "native-tree-killer" : "taskkill-tree",
          reason,
          exitCode: Number.isInteger(killed.status) ? killed.status : null,
          stderr: killed.stderr ?? killed.error?.message ?? "",
        };
        if (killed.status !== 0 && child.exitCode === null) child.kill("SIGKILL");
      } else {
        termination = { method: "direct-sigkill", reason, exitCode: null, stderr: "" };
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => terminateTree("timeout"), timeoutMs);
    const onAbort = () => terminateTree("cancellation");
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => stderr.push(Buffer.from(error.message)));
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        argv,
        cwd: cwd ? path.resolve(cwd) : process.cwd(),
        commandIdentity: commandIdentity(argv),
        startedAt,
        finishedAt: nowIso(),
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal: signal ?? null,
        timedOut,
        canceled,
        termination,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function pathExists(target) {
  return fs.existsSync(target);
}
