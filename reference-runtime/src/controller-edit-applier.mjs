import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { FleetError } from "./errors.mjs";
import { writerSandboxExecutable } from "./writer-sandbox.mjs";
import {
  assertInside,
  atomicText,
  ensureDir,
  fileSha256,
  normalizeRelativePath,
  sha256,
} from "./util.mjs";

const MAX_REQUEST_BYTES = 1_000_000;
const MAX_HELPER_OUTPUT_BYTES = 128_000;
const HELPER_RUNTIME_FILES = [
  "FleetSandboxLauncher.exe",
  "FleetSandboxLauncher.dll",
  "FleetSandboxLauncher.deps.json",
  "FleetSandboxLauncher.runtimeconfig.json",
];
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function inside(root, target) {
  try {
    assertInside(root, target);
    return true;
  } catch {
    return false;
  }
}

async function createControllerDirectory(sandboxRoot, worktree) {
  if (!sandboxRoot) throw new FleetError("CONTROLLER_EDIT_APPLIER_ROOT_REQUIRED", "Controller-owned sandboxRoot is required for native edit application.");
  const resolvedRoot = path.resolve(sandboxRoot);
  const resolvedWorktree = path.resolve(worktree);
  if (resolvedRoot === resolvedWorktree || inside(resolvedWorktree, resolvedRoot)) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_ROOT_INSIDE_WORKTREE", "Controller edit state must be outside the assigned worktree.");
  }
  await ensureDir(resolvedRoot);
  const rootStat = await fsp.lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_ROOT_UNSAFE", "Controller edit state root must be a real directory.");
  }
  const realRoot = await fsp.realpath(resolvedRoot);
  if (path.resolve(realRoot) !== resolvedRoot) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_ROOT_UNSAFE", "Controller edit state root resolves through an alias.");
  }
  const transactionDirectory = path.join(resolvedRoot, `apply-${randomUUID()}`);
  await fsp.mkdir(transactionDirectory, { recursive: false });
  return transactionDirectory;
}

function validateWindowsTargetPath(relative) {
  for (const segment of relative.split("/")) {
    if (!segment || /[<>:"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED_BASENAME.test(segment)) {
      throw new FleetError("CONTROLLER_EDIT_WINDOWS_PATH_INVALID", `Writable target is not a canonical Windows file path: ${relative}`);
    }
  }
}

async function stageHelperRuntime(transactionDirectory) {
  const sourceExecutable = writerSandboxExecutable();
  const sourceDirectory = path.dirname(sourceExecutable);
  const stagedDirectory = path.join(transactionDirectory, "helper-runtime");
  await fsp.mkdir(stagedDirectory, { recursive: false });
  const manifest = [];
  for (const name of HELPER_RUNTIME_FILES) {
    const source = path.join(sourceDirectory, name);
    const sourceStat = await fsp.lstat(source).catch(() => null);
    if (!sourceStat?.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_UNAVAILABLE", `Native controller edit runtime file is missing or unsafe: ${name}`);
    }
    const sourceReal = await fsp.realpath(source);
    if (path.resolve(sourceReal) !== path.resolve(source)) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_UNAVAILABLE", `Native controller edit runtime resolves through an alias: ${name}`);
    }
    const bytes = await fsp.readFile(source);
    const digest = sha256(bytes);
    const destination = path.join(stagedDirectory, name);
    const handle = await fsp.open(destination, "wx", 0o500);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const destinationStat = await fsp.lstat(destination);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink() || destinationStat.nlink !== 1 || await fileSha256(destination) !== digest) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_STAGE_FAILED", `Native controller edit runtime did not stage exactly: ${name}`);
    }
    manifest.push({ name, sha256: digest, bytes: bytes.length });
  }
  return { executable: path.join(stagedDirectory, "FleetSandboxLauncher.exe"), directory: stagedDirectory, manifest };
}

async function verifyStagedRuntime(staged) {
  for (const expected of staged.manifest) {
    const file = path.join(staged.directory, expected.name);
    const stat = await fsp.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fileSha256(file) !== expected.sha256) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_CHANGED", `Staged native controller edit runtime changed during execution: ${expected.name}`);
    }
  }
}

function parseHelperResult(stdout, helperExitCode, expected) {
  if (Buffer.byteLength(stdout, "utf8") > MAX_HELPER_OUTPUT_BYTES) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_RESPONSE_BUDGET_EXCEEDED", "Native controller edit response exceeded its bounded byte budget.");
  }
  let value;
  try { value = JSON.parse(stdout); }
  catch {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_RESPONSE_INVALID", "Native controller edit helper returned malformed JSON.", {
      responseSha256: sha256(stdout),
      helperExitCode,
    });
  }
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean") {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_RESPONSE_INVALID", "Native controller edit helper returned an invalid response shape.");
  }
  if (!value.ok) {
    const code = typeof value.error?.code === "string" && /^[A-Z0-9_]{3,80}$/.test(value.error.code)
      ? value.error.code
      : "CONTROLLER_EDIT_APPLIER_FAILED";
    const message = typeof value.error?.message === "string" && value.error.message.length <= 2_000
      ? value.error.message
      : "Native controller edit transaction failed closed.";
    throw new FleetError(code, message, {
      helperExitCode,
      transaction: value.transaction ?? null,
    });
  }
  if (helperExitCode !== 0) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_EXIT_MISMATCH", "Native controller edit helper reported success with a nonzero exit.", { helperExitCode });
  }
  const transaction = value.transaction;
  if (!transaction || transaction.committed !== true || transaction.rolledBack !== false ||
      transaction.requestSha256 !== expected.requestSha256 ||
      transaction.parentHandlesPinned !== true || transaction.targetHandlesPinned !== true ||
      transaction.modelChild !== false || transaction.applierChild !== true ||
      transaction.jobAssigned !== true || transaction.jobKillOnClose !== true || transaction.jobDrained !== true ||
      transaction.timedOut !== false || transaction.canceled !== false || transaction.childExitCode !== 0 ||
      transaction.noNetwork !== true || transaction.applierImageSha256 !== expected.applierSha256 ||
      transaction.runtimeFilesPinned !== expected.runtimeFiles.size || !Array.isArray(transaction.runtimeFiles) ||
      !Array.isArray(transaction.changedFiles)) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_ATTESTATION_FAILED", "Native controller edit transaction omitted a mandatory security attestation.");
  }
  const observedRuntime = new Map();
  for (const entry of transaction.runtimeFiles) {
    if (!entry || typeof entry.name !== "string" || typeof entry.sha256 !== "string" ||
        observedRuntime.has(entry.name) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_ATTESTATION_FAILED", "Native controller edit runtime-file evidence is malformed.");
    }
    observedRuntime.set(entry.name, entry.sha256);
  }
  if (observedRuntime.size !== expected.runtimeFiles.size) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_ATTESTATION_FAILED", "Native controller edit runtime-file count mismatched the staged runtime.");
  }
  for (const [name, digest] of expected.runtimeFiles) {
    if (observedRuntime.get(name) !== digest) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_ATTESTATION_FAILED", `Native controller edit runtime hash mismatched the staged runtime: ${name}`);
    }
  }
  const observed = new Map();
  for (const entry of transaction.changedFiles) {
    if (!entry || typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_ATTESTATION_FAILED", "Native controller edit changed-file evidence is malformed.");
    }
    const relative = normalizeRelativePath(entry.path);
    if (observed.has(relative) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_ATTESTATION_FAILED", "Native controller edit changed-file evidence is duplicate or invalid.");
    }
    observed.set(relative, entry.sha256);
  }
  if (observed.size !== expected.files.size) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_ATTESTATION_FAILED", "Native controller edit changed-file count did not match the validated proposal.");
  }
  for (const [relative, desiredSha256] of expected.files) {
    if (observed.get(relative) !== desiredSha256) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_ATTESTATION_FAILED", `Native controller edit post-hash mismatched the validated proposal: ${relative}`);
    }
  }
  return transaction;
}

function runHelper({ helper, requestFile, requestSha256, cancellationFile, cwd, env, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let outputExceeded = false;
    let timedOut = false;
    let canceled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const child = spawn(helper, ["--apply-request", requestFile, requestSha256], {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const requestCancellation = (reason) => {
      if (reason === "timeout") timedOut = true;
      if (reason === "cancellation") canceled = true;
      void fsp.writeFile(cancellationFile, `${reason}\n`, { flag: "wx" }).catch(() => {});
    };
    const timer = setTimeout(() => requestCancellation("timeout"), timeoutMs);
    const onAbort = () => requestCancellation("cancellation");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const collect = (target, chunk, currentBytes, setBytes) => {
      const next = currentBytes + chunk.byteLength;
      setBytes(next);
      if (next <= MAX_HELPER_OUTPUT_BYTES) target.push(chunk);
      else if (!outputExceeded) {
        outputExceeded = true;
        requestCancellation("output-budget");
      }
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk, stdoutBytes, (value) => { stdoutBytes = value; }));
    child.stderr.on("data", (chunk) => collect(stderr, chunk, stderrBytes, (value) => { stderrBytes = value; }));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new FleetError("CONTROLLER_EDIT_APPLIER_LAUNCH_FAILED", "Native controller edit helper could not start.", { causeCode: error.code ?? error.name }));
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutBytes,
        stderrBytes,
        outputExceeded,
        timedOut,
        canceled,
      });
    });
  });
}

export async function applyControllerEdits({ packet, worktree, edits, sandboxRoot, env = process.env, signal, timeoutMs = packet?.budgets?.timeoutMs } = {}) {
  if (process.platform !== "win32") {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_PLATFORM_UNSUPPORTED", "Native controller edit application requires Windows.");
  }
  if (!Array.isArray(edits) || edits.length === 0) throw new FleetError("WORKER_NO_CHANGE", "Worker proposed no content change.");
  if (signal?.aborted) throw new FleetError("CONTROLLER_EDIT_CANCELLED", "Controller-mediated edit was canceled before native application.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new FleetError("CONTROLLER_EDIT_APPLIER_TIMEOUT_INVALID", "Native controller edit timeout must be within 1..3600000 milliseconds.");
  }
  const applyStartedMs = Date.now();
  const resolvedWorktree = path.resolve(worktree);
  const files = new Map();
  const targets = edits.map((edit) => {
    const relative = normalizeRelativePath(edit.path);
    validateWindowsTargetPath(relative);
    const baselineSha256 = packet.baselineHashes?.[relative];
    if (baselineSha256 !== "ABSENT" && !/^[a-f0-9]{64}$/i.test(baselineSha256 ?? "")) {
      throw new FleetError("CONTROLLER_EDIT_BASELINE_REQUIRED", `Allowed file has no valid baseline hash: ${relative}`);
    }
    const content = Buffer.from(edit.content, "utf8");
    const desiredSha256 = sha256(content);
    if (files.has(relative)) throw new FleetError("CONTROLLER_EDIT_RESPONSE_INVALID", `Worker proposed a duplicate file: ${relative}`);
    files.set(relative, desiredSha256);
    return {
      path: relative,
      baselineSha256: baselineSha256 === "ABSENT" ? "ABSENT" : baselineSha256.toLowerCase(),
      contentBase64: content.toString("base64"),
    };
  });
  const transactionDirectory = await createControllerDirectory(sandboxRoot, resolvedWorktree);
  const requestFile = path.join(transactionDirectory, "request.json");
  const cancellationFile = path.join(transactionDirectory, "cancel.flag");
  let staged;
  try {
    staged = await stageHelperRuntime(transactionDirectory);
  } catch (error) {
    await fsp.rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const remainingTimeoutMs = timeoutMs - (Date.now() - applyStartedMs);
  if (remainingTimeoutMs < 100) {
    await fsp.rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
    throw new FleetError("CONTROLLER_EDIT_APPLIER_TIMEOUT", "Native controller edit staging exhausted the remaining packet timeout.");
  }
  const applierSha256 = staged.manifest.find((entry) => entry.name === "FleetSandboxLauncher.exe")?.sha256;
  if (!applierSha256) {
    await fsp.rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
    throw new FleetError("CONTROLLER_EDIT_APPLIER_STAGE_FAILED", "Staged native controller edit runtime omitted the executable identity.");
  }
  const runtimeFiles = new Map(staged.manifest
    .filter((entry) => entry.name !== "FleetSandboxLauncher.exe")
    .map((entry) => [entry.name, entry.sha256]));
  const nativeTimeoutMs = Math.min(remainingTimeoutMs, 300_000);
  const request = {
    schemaVersion: 1,
    worktree: resolvedWorktree,
    cancellationFile,
    timeoutMs: nativeTimeoutMs,
    applierSha256,
    applierRuntimeSha256: Object.fromEntries(runtimeFiles),
    targets,
  };
  const serialized = `${JSON.stringify(request)}\n`;
  const requestBytes = Buffer.byteLength(serialized, "utf8");
  if (requestBytes > MAX_REQUEST_BYTES) {
    await fsp.rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
    throw new FleetError("CONTROLLER_EDIT_APPLIER_REQUEST_BUDGET_EXCEEDED", "Native controller edit request exceeded its bounded byte budget.", {
      observedBytes: requestBytes,
      limitBytes: MAX_REQUEST_BYTES,
    });
  }
  const requestSha256 = sha256(serialized);
  await atomicText(requestFile, serialized);
  try {
    const helperResult = await runHelper({ helper: staged.executable, requestFile, requestSha256, cancellationFile, cwd: staged.directory, env, signal, timeoutMs: remainingTimeoutMs });
    await verifyStagedRuntime(staged);
    if (helperResult.outputExceeded) {
      throw new FleetError("CONTROLLER_EDIT_APPLIER_RESPONSE_BUDGET_EXCEEDED", "Native controller edit helper exceeded its bounded output budget.", {
        stdoutBytes: helperResult.stdoutBytes,
        stderrBytes: helperResult.stderrBytes,
      });
    }
    let transaction;
    try {
      transaction = parseHelperResult(helperResult.stdout, helperResult.exitCode, { requestSha256, files, applierSha256, runtimeFiles });
    } catch (error) {
      if (helperResult.timedOut) throw new FleetError("CONTROLLER_EDIT_APPLIER_TIMEOUT", "Native controller edit transaction exceeded its bounded duration and rolled back.", { causeCode: error.code });
      if (helperResult.canceled) throw new FleetError("CONTROLLER_EDIT_CANCELLED", "Native controller edit transaction was canceled and rolled back.", { causeCode: error.code });
      throw error;
    }
    return {
      changedFiles: transaction.changedFiles,
      attestation: {
        ...transaction,
        helperSha256: applierSha256,
        helperRuntimeManifest: staged.manifest,
        requestBytes,
        responseStdoutBytes: helperResult.stdoutBytes,
        responseStderrBytes: helperResult.stderrBytes,
        nativeApplierLaunched: true,
        applierChildProcessLaunched: true,
        modelChildProcessLaunched: false,
      },
    };
  } finally {
    await fsp.rm(transactionDirectory, { recursive: true, force: true }).catch(() => {});
  }
}
