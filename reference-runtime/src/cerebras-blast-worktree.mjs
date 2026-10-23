import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { readStableRegularFile } from "./bounded-local-file.mjs";
import { assertCerebrasSourceContentAllowed } from "./cerebras-fast.mjs";
import { FleetError } from "./errors.mjs";
import {
  assertInside,
  assertNoSecretValues,
  assertResolvedInside,
  ensureDir,
  normalizeRelativePath,
  runCommand,
  sha256,
  stableJson,
  uniquePaths,
} from "./util.mjs";
import { commandCompatibilityEnvironment, runWriterSandbox } from "./writer-sandbox.mjs";

export const CEREBRAS_BLAST_MAX_SOURCE_FILES = 64;
export const CEREBRAS_BLAST_MAX_SOURCE_FILE_BYTES = 160 * 1024;
export const CEREBRAS_BLAST_MAX_SOURCE_BYTES = 768 * 1024;
export const CEREBRAS_BLAST_MAX_PATCH_BYTES = 256 * 1024;
export const CEREBRAS_BLAST_MAX_TEST_COMMANDS = 12;
export const CEREBRAS_BLAST_MAX_TEST_TIMEOUT_MS = 10 * 60 * 1_000;

const repositoryGitTails = new Map();
let sandboxTail = Promise.resolve();
const DENIED_SEGMENT = new Set([
  ".git", ".ssh", ".aws", ".azure", ".gnupg", "credentials", "secrets",
  "node_modules", ".next", "dist", "build", "coverage", "customer-data",
  "production-data", "browser", "user data",
]);
const DENIED_FILE = /(?:^|\/)(?:remote-machines\.env|id_(?:rsa|ecdsa|ed25519)|(?:client|customer|production|regulated)[-_ ](?:data|records?|dump|export)(?:\.[^/]*)?|.*\.(?:pem|p12|pfx|key|crt|cer))$/iu;
const DANGEROUS_PATCH_LINE = /^(?:GIT binary patch|Binary files |rename (?:from|to) |copy (?:from|to) |similarity index |dissimilarity index |(?:old|new) mode [0-7]{6}|index [0-9a-f]+\.\.[0-9a-f]+ (?:120000|160000))/mu;
const GIT_FILE_MODE_LINE = /^(?:new|deleted) file mode /u;
const SAFE_GIT_FILE_MODE_LINE = /^(?:new|deleted) file mode 100644$/u;
const BARE_HUNK_HEADER = /^@@[ \t]*$/u;
const COUNTED_HUNK_HEADER = /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@(?: .*)?$/u;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";
const PROVIDER_END_OF_FILE_MARKER = "*** End of File ***";
const CEREBRAS_BLAST_CANONICALIZATION_VERSION = 1;
const CEREBRAS_BLAST_MAX_CANONICAL_HUNKS = 128;
const CEREBRAS_BLAST_MAX_CANONICAL_LINE_COMPARISONS = 1_000_000;
const CEREBRAS_BLAST_STRUCTURED_EDIT_FORMAT = "cerebras-structured-edits";
const CEREBRAS_BLAST_MAX_STRUCTURED_EDITS = 128;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const TEST_EXECUTABLES = new Set([
  "node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd", "pnpm", "pnpm.cmd",
  "yarn", "yarn.cmd", "python", "python.exe", "py", "py.exe", "pytest", "pytest.exe",
  "cargo", "cargo.exe", "dotnet", "dotnet.exe", "go", "go.exe",
]);
const DANGEROUS_TEST_TOKEN = /(?:^|[-_:])(?:deploy|publish|release|submit|upload|install|uninstall|add|remove|delete|destroy|migrate|migration|seed|production|prod)(?:$|[-_:])/iu;
const SECRET_ENV_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|AUTH|BEARER|PRIVATE|CERT|CEREBRAS|OPENAI|ANTHROPIC|AWS_|AZURE_|GOOGLE_|GITHUB_|NPM_CONFIG_USERCONFIG|NODE_TEST_CONTEXT)/iu;
const DANGEROUS_GIT_ENV_KEY = /^GIT_(?:CONFIG|DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|EXEC_PATH|TEMPLATE_DIR|ATTR_NOSYSTEM|SSH|ASKPASS)/iu;
const CONTROLLER_GIT_ENV_KEYS = ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP"];

function worktreeError(code, message, details = {}) {
  return new FleetError(code, message, details);
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function assertPlainCanonicalDirectory(directory, label, containmentRoot = null) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw worktreeError("CEREBRAS_BLAST_CONTROLLER_ROOT_INVALID", `${label} must be an absolute controller-owned directory.`);
  }
  const lexical = path.resolve(directory);
  let stat;
  try {
    stat = await fsp.lstat(lexical);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw worktreeError("CEREBRAS_BLAST_CONTROLLER_ROOT_MISSING", `${label} does not exist.`);
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw worktreeError("CEREBRAS_BLAST_CONTROLLER_ROOT_INVALID", `${label} must be a plain directory, not a link or reparse alias.`);
  }
  const real = await fsp.realpath(lexical);
  if (comparable(real) !== comparable(lexical)) {
    throw worktreeError("CEREBRAS_BLAST_CONTROLLER_ROOT_INVALID", `${label} resolves through an alias or reparse point.`);
  }
  if (containmentRoot) assertInside(path.resolve(containmentRoot), real);
  return lexical;
}

function pathContainsOrEquals(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertSeparatedBlastExecutionRoot({ stateRoot, executionRoot }) {
  if (typeof executionRoot !== "string" || !path.isAbsolute(executionRoot)) {
    throw worktreeError("CEREBRAS_BLAST_EXECUTION_ROOT_INVALID", "Blast execution root must be an absolute host-owned directory.");
  }
  const lexical = path.resolve(executionRoot);
  if (process.platform === "win32" && (lexical.startsWith("\\\\") || lexical.startsWith("\\\\?\\"))) {
    throw worktreeError("CEREBRAS_BLAST_EXECUTION_ROOT_INVALID", "Blast execution root must be on a local Windows volume.");
  }
  const execution = await assertPlainCanonicalDirectory(lexical, "Blast execution root");
  if (pathContainsOrEquals(stateRoot, execution) || pathContainsOrEquals(execution, stateRoot)) {
    throw worktreeError(
      "CEREBRAS_BLAST_CONTROLLER_ROOT_OVERLAP",
      "Blast evidence state and disposable execution roots must be disjoint.",
    );
  }
  return execution;
}

async function assertBlastControllerRootLayout({ stateRoot, executionRoot, workspaceRoot, requiresExecution }) {
  const state = await assertPlainCanonicalDirectory(stateRoot, "Blast state root");
  const workspace = await assertPlainCanonicalDirectory(workspaceRoot, "Blast caller workspace");
  if (pathContainsOrEquals(state, workspace) || pathContainsOrEquals(workspace, state)) {
    throw worktreeError(
      "CEREBRAS_BLAST_CONTROLLER_ROOT_OVERLAP",
      "Blast evidence state and caller workspace roots must be disjoint.",
    );
  }
  const execution = requiresExecution
    ? await assertSeparatedBlastExecutionRoot({ stateRoot: state, executionRoot })
    : null;
  if (execution && (pathContainsOrEquals(execution, workspace) || pathContainsOrEquals(workspace, execution))) {
    throw worktreeError(
      "CEREBRAS_BLAST_CONTROLLER_ROOT_OVERLAP",
      "Blast disposable execution and caller workspace roots must be disjoint.",
    );
  }
  return { stateRoot: state, executionRoot: execution, workspaceRoot: workspace };
}

async function ensurePlainControllerChild(parent, name, { exclusive = false, label = "Blast controller directory" } = {}) {
  const root = await assertPlainCanonicalDirectory(parent, `${label} parent`);
  if (typeof name !== "string" || !name || name !== path.basename(name) || /[\\/:]/u.test(name)) {
    throw worktreeError("CEREBRAS_BLAST_CONTROLLER_ROOT_INVALID", `${label} name is invalid.`);
  }
  const target = assertInside(root, path.join(root, name));
  try {
    await fsp.mkdir(target);
  } catch (error) {
    if (error?.code !== "EEXIST" || exclusive) {
      if (error?.code === "EEXIST" && exclusive) {
        throw worktreeError("CEREBRAS_BLAST_RUN_EXISTS", `${label} already exists.`);
      }
      throw error;
    }
  }
  return assertPlainCanonicalDirectory(target, label, root);
}

function controllerEntryIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs ?? "0"),
  });
}

function sameControllerEntryIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && (left.ino !== "0" || left.birthtimeNs === right.birthtimeNs);
}

async function bindControllerArtifactDirectory(directory, label) {
  const root = await assertPlainCanonicalDirectory(directory, label);
  const stat = await fsp.lstat(root, { bigint: true });
  return Object.freeze({ root, label, identity: controllerEntryIdentity(stat) });
}

async function verifyControllerArtifactDirectory(binding) {
  const root = await assertPlainCanonicalDirectory(binding.root, binding.label);
  const stat = await fsp.lstat(root, { bigint: true });
  if (!sameControllerEntryIdentity(binding.identity, controllerEntryIdentity(stat))) {
    throw worktreeError("CEREBRAS_BLAST_CONTROLLER_ROOT_REPLACED", `${binding.label} changed identity during the Blast run.`);
  }
  return root;
}

function controllerArtifactTarget(binding, name) {
  if (typeof name !== "string"
    || !name
    || name !== path.basename(name)
    || /[\\/:<>"|?*\u0000-\u001F]/u.test(name)
    || /[. ]$/u.test(name)
    || WINDOWS_RESERVED_SEGMENT.test(name)) {
    throw worktreeError("CEREBRAS_BLAST_ARTIFACT_PATH_INVALID", "Blast artifact names must be direct, Windows-safe filenames.");
  }
  return assertInside(binding.root, path.join(binding.root, name));
}

async function inspectControllerArtifactFile(target, { allowMissing = false, expectedIdentity = null } = {}) {
  let stat;
  try {
    stat = await fsp.lstat(target, { bigint: true });
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw worktreeError("CEREBRAS_BLAST_ARTIFACT_PATH_UNSAFE", "Blast artifact targets must be single-link regular files.");
  }
  const real = await fsp.realpath(target);
  if (comparable(real) !== comparable(target)) {
    throw worktreeError("CEREBRAS_BLAST_ARTIFACT_PATH_UNSAFE", "Blast artifact targets may not resolve through aliases or reparse points.");
  }
  const identity = controllerEntryIdentity(stat);
  if (expectedIdentity && !sameControllerEntryIdentity(expectedIdentity, identity)) {
    throw worktreeError("CEREBRAS_BLAST_ARTIFACT_PATH_REPLACED", "Blast artifact identity changed during an atomic write.");
  }
  return { identity, size: Number(stat.size) };
}

async function cleanupControllerArtifactTemporary(binding, target, identity) {
  try {
    await verifyControllerArtifactDirectory(binding);
    await inspectControllerArtifactFile(target, { expectedIdentity: identity });
    await fsp.unlink(target);
  } catch {
    // Fail closed without reopening or deleting an unverified pathname.
  }
}

export async function createBlastControllerArtifactWriter(directory, { label = "Blast artifact root" } = {}) {
  const binding = await bindControllerArtifactDirectory(directory, label);
  const tails = new Map();

  const serialize = async (name, callback) => {
    const previous = tails.get(name) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    tails.set(name, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (tails.get(name) === current) tails.delete(name);
    }
  };

  const writeTextUnlocked = async (name, value) => {
    const target = controllerArtifactTarget(binding, name);
    await verifyControllerArtifactDirectory(binding);
    await inspectControllerArtifactFile(target, { allowMissing: true });
    const temporaryName = `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const temporary = controllerArtifactTarget(binding, temporaryName);
    let handle;
    let temporaryIdentity = null;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n) {
        throw worktreeError("CEREBRAS_BLAST_ARTIFACT_PATH_UNSAFE", "Blast artifact temporary must be a single-link regular file.");
      }
      temporaryIdentity = controllerEntryIdentity(opened);
      await handle.writeFile(String(value), "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await verifyControllerArtifactDirectory(binding);
      await inspectControllerArtifactFile(temporary, { expectedIdentity: temporaryIdentity });
      await inspectControllerArtifactFile(target, { allowMissing: true });
      await verifyControllerArtifactDirectory(binding);
      await fsp.rename(temporary, target);
      await verifyControllerArtifactDirectory(binding);
      await inspectControllerArtifactFile(target, { expectedIdentity: temporaryIdentity });
      temporaryIdentity = null;
      return target;
    } finally {
      await handle?.close().catch(() => {});
      if (temporaryIdentity) await cleanupControllerArtifactTemporary(binding, temporary, temporaryIdentity);
    }
  };

  const readTextUnlocked = async (name, { maximumBytes = 4 * 1024 * 1024 } = {}) => {
    const target = controllerArtifactTarget(binding, name);
    await verifyControllerArtifactDirectory(binding);
    const inspected = await inspectControllerArtifactFile(target, { allowMissing: true });
    if (!inspected) return "";
    const snapshot = await readStableRegularFile(target, { maximumBytes, requireSingleLink: true });
    if (comparable(snapshot.realPath) !== comparable(target)) {
      throw worktreeError("CEREBRAS_BLAST_ARTIFACT_PATH_UNSAFE", "Blast artifact reads may not resolve through aliases or reparse points.");
    }
    await verifyControllerArtifactDirectory(binding);
    await inspectControllerArtifactFile(target, { expectedIdentity: inspected.identity });
    return snapshot.bytes.toString("utf8");
  };

  return Object.freeze({
    root: binding.root,
    readText(name, options = {}) {
      return serialize(name, () => readTextUnlocked(name, options));
    },
    async readJson(name, options = {}) {
      const text = await serialize(name, () => readTextUnlocked(name, options));
      return JSON.parse(text);
    },
    text(name, value) {
      return serialize(name, () => writeTextUnlocked(name, value));
    },
    json(name, value) {
      return serialize(name, () => writeTextUnlocked(name, `${JSON.stringify(value, null, 2)}\n`));
    },
    appendJsonl(name, value) {
      return serialize(name, async () => {
        const current = await readTextUnlocked(name);
        return writeTextUnlocked(name, `${current}${JSON.stringify(value)}\n`);
      });
    },
  });
}

export async function prepareBlastControllerRun({ stateRoot, executionRoot = null, workspaceRoot, blastId, workerIds = [], requiresExecution = true }) {
  const roots = await assertBlastControllerRootLayout({ stateRoot, executionRoot, workspaceRoot, requiresExecution });
  const state = roots.stateRoot;
  const execution = roots.executionRoot;
  const runsRoot = await ensurePlainControllerChild(state, "blast-runs", { label: "Blast runs root" });
  const circuitRoot = await ensurePlainControllerChild(state, "blast-circuit", { label: "Blast circuit root" });
  const runRoot = await ensurePlainControllerChild(runsRoot, blastId, { exclusive: true, label: "Blast run root" });
  const workersRoot = await ensurePlainControllerChild(runRoot, "workers", { exclusive: true, label: "Blast workers root" });
  const workerRoots = {};
  for (const workerId of workerIds) {
    workerRoots[workerId] = await ensurePlainControllerChild(workersRoot, workerId, { exclusive: true, label: `Blast worker root ${workerId}` });
  }
  let executionRunsRoot = null;
  let executionRunRoot = null;
  let worktreesRoot = null;
  let sandboxesRoot = null;
  const sandboxWorkerRoots = {};
  if (requiresExecution) {
    executionRunsRoot = await ensurePlainControllerChild(execution, "blast-runs", { label: "Blast execution runs root" });
    executionRunRoot = await ensurePlainControllerChild(executionRunsRoot, blastId, { exclusive: true, label: "Blast execution run root" });
    worktreesRoot = await ensurePlainControllerChild(executionRunRoot, "worktrees", { exclusive: true, label: "Blast worktrees root" });
    sandboxesRoot = await ensurePlainControllerChild(executionRunRoot, "sandboxes", { exclusive: true, label: "Blast sandboxes root" });
    for (const workerId of workerIds) {
      sandboxWorkerRoots[workerId] = await ensurePlainControllerChild(sandboxesRoot, workerId, { exclusive: true, label: `Blast sandbox worker root ${workerId}` });
    }
  }
  const artifactWriter = await createBlastControllerArtifactWriter(runRoot, { label: "Blast run artifact root" });
  const workerArtifactWriters = {};
  for (const workerId of workerIds) {
    workerArtifactWriters[workerId] = await createBlastControllerArtifactWriter(workerRoots[workerId], {
      label: `Blast worker artifact root ${workerId}`,
    });
  }
  return {
    stateRoot: state,
    executionRoot: execution,
    workspaceRoot: roots.workspaceRoot,
    circuitRoot,
    runRoot,
    workersRoot,
    executionRunsRoot,
    executionRunRoot,
    worktreesRoot,
    sandboxesRoot,
    workerRoots,
    sandboxWorkerRoots,
    artifactWriter,
    workerArtifactWriters,
  };
}

export async function resolveBlastControllerRun({ stateRoot, blastId }) {
  const state = await assertPlainCanonicalDirectory(stateRoot, "Blast state root");
  const runsRoot = await assertPlainCanonicalDirectory(path.join(state, "blast-runs"), "Blast runs root", state);
  const circuitRoot = await assertPlainCanonicalDirectory(path.join(state, "blast-circuit"), "Blast circuit root", state);
  const runRoot = await assertPlainCanonicalDirectory(path.join(runsRoot, blastId), "Blast run root", runsRoot);
  const artifactWriter = await createBlastControllerArtifactWriter(runRoot, { label: "Blast run artifact root" });
  return { stateRoot: state, circuitRoot, runRoot, artifactWriter };
}

async function withRepositoryGitLock(repository, callback) {
  const key = comparable(repository);
  const previous = repositoryGitTails.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  repositoryGitTails.set(key, current);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (repositoryGitTails.get(key) === current) repositoryGitTails.delete(key);
  }
}

async function withBlastSandboxLock(callback) {
  const previous = sandboxTail;
  let release;
  sandboxTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function controllerGitEnvironment() {
  const environment = {};
  for (const key of CONTROLLER_GIT_ENV_KEYS) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.LC_ALL = "C";
  return environment;
}

function gitResult(repository, args, options = {}) {
  const { hooksPath, ...commandOptions } = options;
  const controllerOptions = [
    "--no-optional-locks",
    "-c", "credential.helper=",
    "-c", "core.askPass=",
    "-c", "core.fsmonitor=false",
    "-c", "core.autocrlf=false",
    "-c", "core.safecrlf=false",
    ...(hooksPath ? ["-c", `core.hooksPath=${hooksPath}`] : []),
  ];
  return runCommand(["git", ...controllerOptions, "-C", repository, ...args], {
    ...commandOptions,
    env: controllerGitEnvironment(),
  });
}

function git(repository, args, options = {}) {
  const result = gitResult(repository, args, options);
  if (result.exitCode !== 0) {
    throw worktreeError("CEREBRAS_BLAST_GIT_FAILED", `Git command failed: ${args.join(" ")}.`, {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 4_000),
    });
  }
  return result;
}

function assertSourcePathAllowed(relative) {
  const normalized = normalizeRelativePath(relative);
  const lower = normalized.toLowerCase();
  const segments = lower.split("/");
  if (segments.some((segment) => /[<>:"|?*\u0000-\u001F]/u.test(segment) || /[. ]$/u.test(segment) || WINDOWS_RESERVED_SEGMENT.test(segment))) {
    throw worktreeError("CEREBRAS_BLAST_SOURCE_PATH_DENIED", `Blast source path is not a Git-representable Windows-safe path: ${normalized}.`);
  }
  if (segments.some((segment) => DENIED_SEGMENT.has(segment))) {
    throw worktreeError("CEREBRAS_BLAST_SOURCE_PATH_DENIED", `Blast source path is denied: ${normalized}.`);
  }
  const basename = segments.at(-1);
  const environmentFile = basename.endsWith(".env")
    || (basename.startsWith(".env.") && basename !== ".env.example");
  if (environmentFile || DENIED_FILE.test(lower)) {
    throw worktreeError("CEREBRAS_BLAST_SOURCE_PATH_DENIED", `Blast source path is denied: ${normalized}.`);
  }
  return normalized;
}

export function normalizeBlastSourcePaths(values = []) {
  if (!Array.isArray(values)) throw worktreeError("CEREBRAS_BLAST_ARGUMENT_INVALID", "Source paths must be an array.");
  const normalized = uniquePaths(values.map(assertSourcePathAllowed));
  if (normalized.length > CEREBRAS_BLAST_MAX_SOURCE_FILES) {
    throw worktreeError("CEREBRAS_BLAST_SOURCE_LIMIT", `Blast accepts at most ${CEREBRAS_BLAST_MAX_SOURCE_FILES} explicit source files.`);
  }
  return normalized;
}

export async function assertBlastRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw worktreeError("CEREBRAS_BLAST_REPOSITORY_INVALID", "repositoryRoot must be an absolute Git repository root.");
  }
  const lexical = path.resolve(repositoryRoot);
  const real = await fsp.realpath(lexical);
  const stat = await fsp.stat(real);
  if (!stat.isDirectory() || comparable(real) !== comparable(lexical)) {
    throw worktreeError("CEREBRAS_BLAST_REPOSITORY_INVALID", "repositoryRoot must be a canonical directory without an alias.");
  }
  const discovered = git(real, ["rev-parse", "--show-toplevel"]).stdout.trim();
  const discoveredReal = await fsp.realpath(discovered);
  if (comparable(discoveredReal) !== comparable(real)) {
    throw worktreeError("CEREBRAS_BLAST_REPOSITORY_INVALID", "repositoryRoot must be the exact Git worktree root.");
  }
  return real;
}

async function snapshotOne(repositoryRoot, relative, authorizeSource) {
  const source = assertInside(repositoryRoot, path.join(repositoryRoot, relative));
  let lexical;
  try {
    lexical = await fsp.lstat(source);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: relative, exists: false, bytes: Buffer.alloc(0), sha256: "ABSENT" };
    throw error;
  }
  if (!lexical.isFile() || lexical.isSymbolicLink()) {
    throw worktreeError("CEREBRAS_BLAST_SOURCE_TYPE_INVALID", `Blast source must be a non-symlink regular file: ${relative}.`);
  }
  const real = await fsp.realpath(source);
  assertInside(repositoryRoot, real);
  if (authorizeSource) await authorizeSource(real);
  const snapshot = await readStableRegularFile(source, {
    maximumBytes: CEREBRAS_BLAST_MAX_SOURCE_FILE_BYTES,
    requireSingleLink: true,
  });
  assertInside(repositoryRoot, snapshot.realPath);
  if (comparable(snapshot.realPath) !== comparable(real)) {
    throw worktreeError("CEREBRAS_BLAST_SOURCE_PATH_CHANGED", "Blast source changed after its transfer authorization.");
  }
  if (snapshot.bytes.includes(0)) {
    throw worktreeError("CEREBRAS_BLAST_SOURCE_BINARY", `Blast source must be text: ${relative}.`);
  }
  const text = snapshot.bytes.toString("utf8");
  assertCerebrasSourceContentAllowed(text, `cerebras-blast-source:${relative}`);
  return { path: relative, exists: true, bytes: snapshot.bytes, text, sha256: sha256(snapshot.bytes) };
}

export async function snapshotBlastSources(repositoryRoot, paths, { authorizeSource } = {}) {
  const root = await assertBlastRepositoryRoot(repositoryRoot);
  const normalized = normalizeBlastSourcePaths(paths);
  const files = [];
  let totalBytes = 0;
  for (const relative of normalized) {
    const snapshot = await snapshotOne(root, relative, authorizeSource);
    totalBytes += snapshot.bytes.length;
    if (totalBytes > CEREBRAS_BLAST_MAX_SOURCE_BYTES) {
      throw worktreeError("CEREBRAS_BLAST_SOURCE_LIMIT", `Blast source capsule exceeds ${CEREBRAS_BLAST_MAX_SOURCE_BYTES} bytes.`);
    }
    files.push(snapshot);
  }
  return { repositoryRoot: root, files, totalBytes };
}

export function renderBlastSourceCapsule(snapshot, { maximumChars = 48_000 } = {}) {
  const sections = [];
  let used = 0;
  let truncated = false;
  for (const file of snapshot.files) {
    const header = `FILE: ${file.path}\nSHA256: ${file.sha256}\n`;
    const body = file.exists ? file.text : "[ABSENT]";
    const remaining = maximumChars - used - header.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const selected = body.length > remaining ? `${body.slice(0, Math.max(0, remaining - 32))}\n[TRUNCATED BY HARNESS]` : body;
    sections.push(`${header}${selected}`);
    used += header.length + selected.length + 2;
    if (selected.length !== body.length) {
      truncated = true;
      break;
    }
  }
  return { text: sections.join("\n\n"), truncated, includedFiles: sections.length };
}

async function materializeSnapshot(worktree, snapshot) {
  for (const file of snapshot.files) {
    const target = assertInside(worktree, path.join(worktree, file.path));
    await assertResolvedInside(worktree, target);
    if (!file.exists) {
      await fsp.rm(target, { force: true });
      continue;
    }
    await ensureDir(path.dirname(target));
    const parentReal = await fsp.realpath(path.dirname(target));
    assertInside(worktree, parentReal);
    await fsp.writeFile(target, file.bytes);
  }
}

function snapshotStagePaths(repository, snapshot) {
  return snapshot.files
    .filter((file) => file.exists || gitResult(repository, ["ls-files", "--error-unmatch", "--", file.path]).exitCode === 0)
    .map((file) => file.path);
}

function commitSnapshotBaseline(repository, sourcePaths, message, hooksPath, { force = false } = {}) {
  if (sourcePaths.length) {
    git(repository, ["add", ...(force ? ["--force"] : []), "-A", "--", ...sourcePaths], { hooksPath });
  }
  git(repository, [
    "-c", "user.name=Cerebras Blast Harness",
    "-c", "user.email=cerebras-blast@localhost.invalid",
    "commit", "--allow-empty", "--no-gpg-sign", "--no-verify", "-m", message,
  ], { hooksPath });
  return git(repository, ["rev-parse", "HEAD"], { hooksPath }).stdout.trim();
}

export async function prepareBlastWorktreeBaseline({ repositoryRoot, baselineRoot, controllerRoot, snapshot, sourceDirectoryOnly = false }) {
  // Advisor already validates exact file ownership and source hashes. Its caller
  // can be a new plain folder; Git remains confined to the synthetic seed.
  const repository = sourceDirectoryOnly === true
    ? await assertPlainCanonicalDirectory(repositoryRoot, "Advisor source directory")
    : await assertBlastRepositoryRoot(repositoryRoot);
  if (!snapshot || comparable(snapshot.repositoryRoot) !== comparable(repository)) {
    throw worktreeError("CEREBRAS_BLAST_SNAPSHOT_INVALID", "Source snapshot is not bound to the requested repository.");
  }
  const controller = await assertPlainCanonicalDirectory(controllerRoot, "Blast run root");
  const requestedRoot = path.resolve(baselineRoot);
  if (comparable(path.dirname(requestedRoot)) !== comparable(controller)) {
    throw worktreeError("CEREBRAS_BLAST_BASELINE_INVALID", "baselineRoot must be a direct child of the controller run root.");
  }
  const root = await ensurePlainControllerChild(controller, path.basename(requestedRoot), {
    exclusive: true,
    label: "Blast baseline root",
  });
  if (comparable(root) !== comparable(requestedRoot)) throw worktreeError("CEREBRAS_BLAST_BASELINE_INVALID", "baselineRoot identity mismatch.");
  const hooksPath = await ensurePlainControllerChild(root, "hooks-disabled", { exclusive: true, label: "Blast disabled-hooks root" });
  const seedRepository = await ensurePlainControllerChild(root, "snapshot-seed", { exclusive: true, label: "Blast snapshot seed" });
  git(seedRepository, ["init", "--quiet"], { hooksPath });
  await materializeSnapshot(seedRepository, snapshot);
  const sourcePaths = snapshot.files.filter((file) => file.exists).map((file) => file.path);
  const exactBase = commitSnapshotBaseline(
    seedRepository,
    sourcePaths,
    "blast synthetic snapshot baseline",
    hooksPath,
    { force: true },
  );
  return {
    sourceRepositoryRoot: repository,
    baselineRepositoryRoot: seedRepository,
    baselineMode: "snapshot-seed",
    exactBase,
    hooksPath,
  };
}

export async function createBlastCandidateWorktree({ repositoryRoot, worktreeRoot, controllerRoot, workerId, snapshot, preparedBaseline, sourceDirectoryOnly = false }) {
  const repository = sourceDirectoryOnly === true
    ? await assertPlainCanonicalDirectory(repositoryRoot, "Advisor source directory")
    : await assertBlastRepositoryRoot(repositoryRoot);
  if (!snapshot || comparable(snapshot.repositoryRoot) !== comparable(repository)) {
    throw worktreeError("CEREBRAS_BLAST_SNAPSHOT_INVALID", "Source snapshot is not bound to the requested repository.");
  }
  if (!preparedBaseline || comparable(preparedBaseline.sourceRepositoryRoot) !== comparable(repository)) {
    throw worktreeError("CEREBRAS_BLAST_BASELINE_INVALID", "Prepared Blast baseline is not bound to the requested source repository.");
  }
  if (preparedBaseline.baselineMode !== "snapshot-seed") {
    throw worktreeError("CEREBRAS_BLAST_BASELINE_INVALID", "Prepared Blast baseline mode is invalid.");
  }
  if (!/^[0-9a-f]{40,64}$/iu.test(preparedBaseline.exactBase ?? "")) {
    throw worktreeError("CEREBRAS_BLAST_BASELINE_INVALID", "Prepared Blast baseline commit is invalid.");
  }
  const baselineRepository = await assertBlastRepositoryRoot(preparedBaseline.baselineRepositoryRoot);
  const controller = await assertPlainCanonicalDirectory(controllerRoot, "Blast run root");
  assertInside(controller, baselineRepository);
  git(baselineRepository, ["cat-file", "-e", `${preparedBaseline.exactBase}^{commit}`], { hooksPath: preparedBaseline.hooksPath });
  const safeWorkerId = String(workerId ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(safeWorkerId)) {
    throw worktreeError("CEREBRAS_BLAST_WORKER_ID_INVALID", "workerId must be a lowercase filesystem-safe identifier.");
  }
  const root = await assertPlainCanonicalDirectory(worktreeRoot, "Blast worktrees root", controller);
  const worktree = assertInside(root, path.join(root, safeWorkerId));
  try {
    await fsp.lstat(worktree);
    throw worktreeError("CEREBRAS_BLAST_WORKTREE_EXISTS", `Blast worktree already exists for ${safeWorkerId}.`);
  } catch (error) {
    if (error instanceof FleetError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await withRepositoryGitLock(baselineRepository, async () => {
    git(baselineRepository, ["worktree", "add", "--detach", "--no-checkout", worktree, preparedBaseline.exactBase], { hooksPath: preparedBaseline.hooksPath });
  });
  await assertPlainCanonicalDirectory(worktree, `Blast candidate worktree ${safeWorkerId}`, root);
  await materializeSnapshot(worktree, snapshot);
  const sourcePaths = snapshotStagePaths(worktree, snapshot);
  const baselineCommit = commitSnapshotBaseline(
    worktree,
    sourcePaths,
    `blast baseline ${safeWorkerId}`,
    preparedBaseline.hooksPath,
  );
  return {
    repositoryRoot: repository,
    worktree,
    exactBase: preparedBaseline.exactBase,
    baselineCommit,
    baselineMode: preparedBaseline.baselineMode,
  };
}

function normalizePatchEnvelope(value) {
  if (typeof value !== "string") throw worktreeError("CEREBRAS_BLAST_PATCH_INVALID", "Worker patch must be text.");
  let patch = value;
  const fenced = /^```(?:diff|patch)?[ \t]*\r?\n(?<body>[\s\S]*?)\r?\n```[ \t]*(?:\r?\n)?$/u.exec(patch);
  if (fenced) patch = fenced.groups.body;
  if (!patch || Buffer.byteLength(patch, "utf8") > CEREBRAS_BLAST_MAX_PATCH_BYTES) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_INVALID", `Worker patch must be between 1 and ${CEREBRAS_BLAST_MAX_PATCH_BYTES} bytes.`);
  }
  return patch.endsWith("\n") ? patch : `${patch}\n`;
}

function assertBlastPatchPolicy(patch, allowedFiles, { allowDeletion = true } = {}) {
  if (DANGEROUS_PATCH_LINE.test(patch)) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", "Binary, rename, copy, symlink, submodule, and all old-mode/new-mode patches are forbidden.");
  }
  for (const line of patch.split(/\r?\n/u)) {
    if (GIT_FILE_MODE_LINE.test(line) && !SAFE_GIT_FILE_MODE_LINE.test(line)) {
      throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", "New and deleted Blast files must use regular non-executable Git mode 100644.");
    }
  }
  if (!allowDeletion) {
    for (const line of patch.split(/\r?\n/u)) {
      const deletesByHeader = line.startsWith("+++ ") && line.slice(4).split("\t", 1)[0] === "/dev/null";
      if (line === "deleted file mode 100644" || deletesByHeader) {
        throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", "Writable Blast results may not delete files.");
      }
    }
  }
  const allowed = new Set(normalizeBlastSourcePaths(allowedFiles));
  if (!allowed.size) throw worktreeError("CEREBRAS_BLAST_PATCH_SCOPE_EMPTY", "Writable Blast workers require explicit allowed files.");
  return allowed;
}

export function validateBlastPatch(value, allowedFiles, { allowDeletion = true } = {}) {
  const patch = normalizePatchEnvelope(value);
  const allowed = assertBlastPatchPolicy(patch, allowedFiles, { allowDeletion });
  const lines = patch.split(/\r?\n/u);
  const paths = [];
  let current = null;
  let sawHunk = false;
  for (const line of lines) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(line);
    if (header) {
      if (current && !sawHunk) throw worktreeError("CEREBRAS_BLAST_PATCH_INVALID", `Patch block has no hunk: ${current}.`);
      const left = assertSourcePathAllowed(header[1]);
      const right = assertSourcePathAllowed(header[2]);
      if (left !== right) throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", "Patch renames are forbidden.");
      if (!allowed.has(left)) throw worktreeError("CEREBRAS_BLAST_PATCH_SCOPE", `Patch changes a file outside the allowlist: ${left}.`);
      current = left;
      paths.push(left);
      sawHunk = false;
      continue;
    }
    if (/^@@ /u.test(line)) sawHunk = true;
    if (/^(?:---|\+\+\+) /u.test(line)) {
      const token = line.slice(4).split("\t", 1)[0];
      if (token !== "/dev/null") {
        const expectedPrefix = line.startsWith("---") ? "a/" : "b/";
        if (!token.startsWith(expectedPrefix) || !current || assertSourcePathAllowed(token.slice(2)) !== current) {
          throw worktreeError("CEREBRAS_BLAST_PATCH_INVALID", "Patch file headers do not match their diff block.");
        }
      }
    }
  }
  if (current && !sawHunk) throw worktreeError("CEREBRAS_BLAST_PATCH_INVALID", `Patch block has no hunk: ${current}.`);
  if (!paths.length || new Set(paths).size !== paths.length) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_INVALID", "Patch must contain one unique unified diff block per changed file.");
  }
  return { patch, paths: [...paths].sort(), sha256: sha256(patch) };
}

function canonicalizationError(message, details = {}) {
  return worktreeError("CEREBRAS_BLAST_PATCH_INVALID", message, details);
}

function countedHunk(line) {
  const matched = COUNTED_HUNK_HEADER.exec(line);
  if (!matched) return null;
  const values = {
    oldStart: Number(matched.groups.oldStart),
    oldCount: matched.groups.oldCount === undefined ? 1 : Number(matched.groups.oldCount),
    newStart: Number(matched.groups.newStart),
    newCount: matched.groups.newCount === undefined ? 1 : Number(matched.groups.newCount),
  };
  if (Object.values(values).some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw canonicalizationError("Counted patch hunk ranges are outside the supported integer range.");
  }
  return values;
}

function parseCanonicalHunkBody(lines, { allowProviderEndMarker, filePath }) {
  const body = [...lines];
  let removedSentinelCount = 0;
  let removedSentinelLineOffset = null;
  const sentinelIndex = body.indexOf(PROVIDER_END_OF_FILE_MARKER);
  if (sentinelIndex !== -1) {
    if (!allowProviderEndMarker || sentinelIndex === 0 || body.lastIndexOf(PROVIDER_END_OF_FILE_MARKER) !== sentinelIndex) {
      throw canonicalizationError(`Provider end-of-file marker is not valid at this patch location: ${filePath}.`);
    }
    const suffix = body.slice(sentinelIndex + 1);
    if (suffix.length > 1 || suffix.some((line) => line !== "")) {
      throw canonicalizationError(`Provider end-of-file marker must terminate its file block: ${filePath}.`);
    }
    removedSentinelCount = 1;
    removedSentinelLineOffset = sentinelIndex;
    body.splice(sentinelIndex);
  }
  const oldLines = [];
  const newLines = [];
  let additions = 0;
  let deletions = 0;
  let context = 0;
  let previousWasContent = false;
  for (const line of body) {
    if (line === NO_NEWLINE_MARKER) {
      if (!previousWasContent) throw canonicalizationError(`No-newline marker is misplaced: ${filePath}.`);
      throw canonicalizationError(`Bare-hunk canonicalization does not support no-final-newline files: ${filePath}.`);
    }
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === " ") {
      oldLines.push(content);
      newLines.push(content);
      context += 1;
    } else if (prefix === "-") {
      oldLines.push(content);
      deletions += 1;
    } else if (prefix === "+") {
      newLines.push(content);
      additions += 1;
    } else {
      throw canonicalizationError(`Bare patch hunk contains an unprefixed or unsupported line: ${filePath}.`);
    }
    previousWasContent = true;
  }
  return {
    lines: body,
    oldLines,
    newLines,
    additions,
    deletions,
    context,
    removedSentinelCount,
    removedSentinelLineOffset,
  };
}

function splitCanonicalSource(bytes, filePath) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.includes("\0") || text.includes("\r") || (text && !text.endsWith("\n"))) {
    throw canonicalizationError(`Bare-hunk canonicalization requires a stable UTF-8 LF source ending in a newline: ${filePath}.`);
  }
  if (!text) return [];
  const lines = text.split("\n");
  lines.pop();
  return lines;
}

function findUniqueLineSequence(sourceLines, sequence, comparisonBudget, filePath) {
  const matches = [];
  const lastStart = sourceLines.length - sequence.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      comparisonBudget.count += 1;
      if (comparisonBudget.count > CEREBRAS_BLAST_MAX_CANONICAL_LINE_COMPARISONS) {
        throw canonicalizationError("Bare-hunk canonicalization exceeded its bounded comparison budget.");
      }
      if (sourceLines[start + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      matches.push(start);
      if (matches.length > 1) break;
    }
  }
  if (matches.length !== 1) {
    throw canonicalizationError(`Bare patch hunk does not have one unique exact source anchor: ${filePath}.`, { matches: matches.length });
  }
  return matches[0];
}

function parseCanonicalizablePatch(patch, allowed) {
  if (patch.includes("\r")) throw canonicalizationError("Bare-hunk canonicalization accepts LF patch envelopes only.");
  const lines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");
  if (!lines.length || !lines[0].startsWith("diff --git ")) {
    throw canonicalizationError("Canonicalizable patches must begin with a diff --git block and contain no leading prose.");
  }
  const blocks = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(lines[index]);
    if (header) {
      if (current) current.end = index;
      const left = assertSourcePathAllowed(header[1]);
      const right = assertSourcePathAllowed(header[2]);
      if (left !== right) throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", "Patch renames are forbidden.");
      if (!allowed.has(left)) throw worktreeError("CEREBRAS_BLAST_PATCH_SCOPE", `Patch changes a file outside the allowlist: ${left}.`);
      current = { path: left, start: index, end: lines.length, oldHeader: null, newHeader: null, hunks: [] };
      blocks.push(current);
      continue;
    }
    if (!current) throw canonicalizationError("Canonicalizable patches may not contain prose outside diff blocks.");
    const isBare = BARE_HUNK_HEADER.test(lines[index]);
    const isCounted = COUNTED_HUNK_HEADER.test(lines[index]);
    if (isBare || isCounted || lines[index].startsWith("@@ ")) {
      if (!isBare && !isCounted) throw canonicalizationError(`Patch contains a malformed counted hunk header: ${current.path}.`);
      if (!current.oldHeader || !current.newHeader) throw canonicalizationError(`Patch hunks require coherent --- and +++ headers: ${current.path}.`);
      current.hunks.push({ start: index, bare: isBare, counted: isCounted ? countedHunk(lines[index]) : null });
      continue;
    }
    if (!current.hunks.length && lines[index].startsWith("--- ")) {
      if (current.oldHeader) throw canonicalizationError(`Patch contains duplicate --- headers: ${current.path}.`);
      current.oldHeader = lines[index].slice(4).split("\t", 1)[0];
    } else if (!current.hunks.length && lines[index].startsWith("+++ ")) {
      if (current.newHeader) throw canonicalizationError(`Patch contains duplicate +++ headers: ${current.path}.`);
      current.newHeader = lines[index].slice(4).split("\t", 1)[0];
    }
  }
  if (current) current.end = lines.length;
  if (!blocks.length || new Set(blocks.map((block) => block.path.toLowerCase())).size !== blocks.length) {
    throw canonicalizationError("Patch must contain one unique unified diff block per changed file.");
  }
  let hunkCount = 0;
  for (const block of blocks) {
    if (!block.hunks.length) throw canonicalizationError(`Patch block has no hunk: ${block.path}.`);
    hunkCount += block.hunks.length;
    if (hunkCount > CEREBRAS_BLAST_MAX_CANONICAL_HUNKS) {
      throw canonicalizationError(`Bare-hunk canonicalization accepts at most ${CEREBRAS_BLAST_MAX_CANONICAL_HUNKS} hunks.`);
    }
    if (!block.hunks.some((hunk) => hunk.bare)) continue;
    if (block.hunks.some((hunk) => !hunk.bare)) {
      throw canonicalizationError(`Bare and counted hunks may not be mixed in one file block: ${block.path}.`);
    }
    const oldExpected = block.oldHeader === "/dev/null" ? "/dev/null" : `a/${block.path}`;
    const newExpected = block.newHeader === "/dev/null" ? "/dev/null" : `b/${block.path}`;
    if (block.oldHeader !== oldExpected || block.newHeader !== newExpected || (oldExpected === "/dev/null" && newExpected === "/dev/null")) {
      throw canonicalizationError(`Patch file headers do not match their diff block: ${block.path}.`);
    }
    const preamble = lines.slice(block.start + 1, block.hunks[0].start);
    const newModes = preamble.filter((line) => line.startsWith("new file mode "));
    const deletedModes = preamble.filter((line) => line.startsWith("deleted file mode "));
    const kind = oldExpected === "/dev/null" ? "new" : newExpected === "/dev/null" ? "deleted" : "existing";
    if (
      (kind === "new" && (newModes.length !== 1 || deletedModes.length !== 0))
      || (kind === "deleted" && (deletedModes.length !== 1 || newModes.length !== 0))
      || (kind === "existing" && (newModes.length !== 0 || deletedModes.length !== 0))
    ) {
      throw canonicalizationError(`Patch file status metadata is inconsistent: ${block.path}.`);
    }
    block.kind = kind;
  }
  return { lines, blocks };
}

export async function canonicalizeBlastPatchHunks({ worktree, patch: value, allowedFiles, allowDeletion = true }) {
  const providerPatch = normalizePatchEnvelope(value);
  const providerPatchSha256 = sha256(value);
  const normalizedProviderPatchSha256 = sha256(providerPatch);
  if (!providerPatch.split("\n").some((line) => BARE_HUNK_HEADER.test(line))) {
    const validated = validateBlastPatch(providerPatch, allowedFiles, { allowDeletion });
    return {
      ...validated,
      providerPatchSha256,
      normalizedProviderPatchSha256,
      canonicalPatchSha256: validated.sha256,
      canonicalized: false,
      canonicalizationVersion: CEREBRAS_BLAST_CANONICALIZATION_VERSION,
      canonicalizedHunks: 0,
      droppedNoopHunks: 0,
      removedSentinelCount: 0,
      transformations: [],
    };
  }
  const allowed = assertBlastPatchPolicy(providerPatch, allowedFiles, { allowDeletion });
  const parsed = parseCanonicalizablePatch(providerPatch, allowed);
  const renderedBlocks = [];
  const transformations = [];
  const comparisonBudget = { count: 0 };
  let canonicalizedHunks = 0;
  let droppedNoopHunks = 0;
  let removedSentinelCount = 0;
  for (const block of parsed.blocks) {
    if (!block.hunks.some((hunk) => hunk.bare)) {
      renderedBlocks.push(parsed.lines.slice(block.start, block.end));
      continue;
    }
    const target = assertInside(path.resolve(worktree), path.join(path.resolve(worktree), block.path));
    let sourceLines = null;
    if (block.kind === "new") {
      try {
        await fsp.lstat(target);
        throw canonicalizationError(`New-file bare hunk targets an existing path: ${block.path}.`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } else {
      let stable;
      try {
        stable = await readStableRegularFile(target, {
          maximumBytes: CEREBRAS_BLAST_MAX_SOURCE_FILE_BYTES,
          requireSingleLink: true,
        });
      } catch (error) {
        if (error?.code === "CEREBRAS_BLAST_PATCH_INVALID") throw error;
        throw canonicalizationError(`Bare-hunk source is unavailable or unsafe: ${block.path}.`, { causeCode: error?.code ?? "UNKNOWN" });
      }
      assertInside(path.resolve(worktree), stable.realPath);
      sourceLines = splitCanonicalSource(stable.bytes, block.path);
    }
    if ((block.kind === "new" || block.kind === "deleted") && block.hunks.length !== 1) {
      throw canonicalizationError(`New and deleted files require exactly one bare hunk: ${block.path}.`);
    }
    const preamble = parsed.lines
      .slice(block.start, block.hunks[0].start)
      .filter((line) => !/^index /u.test(line));
    const rendered = [...preamble];
    let previousOldEnd = 0;
    let cumulativeDelta = 0;
    let keptHunks = 0;
    for (let index = 0; index < block.hunks.length; index += 1) {
      const hunk = block.hunks[index];
      const end = index + 1 < block.hunks.length ? block.hunks[index + 1].start : block.end;
      const parsedBody = parseCanonicalHunkBody(parsed.lines.slice(hunk.start + 1, end), {
        allowProviderEndMarker: index === block.hunks.length - 1,
        filePath: block.path,
      });
      if (parsedBody.additions === 0 && parsedBody.deletions === 0) {
        droppedNoopHunks += 1;
        removedSentinelCount += parsedBody.removedSentinelCount;
        transformations.push({
          path: block.path,
          hunk: index + 1,
          action: "dropped-noop",
          removedSentinel: parsedBody.removedSentinelCount === 1,
        });
        continue;
      }
      let oldStart;
      let oldCount;
      let newStart;
      let newCount;
      if (block.kind === "new") {
        if (parsedBody.deletions || parsedBody.context || !parsedBody.additions) {
          throw canonicalizationError(`New-file bare hunk must contain additions only: ${block.path}.`);
        }
        oldStart = 0;
        oldCount = 0;
        newStart = 1;
        newCount = parsedBody.additions;
      } else if (block.kind === "deleted") {
        if (parsedBody.additions || parsedBody.context || !parsedBody.deletions || parsedBody.oldLines.length !== sourceLines.length || !parsedBody.oldLines.every((line, lineIndex) => line === sourceLines[lineIndex])) {
          throw canonicalizationError(`Deleted-file bare hunk must delete the exact entire source file: ${block.path}.`);
        }
        oldStart = 1;
        oldCount = parsedBody.deletions;
        newStart = 0;
        newCount = 0;
      } else {
        if (!parsedBody.oldLines.length) throw canonicalizationError(`Existing-file bare hunk requires source context or deletions: ${block.path}.`);
        const matchStart = findUniqueLineSequence(sourceLines, parsedBody.oldLines, comparisonBudget, block.path);
        if (matchStart < previousOldEnd) throw canonicalizationError(`Bare patch hunks overlap or are out of source order: ${block.path}.`);
        oldStart = matchStart + 1;
        oldCount = parsedBody.oldLines.length;
        newStart = oldStart + cumulativeDelta;
        newCount = parsedBody.newLines.length;
        previousOldEnd = matchStart + oldCount;
        cumulativeDelta += parsedBody.additions - parsedBody.deletions;
      }
      rendered.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...parsedBody.lines);
      canonicalizedHunks += 1;
      keptHunks += 1;
      removedSentinelCount += parsedBody.removedSentinelCount;
      transformations.push({
        path: block.path,
        hunk: index + 1,
        action: "canonicalized",
        oldStart,
        oldCount,
        newStart,
        newCount,
        removedSentinel: parsedBody.removedSentinelCount === 1,
      });
    }
    if (keptHunks) renderedBlocks.push(rendered);
  }
  if (!renderedBlocks.length || !canonicalizedHunks) {
    throw canonicalizationError("Bare patch contains no controller-reconstructable edits.");
  }
  const canonicalPatch = `${renderedBlocks.flat().join("\n")}\n`;
  const validated = validateBlastPatch(canonicalPatch, allowedFiles, { allowDeletion });
  return {
    ...validated,
    providerPatchSha256,
    normalizedProviderPatchSha256,
    canonicalPatchSha256: validated.sha256,
    canonicalized: true,
    canonicalizationVersion: CEREBRAS_BLAST_CANONICALIZATION_VERSION,
    canonicalizedHunks,
    droppedNoopHunks,
    removedSentinelCount,
    transformations,
  };
}

function structuredEditError(message, details = {}) {
  return worktreeError("CEREBRAS_BLAST_STRUCTURED_EDIT_INVALID", message, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactObjectKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw structuredEditError(`${label} must contain exactly: ${allowed.join(", ")}.`);
  }
}

function unwrapStructuredEditEnvelope(value) {
  if (typeof value !== "string") throw structuredEditError("Writable worker result must be text.");
  if (!value || Buffer.byteLength(value, "utf8") > CEREBRAS_BLAST_MAX_PATCH_BYTES) {
    throw structuredEditError(`Structured edit result must be between 1 and ${CEREBRAS_BLAST_MAX_PATCH_BYTES} bytes.`);
  }
  const trimmed = value.trim();
  const fenced = /^```json[ \t]*\r?\n(?<body>[\s\S]*?)\r?\n```$/u.exec(trimmed);
  return fenced ? fenced.groups.body : trimmed;
}

function looksLikeStructuredEdits(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("```json");
}

export function parseBlastStructuredEdits(value, allowedFiles) {
  const raw = unwrapStructuredEditEnvelope(value);
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw structuredEditError("Structured edit result is not valid JSON.");
  }
  if (!plainObject(document)) throw structuredEditError("Structured edit result must be one JSON object.");
  assertExactObjectKeys(document, ["edits", "format", "schemaVersion"], "Structured edit document");
  if (document.schemaVersion !== 1 || document.format !== CEREBRAS_BLAST_STRUCTURED_EDIT_FORMAT) {
    throw structuredEditError(`Structured edit document must use schemaVersion 1 and format ${CEREBRAS_BLAST_STRUCTURED_EDIT_FORMAT}.`);
  }
  if (!Array.isArray(document.edits) || !document.edits.length || document.edits.length > CEREBRAS_BLAST_MAX_STRUCTURED_EDITS) {
    throw structuredEditError(`Structured edit document requires 1-${CEREBRAS_BLAST_MAX_STRUCTURED_EDITS} edits.`);
  }
  const allowed = new Set(normalizeBlastSourcePaths(allowedFiles));
  if (!allowed.size) throw worktreeError("CEREBRAS_BLAST_PATCH_SCOPE_EMPTY", "Writable Blast workers require explicit allowed files.");
  const edits = document.edits.map((entry, index) => {
    if (!plainObject(entry)) throw structuredEditError(`Structured edit ${index + 1} must be an object.`);
    if (entry.operation === "replace") {
      assertExactObjectKeys(entry, ["newText", "oldText", "operation", "path", "sourceSha256"], `Structured replace edit ${index + 1}`);
      if (typeof entry.oldText !== "string" || !entry.oldText || typeof entry.newText !== "string" || entry.oldText === entry.newText) {
        throw structuredEditError(`Structured replace edit ${index + 1} requires distinct non-empty oldText and string newText.`);
      }
    } else if (entry.operation === "create") {
      assertExactObjectKeys(entry, ["content", "operation", "path", "sourceSha256"], `Structured create edit ${index + 1}`);
      if (entry.sourceSha256 !== "ABSENT" || typeof entry.content !== "string" || !entry.content) {
        throw structuredEditError(`Structured create edit ${index + 1} requires sourceSha256 ABSENT and non-empty content.`);
      }
    } else {
      throw structuredEditError(`Structured edit ${index + 1} operation must be replace or create.`);
    }
    if (typeof entry.path !== "string" || /\s/u.test(entry.path) || assertSourcePathAllowed(entry.path) !== entry.path) {
      throw structuredEditError(`Structured edit ${index + 1} path must be one exact normalized source path.`);
    }
    if (!allowed.has(entry.path)) {
      throw worktreeError("CEREBRAS_BLAST_PATCH_SCOPE", `Structured edit changes a file outside the allowlist: ${entry.path}.`);
    }
    if (entry.operation === "replace" && (typeof entry.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sourceSha256))) {
      throw structuredEditError(`Structured replace edit ${index + 1} requires one lowercase SHA-256 source hash.`);
    }
    for (const text of entry.operation === "replace" ? [entry.oldText, entry.newText] : [entry.content]) {
      if (text.includes("\0") || Buffer.byteLength(text, "utf8") > CEREBRAS_BLAST_MAX_SOURCE_FILE_BYTES) {
        throw structuredEditError(`Structured edit ${index + 1} text is binary-shaped or exceeds the per-file byte limit.`);
      }
    }
    return { ...entry };
  });
  const canonicalDocument = {
    schemaVersion: 1,
    format: CEREBRAS_BLAST_STRUCTURED_EDIT_FORMAT,
    edits,
  };
  const canonicalJson = `${stableJson(canonicalDocument)}\n`;
  return {
    document: canonicalDocument,
    canonicalJson,
    rawResultSha256: sha256(value),
    structuredEditsSha256: sha256(canonicalJson),
  };
}

async function readStructuredEditSource(worktree, relative) {
  const root = path.resolve(worktree);
  const target = assertInside(root, path.join(root, relative));
  try {
    await assertResolvedInside(root, target);
  } catch (error) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", `Structured edit path resolves outside its isolated worktree: ${relative}.`, { causeCode: error?.code ?? "UNKNOWN" });
  }
  let lexical;
  try {
    lexical = await fsp.lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { root, relative, target, exists: false, bytes: null, stat: null, sha256: "ABSENT", text: null };
    throw error;
  }
  if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1n) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", `Structured edit source is not one unlinked regular file: ${relative}.`);
  }
  let stable;
  try {
    stable = await readStableRegularFile(target, {
      maximumBytes: CEREBRAS_BLAST_MAX_SOURCE_FILE_BYTES,
      requireSingleLink: true,
    });
  } catch (error) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", `Structured edit source could not be read safely: ${relative}.`, { causeCode: error?.code ?? "UNKNOWN" });
  }
  assertInside(root, stable.realPath);
  if (comparable(stable.realPath) !== comparable(target)) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", `Structured edit source resolves through an alias: ${relative}.`);
  }
  const text = stable.bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(stable.bytes) || text.includes("\0")) {
    throw structuredEditError(`Structured edits require UTF-8 text source files: ${relative}.`);
  }
  return { root, relative, target, exists: true, bytes: stable.bytes, stat: stable.stat, sha256: sha256(stable.bytes), text };
}

function uniqueTextMatch(source, needle, relative) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + 1) >= 0) {
    throw structuredEditError(`Structured replace oldText must match exactly once in the declared source: ${relative}.`, { matches: first < 0 ? 0 : 2 });
  }
  return first;
}

function writeControllerGitObject(worktree, args, input, label) {
  const result = gitResult(worktree, args, { input });
  if (result.exitCode !== 0) {
    throw worktreeError("CEREBRAS_BLAST_GIT_FAILED", `Git could not create the controller-owned ${label}.`, { stderr: result.stderr.slice(0, 4_000) });
  }
  const objectId = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(objectId)) {
    throw worktreeError("CEREBRAS_BLAST_GIT_FAILED", `Git returned an invalid ${label} object id.`);
  }
  return objectId;
}

function controllerTreeForPath(worktree, relative, blobId) {
  const segments = relative.split("/");
  let treeId = blobId === null
    ? writeControllerGitObject(worktree, ["mktree"], "", "empty tree")
    : writeControllerGitObject(worktree, ["mktree"], `100644 blob ${blobId}\t${segments.at(-1)}\n`, "leaf tree");
  if (blobId === null) return treeId;
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    treeId = writeControllerGitObject(worktree, ["mktree"], `040000 tree ${treeId}\t${segments[index]}\n`, "parent tree");
  }
  return treeId;
}

function controllerPatchForStructuredPlan(worktree, plan) {
  const priorBlob = plan.source.exists
    ? writeControllerGitObject(worktree, ["hash-object", "-w", "--no-filters", "--stdin"], plan.source.bytes, "source blob")
    : null;
  const nextBlob = writeControllerGitObject(worktree, ["hash-object", "-w", "--no-filters", "--stdin"], plan.nextBytes, "result blob");
  const priorTree = controllerTreeForPath(worktree, plan.source.relative, priorBlob);
  const nextTree = controllerTreeForPath(worktree, plan.source.relative, nextBlob);
  const diff = gitResult(worktree, [
    "diff-tree", "-r", "--no-commit-id", "--no-renames", "--no-ext-diff", "--no-textconv",
    "--binary", "--full-index", "-p", priorTree, nextTree, "--", plan.source.relative,
  ]);
  if (diff.exitCode !== 0 || !diff.stdout) {
    throw worktreeError("CEREBRAS_BLAST_GIT_FAILED", `Git could not generate the structured edit patch: ${plan.source.relative}.`, { stderr: diff.stderr.slice(0, 4_000) });
  }
  return { patch: diff.stdout.endsWith("\n") ? diff.stdout : `${diff.stdout}\n`, priorBlob, nextBlob, priorTree, nextTree };
}

export async function applyBlastStructuredEdits({ worktree, baselineCommit, result, allowedFiles, onStructuredApplied }) {
  if (onStructuredApplied !== undefined && typeof onStructuredApplied !== "function") {
    throw worktreeError("CEREBRAS_BLAST_ARGUMENT_INVALID", "onStructuredApplied must be a function when supplied.");
  }
  const parsed = parseBlastStructuredEdits(result, allowedFiles);
  const byPath = new Map();
  for (const edit of parsed.document.edits) {
    const key = edit.path.toLowerCase();
    const group = byPath.get(key) ?? { path: edit.path, edits: [] };
    if (group.path !== edit.path) throw structuredEditError(`Structured edit paths collide by case: ${edit.path}.`);
    group.edits.push(edit);
    byPath.set(key, group);
  }
  const plans = [];
  let totalOutputBytes = 0;
  for (const group of byPath.values()) {
    const source = await readStructuredEditSource(worktree, group.path);
    const creates = group.edits.filter((edit) => edit.operation === "create");
    const replacements = group.edits.filter((edit) => edit.operation === "replace");
    let nextText;
    if (creates.length) {
      if (creates.length !== 1 || replacements.length || source.exists) {
        throw structuredEditError(`Structured create must be the only edit for one absent path: ${group.path}.`);
      }
      nextText = creates[0].content;
    } else {
      if (!source.exists || !replacements.length) throw structuredEditError(`Structured replace requires one existing source file: ${group.path}.`);
      if (replacements.some((edit) => edit.sourceSha256 !== source.sha256)) {
        throw structuredEditError(`Structured replace source hash does not match the controller worktree: ${group.path}.`, { actualSha256: source.sha256 });
      }
      const spans = replacements.map((edit) => {
        const start = uniqueTextMatch(source.text, edit.oldText, group.path);
        return { start, end: start + edit.oldText.length, edit };
      }).sort((left, right) => left.start - right.start || left.end - right.end);
      for (let index = 1; index < spans.length; index += 1) {
        if (spans[index].start < spans[index - 1].end) {
          throw structuredEditError(`Structured replace anchors overlap: ${group.path}.`);
        }
      }
      nextText = source.text;
      for (const span of [...spans].reverse()) {
        nextText = `${nextText.slice(0, span.start)}${span.edit.newText}${nextText.slice(span.end)}`;
      }
      if (nextText === source.text) throw structuredEditError(`Structured replacements produce no file change: ${group.path}.`);
    }
    const nextBytes = Buffer.from(nextText, "utf8");
    if (!nextBytes.length || nextBytes.length > CEREBRAS_BLAST_MAX_SOURCE_FILE_BYTES) {
      throw structuredEditError(`Structured edit output must be 1-${CEREBRAS_BLAST_MAX_SOURCE_FILE_BYTES} bytes: ${group.path}.`);
    }
    totalOutputBytes += nextBytes.length;
    if (totalOutputBytes > CEREBRAS_BLAST_MAX_SOURCE_BYTES) {
      throw structuredEditError(`Structured edit outputs exceed ${CEREBRAS_BLAST_MAX_SOURCE_BYTES} total bytes.`);
    }
    plans.push({ source, nextBytes, nextSha256: sha256(nextBytes), operationCount: group.edits.length });
  }
  for (const plan of plans) {
    const current = await readStructuredEditSource(worktree, plan.source.relative);
    if (current.exists !== plan.source.exists || current.sha256 !== plan.source.sha256) {
      throw structuredEditError(`Structured edit source changed after validation: ${plan.source.relative}.`);
    }
  }
  const generated = plans.map((plan) => ({ plan, ...controllerPatchForStructuredPlan(worktree, plan) }));
  const controllerPatch = generated.map((entry) => entry.patch).join("");
  const applied = await applyBlastCandidatePatch({ worktree, baselineCommit, patch: controllerPatch, allowedFiles });
  const changed = new Set(applied.evidence.changedFiles);
  if (plans.some((plan) => !changed.has(plan.source.relative))) {
    throw structuredEditError("Controller-generated Git evidence does not contain every structured edit path.");
  }
  const application = {
    inputFormat: CEREBRAS_BLAST_STRUCTURED_EDIT_FORMAT,
    schemaVersion: 1,
    rawResultSha256: parsed.rawResultSha256,
    structuredEditsSha256: parsed.structuredEditsSha256,
    editCount: parsed.document.edits.length,
    paths: plans.map((plan) => plan.source.relative).sort(),
    outputs: generated.map((entry) => ({
      path: entry.plan.source.relative,
      priorSha256: entry.plan.source.sha256,
      nextSha256: entry.plan.nextSha256,
      priorBlob: entry.priorBlob,
      nextBlob: entry.nextBlob,
      operationCount: entry.plan.operationCount,
    })),
  };
  if (onStructuredApplied) await onStructuredApplied({ ...application, canonicalJson: parsed.canonicalJson, evidence: applied.evidence });
  return {
    inputFormat: CEREBRAS_BLAST_STRUCTURED_EDIT_FORMAT,
    patch: applied.evidence.exactDiff,
    paths: application.paths,
    sha256: applied.evidence.diffSha256,
    providerPatchSha256: parsed.rawResultSha256,
    normalizedProviderPatchSha256: parsed.structuredEditsSha256,
    canonicalPatchSha256: applied.evidence.diffSha256,
    canonicalized: false,
    structuredEditsApplied: true,
    structuredApplication: application,
    evidence: applied.evidence,
  };
}

async function captureBlastGitEvidence(worktree, exactBase, expectedPaths) {
  const scopedPaths = normalizeBlastSourcePaths(expectedPaths);
  const changed = git(worktree, ["diff", "--name-only", "--no-renames", exactBase, "--", ...scopedPaths]).stdout
    .split(/\r?\n/u).filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
  const untracked = [];
  for (const relative of scopedPaths) {
    if (gitResult(worktree, ["ls-files", "--error-unmatch", "--", relative]).exitCode === 0) continue;
    try {
      const stat = await fsp.lstat(path.join(worktree, relative));
      if (stat.isFile() && !stat.isSymbolicLink()) untracked.push(relative);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const allChanged = [...new Set([...changed, ...untracked])].sort();
  const diffResult = gitResult(worktree, ["diff", "--binary", "--no-ext-diff", "--no-textconv", exactBase, "--", ...scopedPaths]);
  if (diffResult.exitCode !== 0) {
    throw worktreeError("CEREBRAS_BLAST_GIT_FAILED", "Git could not capture the candidate diff.", { stderr: diffResult.stderr.slice(0, 4_000) });
  }
  const noIndexDiffs = [];
  for (const relative of untracked) {
    const result = gitResult(worktree, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-index", "--", "/dev/null", relative]);
    if (![0, 1].includes(result.exitCode)) {
      throw worktreeError("CEREBRAS_BLAST_GIT_FAILED", `Could not capture the candidate diff for ${relative}.`, { stderr: result.stderr.slice(0, 4_000) });
    }
    noIndexDiffs.push(result.stdout);
  }
  const exactDiff = [diffResult.stdout, ...noIndexDiffs].filter(Boolean).join("\n");
  const numstat = git(worktree, ["diff", "--numstat", exactBase, "--", ...scopedPaths]).stdout;
  let changedLines = 0;
  for (const line of numstat.split(/\r?\n/u).filter(Boolean)) {
    const [added, deleted] = line.split("\t");
    changedLines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  for (const relative of untracked) {
    try {
      changedLines += (await fsp.readFile(path.join(worktree, relative), "utf8")).split(/\r?\n/u).length - 1;
    } catch {
      changedLines += 0;
    }
  }
  return { changedFiles: allChanged, exactDiff, diffSha256: sha256(exactDiff), changedLines };
}

async function verifyBlastAppliedEvidence(worktree, baselineCommit, expectedPaths, allowedFiles) {
  const evidence = await captureBlastGitEvidence(worktree, baselineCommit, expectedPaths);
  const allowed = new Set(normalizeBlastSourcePaths(allowedFiles));
  const outside = evidence.changedFiles.filter((entry) => !allowed.has(entry));
  if (outside.length) throw worktreeError("CEREBRAS_BLAST_PATCH_SCOPE", "Applied candidate changed files outside the allowlist.", { outside });
  for (const relative of evidence.changedFiles) {
    const target = assertInside(worktree, path.join(worktree, relative));
    try {
      const stat = await fsp.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", `Applied candidate produced a non-regular or linked file: ${relative}.`);
      }
      const real = await fsp.realpath(target);
      if (comparable(real) !== comparable(target)) {
        throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", `Applied candidate produced an aliased file: ${relative}.`);
      }
      assertInside(worktree, real);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return evidence;
}

export async function applyBlastCandidatePatch({ worktree, baselineCommit, patch, allowedFiles, onCanonicalized, allowDeletion = true }) {
  const validated = await canonicalizeBlastPatchHunks({ worktree, patch, allowedFiles, allowDeletion });
  if (onCanonicalized !== undefined && typeof onCanonicalized !== "function") {
    throw worktreeError("CEREBRAS_BLAST_ARGUMENT_INVALID", "onCanonicalized must be a function when supplied.");
  }
  if (validated.canonicalized && onCanonicalized) await onCanonicalized(validated);
  const check = gitResult(worktree, ["apply", "--check", "--whitespace=nowarn", "-"], { input: validated.patch });
  if (check.exitCode !== 0) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_DOES_NOT_APPLY", "Worker patch failed git apply --check.", {
      stderr: check.stderr.slice(0, 4_000),
      patchSha256: validated.sha256,
      providerPatchSha256: validated.providerPatchSha256,
      canonicalized: validated.canonicalized,
    });
  }
  const applied = gitResult(worktree, ["apply", "--whitespace=nowarn", "-"], { input: validated.patch });
  if (applied.exitCode !== 0) {
    throw worktreeError("CEREBRAS_BLAST_PATCH_APPLY_FAILED", "Worker patch could not be applied after validation.", {
      stderr: applied.stderr.slice(0, 4_000),
      patchSha256: validated.sha256,
      providerPatchSha256: validated.providerPatchSha256,
      canonicalized: validated.canonicalized,
    });
  }
  const evidence = await verifyBlastAppliedEvidence(worktree, baselineCommit, validated.paths, allowedFiles);
  return { ...validated, evidence };
}

export async function applyBlastCandidateResult({ result, ...options }) {
  if (looksLikeStructuredEdits(result)) {
    return applyBlastStructuredEdits({ ...options, result });
  }
  return applyBlastCandidatePatch({ ...options, patch: result, allowDeletion: false });
}

function normalizeTestCommand(value, index) {
  const source = Array.isArray(value) ? { argv: value } : value;
  if (!source || typeof source !== "object" || Array.isArray(source) || !Array.isArray(source.argv)) {
    throw worktreeError("CEREBRAS_BLAST_TEST_INVALID", `Test command ${index + 1} must contain an argv array.`);
  }
  const argv = source.argv.map((entry) => {
    if (typeof entry !== "string" || !entry || entry.length > 1_000 || /[\r\n\0]/u.test(entry)) {
      throw worktreeError("CEREBRAS_BLAST_TEST_INVALID", `Test command ${index + 1} contains an invalid argument.`);
    }
    return entry;
  });
  assertNoSecretValues(argv, `cerebras-blast-test-command-${index + 1}`);
  if (!argv.length || argv.length > 64) throw worktreeError("CEREBRAS_BLAST_TEST_INVALID", `Test command ${index + 1} has an invalid argv length.`);
  if (path.basename(argv[0]) !== argv[0] || /[\\/:]/u.test(argv[0])) {
    throw worktreeError("CEREBRAS_BLAST_TEST_EXECUTABLE_DENIED", "Test executable must be an exact allowlisted command name without a path.");
  }
  const executable = argv[0].toLowerCase();
  if (!TEST_EXECUTABLES.has(executable)) {
    throw worktreeError("CEREBRAS_BLAST_TEST_EXECUTABLE_DENIED", `Test executable is not allowlisted: ${executable}.`);
  }
  const args = argv.slice(1);
  if (args.some((entry) => path.isAbsolute(entry) || /(?:^|=)(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(entry) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(entry))) {
    throw worktreeError("CEREBRAS_BLAST_TEST_PATH_DENIED", "Test arguments must stay repository-relative inside the isolated worktree.");
  }
  if (args.some((entry) => DANGEROUS_TEST_TOKEN.test(entry))) {
    throw worktreeError("CEREBRAS_BLAST_TEST_OPERATION_DENIED", "Install, publish, deploy, migration, destructive, and production test operations are forbidden.");
  }
  if (executable.startsWith("node")) {
    if (args.some((entry) => ["-e", "--eval", "-p", "--print"].includes(entry))) {
      throw worktreeError("CEREBRAS_BLAST_TEST_OPERATION_DENIED", "Inline Node evaluation is forbidden.");
    }
  } else if (executable.startsWith("npm") || executable.startsWith("pnpm") || executable.startsWith("yarn")) {
    const verb = args[0]?.toLowerCase();
    if (!verb || !["test", "run", "exec"].includes(verb)) {
      throw worktreeError("CEREBRAS_BLAST_TEST_OPERATION_DENIED", "Package-manager commands are limited to test, run, or exec.");
    }
  } else if (executable.startsWith("npx")) {
    if (args[0] !== "--no-install") {
      throw worktreeError("CEREBRAS_BLAST_TEST_OPERATION_DENIED", "npx requires --no-install in Blast worktrees.");
    }
  } else if (executable.startsWith("python") || executable === "py" || executable === "py.exe") {
    if (!(args[0] === "-m" && ["pytest", "unittest", "compileall"].includes(args[1]))) {
      throw worktreeError("CEREBRAS_BLAST_TEST_OPERATION_DENIED", "Python commands are limited to -m pytest, unittest, or compileall.");
    }
  } else if (executable.startsWith("cargo") && !["test", "check", "clippy"].includes(args[0])) {
    throw worktreeError("CEREBRAS_BLAST_TEST_OPERATION_DENIED", "Cargo commands are limited to test, check, or clippy.");
  } else if (executable.startsWith("dotnet") && !["test", "build"].includes(args[0])) {
    throw worktreeError("CEREBRAS_BLAST_TEST_OPERATION_DENIED", "dotnet commands are limited to test or build.");
  } else if (executable.startsWith("go") && args[0] !== "test") {
    throw worktreeError("CEREBRAS_BLAST_TEST_OPERATION_DENIED", "Go commands are limited to test.");
  }
  const timeoutMs = Number.isInteger(source.timeoutMs) ? source.timeoutMs : 120_000;
  if (timeoutMs < 1_000 || timeoutMs > CEREBRAS_BLAST_MAX_TEST_TIMEOUT_MS) {
    throw worktreeError("CEREBRAS_BLAST_TEST_INVALID", `Test timeout must be between 1000 and ${CEREBRAS_BLAST_MAX_TEST_TIMEOUT_MS} milliseconds.`);
  }
  return { argv, timeoutMs };
}

export function normalizeBlastTestCommands(values = []) {
  if (!Array.isArray(values) || values.length > CEREBRAS_BLAST_MAX_TEST_COMMANDS) {
    throw worktreeError("CEREBRAS_BLAST_TEST_INVALID", `Blast accepts at most ${CEREBRAS_BLAST_MAX_TEST_COMMANDS} test commands.`);
  }
  return values.map(normalizeTestCommand);
}

function testEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || SECRET_ENV_KEY.test(key) || DANGEROUS_GIT_ENV_KEY.test(key) || key.toUpperCase() === "NODE_OPTIONS") continue;
    environment[key] = value;
  }
  environment.CI = "1";
  environment.NO_COLOR = "1";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function boundedOutput(value, label) {
  const text = String(value ?? "");
  const selected = text.length > 256_000 ? `${text.slice(0, 256_000)}\n[TRUNCATED BY HARNESS]` : text;
  try {
    assertNoSecretValues(selected, label);
    return { text: selected, sha256: sha256(text), redacted: false, truncated: selected.length !== text.length };
  } catch {
    return { text: "[REDACTED: secret-shaped command output]", sha256: sha256(text), redacted: true, truncated: false };
  }
}

export async function runBlastTests({ worktree, commands, signal, sandboxRoot, allowedFiles, sandboxRunner = runWriterSandbox }) {
  if (typeof sandboxRoot !== "string" || !path.isAbsolute(sandboxRoot)) {
    throw worktreeError("CEREBRAS_BLAST_SANDBOX_INVALID", "A controller-owned absolute sandboxRoot is required for worker tests.");
  }
  const normalized = normalizeBlastTestCommands(commands);
  const results = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const command = normalized[index];
    const environment = { ...testEnvironment(), ...commandCompatibilityEnvironment(command.argv) };
    // The qualified Windows helper temporarily grants and then restores exact
    // ACLs on worktree ancestors. Serialize those short local phases so two
    // candidates sharing the controller-state ancestors cannot race an ACL
    // snapshot/restore; provider inference remains fully concurrent.
    const sandbox = await withBlastSandboxLock(() => sandboxRunner({
      argv: command.argv,
      packet: {
        id: `cerebras-blast-test-${index + 1}`,
        kind: "read",
        allowedFiles: [],
        expectedArtifacts: [],
        budgets: { timeoutMs: command.timeoutMs },
      },
      worktree,
      cwd: worktree,
      sandboxRoot: path.join(sandboxRoot, `command-${index + 1}`),
      env: environment,
      environment,
      signal,
      networkIsolationMode: "offline",
      readOnlyPaths: ["."],
    }));
    const raw = sandbox.workerExit;
    const stdout = boundedOutput(raw.stdout, `cerebras-blast-test-${index + 1}-stdout`);
    const stderr = boundedOutput(raw.stderr, `cerebras-blast-test-${index + 1}-stderr`);
    results.push({
      argv: raw.argv,
      cwd: raw.cwd,
      commandIdentity: raw.commandIdentity,
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt,
      exitCode: raw.exitCode,
      signal: raw.signal,
      timedOut: raw.timedOut,
      canceled: raw.canceled,
      termination: raw.termination,
      stdout: stdout.text,
      stdoutSha256: stdout.sha256,
      stdoutRedacted: stdout.redacted,
      stdoutTruncated: stdout.truncated,
      stderr: stderr.text,
      stderrSha256: stderr.sha256,
      stderrRedacted: stderr.redacted,
      stderrTruncated: stderr.truncated,
      sandboxAttestation: {
        evidenceFile: sandbox.attestation.evidenceFile,
        jobKillOnClose: sandbox.attestation.jobKillOnClose,
        jobAssigned: sandbox.attestation.jobAssigned,
        jobDrained: sandbox.attestation.jobDrained,
        childIsAppContainer: sandbox.attestation.childIsAppContainer,
        childTokenRestricted: sandbox.attestation.childTokenRestricted,
        networkIsolationMode: sandbox.attestation.networkIsolationMode,
        sterileEnvironment: sandbox.attestation.sterileEnvironment,
        workingDirectoryInsideWorktree: sandbox.attestation.workingDirectoryInsideWorktree,
        reparseChecksPassed: sandbox.attestation.reparseChecksPassed,
        hardlinkChecksPassed: sandbox.attestation.hardlinkChecksPassed,
        aclsRestored: sandbox.attestation.aclsRestored,
      },
    });
    if (raw.exitCode !== 0 || raw.timedOut || raw.canceled) break;
  }
  return {
    passed: results.length === normalized.length && results.every((result) => result.exitCode === 0 && !result.timedOut && !result.canceled),
    commands: results,
  };
}

export async function renderBlastRepairContext(worktree, allowedFiles, testResult, { maximumChars = 40_000 } = {}) {
  const files = [];
  const root = path.resolve(worktree);
  for (const relative of normalizeBlastSourcePaths(allowedFiles)) {
    const target = assertInside(root, path.join(root, relative));
    try {
      await assertResolvedInside(root, target);
      const snapshot = await readStableRegularFile(target, {
        maximumBytes: CEREBRAS_BLAST_MAX_SOURCE_FILE_BYTES,
        requireSingleLink: true,
      });
      assertInside(root, snapshot.realPath);
      if (comparable(snapshot.realPath) !== comparable(target)) {
        throw worktreeError("CEREBRAS_BLAST_PATCH_UNSAFE", `Blast repair source resolves through an alias: ${relative}.`);
      }
      const text = snapshot.bytes.toString("utf8");
      assertCerebrasSourceContentAllowed(text, `cerebras-blast-repair:${relative}`);
      files.push({ path: relative, exists: true, text, sha256: sha256(snapshot.bytes) });
    } catch (error) {
      if (error?.code === "BOUNDED_LOCAL_FILE_UNREADABLE") files.push({ path: relative, exists: false, text: "[ABSENT]", sha256: "ABSENT" });
      else throw error;
    }
  }
  const source = renderBlastSourceCapsule({ files }, { maximumChars: Math.max(8_000, maximumChars - 12_000) });
  const failure = testResult.commands
    .filter((command) => command.exitCode !== 0 || command.timedOut || command.canceled)
    .map((command) => [
      `COMMAND: ${JSON.stringify(command.argv)}`,
      `EXIT: ${command.exitCode}`,
      `TIMED_OUT: ${Boolean(command.timedOut)}`,
      `CANCELED: ${Boolean(command.canceled)}`,
      `STDOUT_SHA256: ${command.stdoutSha256}`,
      `STDOUT_REDACTED: ${Boolean(command.stdoutRedacted)}`,
      `STDOUT_TRUNCATED: ${Boolean(command.stdoutTruncated)}`,
      `STDERR_SHA256: ${command.stderrSha256}`,
      `STDERR_REDACTED: ${Boolean(command.stderrRedacted)}`,
      `STDERR_TRUNCATED: ${Boolean(command.stderrTruncated)}`,
    ].join("\n"))
    .join("\n\n");
  return `${source.text}\n\nDETERMINISTIC TEST FAILURE:\n${failure}`.slice(0, maximumChars);
}
