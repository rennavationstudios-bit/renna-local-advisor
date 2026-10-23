import fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FleetError } from "./errors.mjs";
import { pathsOverlap } from "./scope.mjs";
import { assertInside, assertResolvedInside, atomicJson, commandIdentity, ensureDir, normalizeRelativePath, runCommand, runCommandAsync, uniquePaths } from "./util.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperDirectory = path.join(repositoryRoot, "native", "FleetSandboxLauncher", "bin", "Release", "fleet-sandbox-v1");
const helperExecutable = path.join(helperDirectory, "FleetSandboxLauncher.exe");

export function writerSandboxExecutable() {
  return helperExecutable;
}

export function resolveWriterExecutable(command) {
  if (/^opencode(?:\.cmd|\.exe)?$/i.test(path.basename(command))) {
    const nativeOpenCode = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(nativeOpenCode)) return path.resolve(nativeOpenCode);
  }
  if (path.isAbsolute(command)) {
    if (!/\.exe$/i.test(command)) throw new FleetError("WRITER_SANDBOX_EXECUTABLE_UNSUPPORTED", "Sandboxed worker executable must be a native .exe path.");
    return command;
  }
  if (/\.(?:cmd|bat)$/i.test(command)) {
    throw new FleetError("WRITER_SANDBOX_EXECUTABLE_UNSUPPORTED", "Command shims cannot be safely quoted by the writer sandbox; configure the underlying executable.");
  }
  const where = runCommand([path.join(process.env.SystemRoot ?? "/SETUP_REQUIRED/path-5", "System32", "where.exe"), command], { timeoutMs: 10_000 });
  const match = where.exitCode === 0
    ? where.stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => /\.exe$/i.test(value))
    : null;
  if (!match) throw new FleetError("WRITER_SANDBOX_EXECUTABLE_NOT_FOUND", `Sandbox worker executable was not found: ${command}`);
  return path.resolve(match);
}

function resolveCommandShim(command) {
  if (path.isAbsolute(command)) return path.resolve(command);
  const where = runCommand([path.join(process.env.SystemRoot ?? "/SETUP_REQUIRED/path-5", "System32", "where.exe"), command], { timeoutMs: 10_000 });
  if (where.exitCode !== 0) return null;
  return where.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => /\.cmd$/i.test(value)) ?? null;
}

export function resolveWriterCommand(argv) {
  const base = path.basename(argv[0]).toLowerCase();
  if (["npm", "npm.cmd", "npx", "npx.cmd"].includes(base)) {
    const shim = resolveCommandShim(argv[0]);
    if (!shim || !existsSync(shim)) {
      throw new FleetError("WRITER_SANDBOX_EXECUTABLE_NOT_FOUND", `Package-manager shim was not found: ${argv[0]}`);
    }
    const directory = path.dirname(shim);
    const executable = path.join(directory, "node.exe");
    const cli = path.join(directory, "node_modules", "npm", "bin", base.startsWith("npx") ? "npx-cli.js" : "npm-cli.js");
    if (!existsSync(executable) || !existsSync(cli)) {
      throw new FleetError("WRITER_SANDBOX_EXECUTABLE_NOT_FOUND", `Package-manager native entrypoint was not found for ${argv[0]}`);
    }
    return { executable: path.resolve(executable), arguments: [path.resolve(cli), ...argv.slice(1)] };
  }
  return { executable: resolveWriterExecutable(argv[0]), arguments: argv.slice(1) };
}

export function commandCompatibilityEnvironment(argv) {
  if (!Array.isArray(argv) || argv.length < 3 || argv.length > 66) return {};
  const executable = path.basename(argv[0]).toLowerCase();
  if (!["node", "node.exe"].includes(executable) || argv[1] !== "--test") return {};
  for (const testFile of argv.slice(2)) {
    if (!testFile || path.isAbsolute(testFile) || testFile.startsWith("-") || /[*?\[\]]/.test(testFile)) return {};
    const rendered = String(testFile).replaceAll("\\", "/");
    if (rendered.split("/").includes("..")) return {};
    let normalized;
    try { normalized = normalizeRelativePath(rendered); }
    catch { return {}; }
    if (normalized !== rendered || !/\.(?:[cm]?js|[cm]?ts)$/i.test(normalized)) return {};
  }
  // Node's child-process test IPC stalls in the restricted AppContainer.
  // Only explicit normalized file lists get the existing single-process mode;
  // OS containment, parent-approved argv and command deadlines remain intact.
  return { NODE_OPTIONS: "--test-isolation=none" };
}

function parseHelperResult(stdout, networkIsolationMode, expectedWorktree) {
  let value;
  try { value = JSON.parse(stdout); }
  catch (error) {
    throw new FleetError("WRITER_SANDBOX_RESPONSE_INVALID", "Windows sandbox helper returned malformed JSON.", { cause: error.message });
  }
  if (!value || typeof value !== "object" || typeof value.ok !== "boolean") {
    throw new FleetError("WRITER_SANDBOX_RESPONSE_INVALID", "Windows sandbox helper response has an invalid shape.");
  }
  if (!value.ok) {
    const code = typeof value.error?.code === "string" ? value.error.code : "WRITER_SANDBOX_FAILED";
    throw new FleetError(code, value.error?.message ?? "Windows writer sandbox failed closed.", {
      win32Error: value.error?.win32Error ?? null,
    });
  }
  const attestation = value.attestation;
  const expectedScratchEnvironment = [
    "TEMP", "TMP", "TMPDIR", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
    "BUN_INSTALL_CACHE_DIR", "NPM_CONFIG_CACHE",
  ];
  const required = attestation?.jobKillOnClose === true &&
    attestation?.jobAssigned === true &&
    attestation?.jobDrained === true &&
    attestation?.restrictingSidOnJobDacl === true &&
    attestation?.privateDesktop === true &&
    attestation?.inheritedHandleAllowlist === true &&
    attestation?.inheritedHandleCount === 3 &&
    attestation?.workingDirectoryInsideWorktree === true &&
    Array.isArray(attestation?.compatibilityRestrictingSids) &&
    attestation.compatibilityRestrictingSids.length === 0 &&
    expectedScratchEnvironment.every((name) => attestation?.runtimeScratchEnvironmentVariables?.includes(name)) &&
    attestation?.reparseChecksPassed === true &&
    attestation?.hardlinkChecksPassed === true &&
    attestation?.aclsRestored === true &&
    attestation?.runtimeScratchDistinct === true &&
    attestation?.runtimeScratchRemoved === true &&
    attestation?.stagedExecutableRemoved === true;
  if (!required) throw new FleetError("WRITER_SANDBOX_ATTESTATION_FAILED", "Windows writer sandbox did not attest every mandatory containment gate.");
  if (networkIsolationMode === "none" && !(
    attestation?.writeRestricted === true &&
    attestation?.disableMaxPrivilege === true &&
    attestation?.restrictingSidInDefaultDacl === true &&
    attestation?.restrictedTokenAppliedToChild === true &&
    attestation?.childTokenRestricted === true &&
    attestation?.childIsAppContainer === false
  )) throw new FleetError("WRITER_SANDBOX_ATTESTATION_FAILED", "Normal writer child did not attest its restricted token.");
  if (attestation?.networkIsolationMode !== networkIsolationMode) {
    throw new FleetError("WRITER_SANDBOX_ATTESTATION_FAILED", "Windows writer sandbox did not attest the requested network isolation mode.");
  }
  if (networkIsolationMode !== "none" && (
    typeof attestation?.appContainerProfile !== "string" ||
    typeof attestation?.appContainerPackageSid !== "string" ||
    !Array.isArray(attestation?.appContainerCapabilities) ||
    !attestation.appContainerCapabilities.includes("privateNetworkClientServer") ||
    (networkIsolationMode === "supervised" && !attestation.appContainerCapabilities.includes("internetClient")) ||
    attestation?.restrictedTokenAppliedToChild !== true ||
    attestation?.childTokenRestricted !== true ||
    attestation?.childIsAppContainer !== true ||
    attestation?.childCapabilitiesMatch !== true ||
    attestation?.childAppContainerSid !== attestation?.appContainerPackageSid
  )) throw new FleetError("WRITER_SANDBOX_ATTESTATION_FAILED", "AppContainer sandbox did not attest the required package identity and capabilities.");
  if (networkIsolationMode !== "none") {
    const worktree = typeof attestation?.worktree === "string" ? path.resolve(attestation.worktree) : null;
    if (worktree?.toLowerCase() !== expectedWorktree.toLowerCase()) {
      throw new FleetError("WRITER_SANDBOX_ATTESTATION_FAILED", "AppContainer attested a different worktree than the controller requested.");
    }
    const expectedAncestors = worktree ? deriveAppContainerAncestorPaths(worktree) : null;
    if (!expectedAncestors ||
      !Array.isArray(attestation?.appContainerAncestorPaths) ||
      !Array.isArray(attestation?.appContainerGrantedAncestorPaths) ||
      JSON.stringify(attestation.appContainerAncestorPaths) !== JSON.stringify(expectedAncestors) ||
      attestation?.appContainerAncestorMask !== "0x001000A0" ||
      attestation?.appContainerAncestorNonInherited !== true ||
      attestation?.appContainerAncestorIdentityPinned !== true ||
      attestation?.appContainerAncestorAclsRestored !== true ||
      attestation?.appContainerAncestorMutexName !== "Global\\LocalAIFleetAppContainerAncestorAcl-v1" ||
      attestation?.appContainerAncestorMutexAcquired !== true ||
      typeof attestation?.appContainerAncestorMutexWaitMs !== "number" ||
      attestation.appContainerAncestorMutexWaitMs < 0 ||
      attestation.appContainerGrantedAncestorPaths.some((value) => !expectedAncestors.includes(value))
    ) throw new FleetError("WRITER_SANDBOX_ATTESTATION_FAILED", "AppContainer ancestor traversal ACL evidence was absent or mismatched.");
  }
  if (networkIsolationMode !== "none" && attestation?.sterileEnvironment !== true) {
    throw new FleetError("WRITER_SANDBOX_ATTESTATION_FAILED", "AppContainer sandbox did not attest its sterile environment.");
  }
  return value;
}

function deriveAppContainerAncestorPaths(worktree) {
  if (worktree.startsWith("\\\\") || worktree.startsWith("\\\\?\\")) return null;
  const root = path.parse(worktree).root;
  if (!root || root === worktree) return null;
  const parents = [];
  let current = path.dirname(worktree);
  while (current && current.toLowerCase() !== root.toLowerCase()) {
    parents.push(current);
    const next = path.dirname(current);
    if (next === current) return null;
    current = next;
  }
  if (!current) return null;
  parents.push(root);
  return parents;
}

export async function runWriterSandbox({ argv, packet, worktree, cwd = worktree, sandboxRoot, input = undefined, env = process.env, environment = {}, signal, networkIsolationMode = "none", readOnlyPaths = [], externalReadOnlyPaths = [] } = {}) {
  if (process.platform !== "win32") {
    throw new FleetError("WRITER_SANDBOX_PLATFORM_UNSUPPORTED", "Live writer adapters require the Windows restricted-token sandbox.");
  }
  if (!Array.isArray(argv) || !argv.length || argv.some((value) => typeof value !== "string")) {
    throw new FleetError("INVALID_COMMAND", "Sandbox commands must be a non-empty argv string array.");
  }
  if (!sandboxRoot) throw new FleetError("WRITER_SANDBOX_ROOT_REQUIRED", "Controller-owned sandboxRoot is required.");
  if (!["none", "offline", "supervised"].includes(networkIsolationMode)) {
    throw new FleetError("WRITER_SANDBOX_NETWORK_ISOLATION_MODE_INVALID", "networkIsolationMode must be none, offline, or supervised.");
  }
  if (!Array.isArray(readOnlyPaths) || readOnlyPaths.some((value) => typeof value !== "string" || !value || path.isAbsolute(value))) {
    throw new FleetError("WRITER_SANDBOX_READONLY_PATH_INVALID", "readOnlyPaths must be non-empty relative paths.");
  }
  if (!Array.isArray(externalReadOnlyPaths) || externalReadOnlyPaths.some((value) => typeof value !== "string" || !path.isAbsolute(value))) {
    throw new FleetError("WRITER_SANDBOX_EXTERNAL_READONLY_PATH_INVALID", "externalReadOnlyPaths must be non-empty absolute paths.");
  }
  if (!environment || typeof environment !== "object" || Array.isArray(environment) || Object.entries(environment).some(([key, value]) => !key || typeof value !== "string")) {
    throw new FleetError("WRITER_SANDBOX_ENVIRONMENT_INVALID", "environment must be a string-only override object.");
  }
  if (signal?.aborted) throw new FleetError("WRITER_SANDBOX_CANCELLED", "Writer sandbox was canceled before launch.");
  const resolvedWorktree = path.resolve(worktree);
  const resolvedWorkingDirectory = await assertResolvedInside(resolvedWorktree, path.resolve(cwd));
  const resolvedReadOnlyPaths = [];
  const normalizedReadOnlyPaths = [...new Set(readOnlyPaths.map((value) => value === "." ? "." : normalizeRelativePath(value)))].sort();
  for (const declaredPath of normalizedReadOnlyPaths) {
    resolvedReadOnlyPaths.push(await assertResolvedInside(resolvedWorktree, declaredPath === "." ? resolvedWorktree : path.resolve(resolvedWorktree, declaredPath)));
  }
  const resolvedExternalReadOnlyPaths = [];
  for (const declaredPath of [...new Set(externalReadOnlyPaths.map((value) => path.resolve(value)))]) {
    const absolute = path.resolve(declaredPath);
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new FleetError("WRITER_SANDBOX_EXTERNAL_READONLY_PATH_INVALID", "externalReadOnlyPaths must name regular files or directories.");
    const real = await fsp.realpath(absolute);
    if (path.resolve(real) !== absolute) throw new FleetError("WRITER_SANDBOX_EXTERNAL_READONLY_REPARSE", `externalReadOnlyPath resolves through an alias: ${absolute}`);
    resolvedExternalReadOnlyPaths.push(absolute);
  }
  const resolvedSandboxRoot = path.resolve(sandboxRoot);
  try { assertInside(resolvedWorktree, resolvedSandboxRoot); }
  catch {
    // Expected: controller/runtime scratch must be distinct from worker files.
  }
  if (resolvedSandboxRoot === resolvedWorktree || resolvedSandboxRoot.startsWith(`${resolvedWorktree}${path.sep}`)) {
    throw new FleetError("WRITER_SANDBOX_ROOT_INSIDE_WORKTREE", "Controller sandbox state must be outside the worktree.");
  }
  try { await fsp.access(helperExecutable); }
  catch {
    throw new FleetError("WRITER_SANDBOX_UNAVAILABLE", `Built Windows sandbox helper is missing: ${helperExecutable}`);
  }

  const command = resolveWriterCommand(argv);
  const appContainerArguments = networkIsolationMode === "none" ? command.arguments : command.arguments.map((value) => {
    if (!path.isAbsolute(value)) return value;
    const relative = path.relative(resolvedWorktree, value);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) ? relative : value;
  });
  const artifactsOutsideWriteScope = packet.kind === "edit"
    ? (packet.expectedArtifacts ?? []).filter(
        (artifact) => !(packet.allowedFiles ?? []).some((allowed) => pathsOverlap(artifact, allowed)),
      )
    : [];
  if (artifactsOutsideWriteScope.length) {
    throw new FleetError(
      "ARTIFACT_SCOPE_CONFLICT",
      `Expected artifacts must be inside allowedFiles: ${artifactsOutsideWriteScope.join(", ")}`,
    );
  }
  const writableFiles = uniquePaths(packet.allowedFiles ?? []);
  const controllerRoot = path.join(resolvedSandboxRoot, "controller");
  const runtimeScratch = path.join(resolvedSandboxRoot, `runtime-${randomUUID()}`);
  const requestFile = path.join(controllerRoot, "request.json");
  const cancellationFile = path.join(controllerRoot, `cancel-${randomUUID()}.flag`);
  const attestationFile = path.join(resolvedSandboxRoot, "attestation.json");
  await ensureDir(controllerRoot);
  const request = {
    schemaVersion: 1,
    worktree: resolvedWorktree,
    workingDirectory: resolvedWorkingDirectory,
    scratchRoot: runtimeScratch,
    executable: command.executable,
    arguments: appContainerArguments,
    writableFiles,
    readOnlyPaths: resolvedReadOnlyPaths.map((value) => value === resolvedWorktree ? "." : path.relative(resolvedWorktree, value).replaceAll("\\", "/")),
    externalReadOnlyPaths: resolvedExternalReadOnlyPaths,
    networkIsolationMode,
    environment,
    input: input === undefined ? null : String(input),
    timeoutMs: packet.budgets.timeoutMs,
    cancellationFile,
  };
  await atomicJson(requestFile, request);
  const onAbort = () => { void fsp.writeFile(cancellationFile, "cancel\n", { flag: "wx" }).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const helper = await runCommandAsync([helperExecutable, "--request", requestFile], {
      cwd: repositoryRoot,
      timeoutMs: packet.budgets.timeoutMs + 30_000,
      env,
    });
    if (helper.timedOut) throw new FleetError("WRITER_SANDBOX_HELPER_TIMEOUT", "Windows sandbox helper exceeded the worker timeout grace period.");
    const parsed = parseHelperResult(helper.stdout, networkIsolationMode, resolvedWorktree);
    await atomicJson(attestationFile, parsed.attestation);
    return {
      workerExit: {
        argv,
        cwd: resolvedWorktree,
        commandIdentity: commandIdentity(argv),
        startedAt: parsed.worker.startedAt,
        finishedAt: parsed.worker.finishedAt,
        exitCode: parsed.worker.exitCode,
        nativeExitCode: parsed.worker.nativeExitCode,
        signal: null,
        timedOut: parsed.worker.timedOut,
        canceled: parsed.worker.canceled,
        stdout: parsed.worker.stdout ?? "",
        stderr: parsed.worker.stderr ?? "",
      },
      attestation: { ...parsed.attestation, evidenceFile: attestationFile },
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await fsp.rm(cancellationFile, { force: true }).catch(() => {});
    await fsp.rm(requestFile, { force: true }).catch(() => {});
    await fsp.rmdir(controllerRoot).catch(() => {});
  }
}
