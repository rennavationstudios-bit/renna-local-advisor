import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { FleetError } from "./errors.mjs";
import { validateLease } from "./schemas.mjs";
import { scopesOverlap } from "./scope.mjs";
import { atomicJson, commandIdentity, normalizeRelativePath, nowIso, readJson, sha256, stableJson } from "./util.mjs";

const CLAIM_LOCK_TTL_MS = 30_000;
const CLAIM_LOCK_WAIT_MS = 1_000;
const CLAIM_LOCK_BACKOFF_MS = 20;
const MAX_EXECUTION_WRITE_SCOPE = 256;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Readers such as health/list do not hold the scope lock while a worker slot
// is being created with exclusive open + write. Do not mistake that brief
// incomplete JSON for durable corruption; never delete or accept malformed data.
async function readWorkerLeaseJson(file) {
  const deadline=Date.now()+CLAIM_LOCK_WAIT_MS;
  for(;;) {
    try { return await readJson(file,null); }
    catch(error) {
      const remaining=deadline-Date.now();
      if(remaining<=0||!['INVALID_JSON','EACCES','EPERM'].includes(error?.code))throw error;
      await wait(Math.min(CLAIM_LOCK_BACKOFF_MS,remaining));
    }
  }
}

function claimError(code, message, details = {}) {
  return new FleetError(code, message, details);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw claimError("EXECUTION_CLAIM_INVALID", `${label} must be a plain object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw claimError("EXECUTION_CLAIM_INVALID", `${label} has malformed fields.`, { actual, expected });
  }
}

function text(value, label, { maximum = 4_096 } = {}) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw claimError("EXECUTION_CLAIM_INVALID", `${label} must be bounded non-empty text.`);
  }
  return value;
}

function ownerPid(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw claimError("EXECUTION_CLAIM_INVALID", `${label} must be a positive integer.`);
  return value;
}

function dates(acquiredAt, expiresAt, label) {
  const acquired = Date.parse(acquiredAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(acquired) || !Number.isFinite(expires) || expires <= acquired) {
    throw claimError("EXECUTION_CLAIM_INVALID", `${label} has invalid claim dates.`);
  }
}

function canonicalRepository(repository) {
  if (typeof repository !== "string" || !repository.trim()) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim requires one exact repository identity.");
  }
  // Fleet's Windows control plane and scope rules are case-insensitive. Keep
  // repository identity aligned with those scope semantics rather than trusting
  // an unnormalised spelling supplied by a caller.
  return path.resolve(repository).replace(/[\\/]+$/, "").toLowerCase();
}

function packetClaimContext(packet) {
  if (!packet || typeof packet !== "object" || typeof packet.id !== "string" || !packet.id) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim requires a validated packet identity.");
  }
  const repositoryId = canonicalRepository(packet.repository);
  const writeScope = packet.kind === "edit"
    ? [...new Set((packet.allowedFiles ?? []).map((entry) => normalizeRelativePath(entry).toLowerCase()))]
      .sort((left, right) => left.localeCompare(right))
    : [];
  if (packet.kind !== "read" && packet.kind !== "edit") {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim packet kind must be read or edit.");
  }
  if (packet.kind === "edit" && !writeScope.length) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Writable execution claims require an exact write scope.");
  }
  if (writeScope.length > MAX_EXECUTION_WRITE_SCOPE) {
    throw claimError("EXECUTION_CLAIM_INVALID", `Execution claim write scope exceeds ${MAX_EXECUTION_WRITE_SCOPE} entries.`);
  }
  return { packetId: packet.id, repositoryId, writeScope };
}

function claimTtl(ttlMs) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim TTL must be a positive integer.");
  }
  return ttlMs;
}

function isExpired(value) {
  return Date.parse(value?.expiresAt) <= Date.now();
}

function sameStringArray(first, second) {
  return Array.isArray(first) && Array.isArray(second)
    && first.length === second.length
    && first.every((value, index) => value === second[index]);
}

function validateScopeClaim(raw) {
  exactKeys(raw, [
    "claimId", "packetId", "workerId", "ownerId", "ownerPid", "repositoryId", "scopePath", "acquiredAt", "expiresAt",
  ], "scope claim");
  for (const key of ["claimId", "packetId", "workerId", "ownerId", "repositoryId", "scopePath", "acquiredAt", "expiresAt"]) {
    text(raw[key], `scope claim.${key}`);
  }
  ownerPid(raw.ownerPid, "scope claim.ownerPid");
  const scopePath = normalizeRelativePath(raw.scopePath).toLowerCase();
  if (scopePath !== raw.scopePath) throw claimError("EXECUTION_CLAIM_INVALID", "Scope claim path is not canonical.");
  dates(raw.acquiredAt, raw.expiresAt, "scope claim");
  return structuredClone(raw);
}

function validateClaimManifest(raw) {
  exactKeys(raw, [
    "claimId", "packetId", "workerId", "ownerId", "ownerPid", "repositoryId", "writeScope", "commandIdentity",
    "acquiredAt", "expiresAt", "workerLease", "scopeClaims",
  ], "execution claim");
  for (const key of ["claimId", "packetId", "workerId", "ownerId", "repositoryId", "commandIdentity", "acquiredAt", "expiresAt"]) {
    text(raw[key], `execution claim.${key}`);
  }
  ownerPid(raw.ownerPid, "execution claim.ownerPid");
  dates(raw.acquiredAt, raw.expiresAt, "execution claim");
  if (!Array.isArray(raw.writeScope) || raw.writeScope.length > MAX_EXECUTION_WRITE_SCOPE) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim writeScope must be a bounded array.");
  }
  const writeScope = raw.writeScope.map((entry) => normalizeRelativePath(entry).toLowerCase()).sort((left, right) => left.localeCompare(right));
  if (!sameStringArray(writeScope, raw.writeScope) || new Set(writeScope).size !== writeScope.length) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim writeScope is not canonical.");
  }
  exactKeys(raw.workerLease, ["leaseId", "slot"], "execution claim.workerLease");
  text(raw.workerLease.leaseId, "execution claim.workerLease.leaseId");
  if (!Number.isInteger(raw.workerLease.slot) || raw.workerLease.slot < 0) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim worker slot is invalid.");
  }
  if (!Array.isArray(raw.scopeClaims) || raw.scopeClaims.length !== writeScope.length) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim scope references do not match its scope.");
  }
  const scopeClaims = raw.scopeClaims.map((entry) => {
    exactKeys(entry, ["scopePath"], "execution claim.scopeClaims[]");
    return { scopePath: normalizeRelativePath(entry.scopePath).toLowerCase() };
  }).sort((left, right) => left.scopePath.localeCompare(right.scopePath));
  if (!sameStringArray(scopeClaims.map((entry) => entry.scopePath), writeScope)) {
    throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim scope references drifted from its scope.");
  }
  return structuredClone(raw);
}

function validateClaimLock(raw) {
  exactKeys(raw, ["ownerId", "ownerPid", "token", "acquiredAt", "expiresAt"], "execution claim lock");
  for (const key of ["ownerId", "token", "acquiredAt", "expiresAt"]) text(raw[key], `execution claim lock.${key}`);
  ownerPid(raw.ownerPid, "execution claim lock.ownerPid");
  dates(raw.acquiredAt, raw.expiresAt, "execution claim lock");
  return structuredClone(raw);
}

export class LeaseManager {
  constructor(root, { ownerId = `fleet-${process.pid}-${crypto.randomUUID()}` } = {}) {
    this.root = path.resolve(root, "leases");
    this.ownerId = ownerId;
  }

  file(workerId, slot = 0) {
    return path.join(this.root, `${workerId}.${slot}.json`);
  }

  claimRoot() {
    return path.join(this.root, "execution-claims");
  }

  claimFile(claimId) {
    return path.join(this.claimRoot(), "claims", `${claimId}.json`);
  }

  scopeFile(repositoryId, scopePath) {
    return path.join(this.claimRoot(), "scopes", `${sha256(`${repositoryId}\n${scopePath}`)}.json`);
  }

  scopeLockFile() {
    return path.join(this.claimRoot(), "scope-acquisition.lock.json");
  }

  async #readLease(file) {
    let raw;
    try {
      raw = await readWorkerLeaseJson(file);
    } catch (error) {
      throw claimError("EXECUTION_CLAIM_INVALID", "Worker lease state is malformed; refusing automatic recovery.", { file, cause: error?.code ?? error?.message });
    }
    if (raw === null) return null;
    try {
      return validateLease(raw);
    } catch (error) {
      throw claimError("EXECUTION_CLAIM_INVALID", "Worker lease state drifted; refusing automatic recovery.", { file, cause: error?.code ?? error?.message });
    }
  }

  async #readScopeClaim(file) {
    let raw;
    try {
      raw = await readJson(file, null);
    } catch (error) {
      throw claimError("EXECUTION_CLAIM_INVALID", "Scope claim state is malformed; refusing automatic recovery.", { file, cause: error?.code ?? error?.message });
    }
    if (raw === null) return null;
    try {
      return validateScopeClaim(raw);
    } catch (error) {
      if (error instanceof FleetError && error.code === "EXECUTION_CLAIM_INVALID") throw error;
      throw claimError("EXECUTION_CLAIM_INVALID", "Scope claim state drifted; refusing automatic recovery.", { file, cause: error?.code ?? error?.message });
    }
  }

  async #readClaimManifest(file) {
    let raw;
    try {
      raw = await readJson(file, null);
    } catch (error) {
      throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim manifest is malformed; refusing automatic recovery.", { file, cause: error?.code ?? error?.message });
    }
    if (raw === null) return null;
    try {
      return validateClaimManifest(raw);
    } catch (error) {
      if (error instanceof FleetError && error.code === "EXECUTION_CLAIM_INVALID") throw error;
      throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim manifest drifted; refusing automatic recovery.", { file, cause: error?.code ?? error?.message });
    }
  }

  async #renameExpired(file) {
    const stale = `${file}.expired.${process.pid}.${crypto.randomUUID()}`;
    try {
      await fsp.rename(file, stale);
      await fsp.rm(stale, { force: true });
      return true;
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes(error?.code)) return false;
      throw error;
    }
  }

  async #acquireWorkerLease(worker, packetId, argv, { ttlMs = 30 * 60_000 } = {}) {
    await fsp.mkdir(this.root, { recursive: true });
    for (let slot = 0; slot < worker.maxConcurrentPackets; slot += 1) {
      const file = this.file(worker.id, slot);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const acquiredAt = nowIso();
        const lease = validateLease({
          leaseId: crypto.randomUUID(), workerId: worker.id, packetId, ownerId: this.ownerId,
          ownerPid: process.pid, commandIdentity: commandIdentity(argv), acquiredAt,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(), slot,
        });
        try {
          const handle = await fsp.open(file, "wx");
          try { await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8"); }
          finally { await handle.close(); }
          return { ...lease, file };
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const existing = await this.#readLease(file);
          if (!existing || !isExpired(existing)) break;
          await this.#renameExpired(file);
        }
      }
    }
    throw new FleetError("WORKER_LEASE_BUSY", `All slots are leased for ${worker.id}.`);
  }

  async #releaseWorkerLease(lease) {
    const current = await this.#readLease(lease.file);
    if (!current) return false;
    if (current.leaseId !== lease.leaseId || current.ownerId !== this.ownerId || current.commandIdentity !== lease.commandIdentity) {
      throw new FleetError("LEASE_IDENTITY_MISMATCH", "Refusing to release a lease owned by another process.");
    }
    await fsp.rm(lease.file, { force: true });
    return true;
  }

  async #acquireScopeLock({ waitMs = CLAIM_LOCK_WAIT_MS } = {}) {
    const file = this.scopeLockFile();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const deadline = Date.now() + waitMs;
    while (true) {
      const acquiredAt = nowIso();
      const lock = {
        ownerId: this.ownerId,
        ownerPid: process.pid,
        token: crypto.randomUUID(),
        acquiredAt,
        expiresAt: new Date(Date.now() + CLAIM_LOCK_TTL_MS).toISOString(),
      };
      try {
        const handle = await fsp.open(file, "wx");
        try { await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8"); }
        finally { await handle.close(); }
        return { ...lock, file };
      } catch (error) {
        if (!["EEXIST", "EACCES", "EPERM"].includes(error?.code)) throw error;
        let existing;
        try {
          const raw = await readJson(file, null);
          if (raw === null) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              throw new FleetError("EXECUTION_CLAIM_BUSY", "Another controller is atomically evaluating execution write scopes.");
            }
            await wait(Math.min(CLAIM_LOCK_BACKOFF_MS, remaining));
            continue;
          }
          existing = validateClaimLock(raw);
        }
        catch (readError) {
          if (readError instanceof FleetError && readError.code === "EXECUTION_CLAIM_BUSY") throw readError;
          // Windows may briefly report access denied while another process is
          // creating or deleting the lock, and a concurrent reader can observe
          // the just-created file before its bounded JSON body is complete.
          // Retry only inside the fixed wait budget. Stable malformed state
          // still fails closed once that budget is exhausted.
          const remaining = deadline - Date.now();
          if (remaining > 0 && (["ENOENT", "EACCES", "EPERM", "INVALID_JSON"].includes(readError?.code) || readError instanceof SyntaxError)) {
            await wait(Math.min(CLAIM_LOCK_BACKOFF_MS, remaining));
            continue;
          }
          throw claimError("EXECUTION_CLAIM_INVALID", "Scope acquisition lock is malformed; refusing automatic recovery.", { file, cause: readError?.code ?? readError?.message });
        }
        if (isExpired(existing)) {
          const renamed = await this.#renameExpired(file);
          if (!renamed) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              throw new FleetError("EXECUTION_CLAIM_BUSY", "Another controller is atomically evaluating execution write scopes.");
            }
            await wait(Math.min(CLAIM_LOCK_BACKOFF_MS, remaining));
          }
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new FleetError("EXECUTION_CLAIM_BUSY", "Another controller is atomically evaluating execution write scopes.");
        }
        // The global lock protects only the small all-or-nothing scope-file
        // mutation. Retry that transient contention with a bounded backoff;
        // semantic worker-slot and write-scope conflicts are raised from the
        // critical section and deliberately are never retried here.
        await wait(Math.min(CLAIM_LOCK_BACKOFF_MS, remaining));
      }
    }
  }

  async #releaseScopeLock(lock) {
    let current;
    try { current = validateClaimLock(await readJson(lock.file)); }
    catch (error) {
      throw claimError("EXECUTION_CLAIM_LOCK_LOST", "Scope acquisition lock disappeared or drifted before release.", { file: lock.file, cause: error?.code ?? error?.message });
    }
    if (current.ownerId !== this.ownerId || current.ownerPid !== process.pid || current.token !== lock.token) {
      throw claimError("EXECUTION_CLAIM_LOCK_LOST", "Scope acquisition lock ownership changed before release.", { file: lock.file });
    }
    await fsp.rm(lock.file, { force: false });
  }

  async #withScopeLock(callback) {
    const lock = await this.#acquireScopeLock();
    try { return await callback(); }
    finally { await this.#releaseScopeLock(lock); }
  }

  async #scopeEntries() {
    const root = path.join(this.claimRoot(), "scopes");
    await fsp.mkdir(root, { recursive: true });
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const scopes = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        if (entry.isSymbolicLink()) throw claimError("EXECUTION_CLAIM_INVALID", "Scope claim directory contains a reparse entry.", { entry: entry.name });
        continue;
      }
      const file = path.join(root, entry.name);
      const claim = await this.#readScopeClaim(file);
      if (!claim) continue;
      if (path.basename(file) !== path.basename(this.scopeFile(claim.repositoryId, claim.scopePath))) {
        throw claimError("EXECUTION_CLAIM_INVALID", "Scope claim filename does not match its exact scope identity.", { file });
      }
      scopes.push({ file, claim });
    }
    return scopes;
  }

  async #cleanupExpiredScopes() {
    const removed = [];
    for (const entry of await this.#scopeEntries()) {
      if (isExpired(entry.claim) && await this.#renameExpired(entry.file)) removed.push(entry.claim);
    }
    return removed;
  }

  async #writeNewJson(file, value) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const handle = await fsp.open(file, "wx");
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }
    finally { await handle.close(); }
  }

  #claimHandle(manifest) {
    return {
      ...structuredClone(manifest),
      file: this.claimFile(manifest.claimId),
      workerLease: {
        ...manifest.workerLease,
        workerId: manifest.workerId,
        packetId: manifest.packetId,
        ownerId: manifest.ownerId,
        ownerPid: manifest.ownerPid,
        commandIdentity: manifest.commandIdentity,
        acquiredAt: manifest.acquiredAt,
        expiresAt: manifest.expiresAt,
        file: this.file(manifest.workerId, manifest.workerLease.slot),
      },
      scopeClaims: manifest.scopeClaims.map(({ scopePath }) => ({
        scopePath,
        file: this.scopeFile(manifest.repositoryId, scopePath),
      })),
      adopted: false,
      released: false,
    };
  }

  async #claimSnapshot(handle, context = null) {
    if (!handle || typeof handle !== "object" || typeof handle.claimId !== "string") {
      throw claimError("EXECUTION_CLAIM_IDENTITY_MISMATCH", "Execution claim handle is invalid.");
    }
    const file = this.claimFile(handle.claimId);
    if (handle.file && path.resolve(handle.file) !== file) {
      throw claimError("EXECUTION_CLAIM_IDENTITY_MISMATCH", "Execution claim handle points outside the controller-owned claim root.");
    }
    const manifest = await this.#readClaimManifest(file);
    if (!manifest || isExpired(manifest)) {
      throw claimError("EXECUTION_CLAIM_EXPIRED", "Execution claim no longer has a live durable manifest.", { claimId: handle.claimId });
    }
    if (manifest.claimId !== handle.claimId || manifest.ownerId !== this.ownerId || manifest.ownerPid !== process.pid
      || manifest.packetId !== handle.packetId || manifest.workerId !== handle.workerId || manifest.commandIdentity !== handle.commandIdentity) {
      throw claimError("EXECUTION_CLAIM_IDENTITY_MISMATCH", "Execution claim manifest identity does not match this controller.", { claimId: handle.claimId });
    }
    if (context && (manifest.packetId !== context.packetId || manifest.repositoryId !== context.repositoryId || !sameStringArray(manifest.writeScope, context.writeScope))) {
      throw claimError("EXECUTION_CLAIM_IDENTITY_MISMATCH", "Execution claim packet or write scope identity does not match dispatch.", { claimId: handle.claimId });
    }
    const workerLease = await this.#readLease(this.file(manifest.workerId, manifest.workerLease.slot));
    if (!workerLease || workerLease.leaseId !== manifest.workerLease.leaseId || workerLease.packetId !== manifest.packetId
      || workerLease.workerId !== manifest.workerId || workerLease.ownerId !== manifest.ownerId || workerLease.ownerPid !== manifest.ownerPid
      || workerLease.commandIdentity !== manifest.commandIdentity || workerLease.expiresAt !== manifest.expiresAt) {
      throw claimError("EXECUTION_CLAIM_IDENTITY_MISMATCH", "Execution claim worker capacity record drifted.", { claimId: handle.claimId });
    }
    const scopes = [];
    for (const { scopePath } of manifest.scopeClaims) {
      const scopeFile = this.scopeFile(manifest.repositoryId, scopePath);
      const scope = await this.#readScopeClaim(scopeFile);
      if (!scope || isExpired(scope) || scope.claimId !== manifest.claimId || scope.packetId !== manifest.packetId
        || scope.workerId !== manifest.workerId || scope.ownerId !== manifest.ownerId || scope.ownerPid !== manifest.ownerPid
        || scope.repositoryId !== manifest.repositoryId || scope.scopePath !== scopePath || scope.expiresAt !== manifest.expiresAt) {
        throw claimError("EXECUTION_CLAIM_IDENTITY_MISMATCH", "Execution claim write-scope record drifted.", { claimId: handle.claimId, scopePath });
      }
      scopes.push({ file: scopeFile, scope });
    }
    return { manifest, file, workerLease: { ...workerLease, file: this.file(manifest.workerId, manifest.workerLease.slot) }, scopes };
  }

  async acquire(worker, packetId, argv, options = {}) {
    return this.#acquireWorkerLease(worker, packetId, argv, options);
  }

  /**
   * Atomically acquires Fleet capacity and, for writers, repository-scoped
   * case-insensitive ancestry claims. It is intentionally the single shared
   * primitive used by Fleet execution for worker capacity and write scope.
   */
  async acquireExecutionClaim(worker, packet, argv, { ttlMs = 30 * 60_000 } = {}) {
    const context = packetClaimContext(packet);
    const validatedTtlMs = claimTtl(ttlMs);
    if (!worker || (packet.preferredWorkerId && worker.id !== packet.preferredWorkerId)) {
      throw claimError("EXECUTION_CLAIM_IDENTITY_MISMATCH", "Execution claim worker does not match the packet's fixed route.");
    }
    if (!Number.isInteger(worker.maxConcurrentPackets) || worker.maxConcurrentPackets < 1) {
      throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim worker has no usable capacity.");
    }
    const identity = commandIdentity(argv);
    const claimId = crypto.randomUUID();
    return this.#withScopeLock(async () => {
      const acquiredScopes = [];
      let workerLease = null;
      let manifestFile = null;
      try {
        const existing = await this.#scopeEntries();
        for (const entry of existing) {
          if (isExpired(entry.claim)) {
            await this.#renameExpired(entry.file);
            continue;
          }
          if (entry.claim.repositoryId === context.repositoryId && scopesOverlap(context.writeScope, [entry.claim.scopePath])) {
            throw new FleetError("EXECUTION_CLAIM_SCOPE_BUSY", "An active Fleet execution claim owns an overlapping repository write scope.", {
              packetId: entry.claim.packetId,
              workerId: entry.claim.workerId,
              repositoryId: context.repositoryId,
              requestedWriteScope: context.writeScope,
              activeWriteScope: entry.claim.scopePath,
            });
          }
        }
        const acquiredAt = nowIso();
        const expiresAt = new Date(Date.now() + validatedTtlMs).toISOString();
        for (const scopePath of context.writeScope) {
          const scope = {
            claimId,
            packetId: context.packetId,
            workerId: worker.id,
            ownerId: this.ownerId,
            ownerPid: process.pid,
            repositoryId: context.repositoryId,
            scopePath,
            acquiredAt,
            expiresAt,
          };
          const file = this.scopeFile(context.repositoryId, scopePath);
          await this.#writeNewJson(file, scope);
          acquiredScopes.push({ file, scope });
        }
        workerLease = await this.#acquireWorkerLease(worker, context.packetId, argv, { ttlMs: validatedTtlMs });
        // Use one expiry for every durable record. The worker lease uses a
        // fresh timestamp internally, so recreate its expiry only when it is
        // still strictly after its own acquisition timestamp.
        const sharedExpiresAt = Date.parse(expiresAt) > Date.parse(workerLease.acquiredAt)
          ? expiresAt
          : workerLease.expiresAt;
        if (workerLease.expiresAt !== sharedExpiresAt) {
          workerLease = { ...workerLease, expiresAt: sharedExpiresAt };
          await atomicJson(workerLease.file, (() => { const { file, ...value } = workerLease; return value; })());
        }
        for (const entry of acquiredScopes) {
          if (entry.scope.expiresAt !== workerLease.expiresAt) {
            entry.scope = { ...entry.scope, expiresAt: workerLease.expiresAt };
            await atomicJson(entry.file, entry.scope);
          }
        }
        const manifest = {
          claimId,
          packetId: context.packetId,
          workerId: worker.id,
          ownerId: this.ownerId,
          ownerPid: process.pid,
          repositoryId: context.repositoryId,
          writeScope: context.writeScope,
          commandIdentity: identity,
          acquiredAt: workerLease.acquiredAt,
          expiresAt: workerLease.expiresAt,
          workerLease: { leaseId: workerLease.leaseId, slot: workerLease.slot },
          scopeClaims: acquiredScopes.map((entry) => ({ scopePath: entry.scope.scopePath })),
        };
        manifestFile = this.claimFile(claimId);
        await this.#writeNewJson(manifestFile, manifest);
        return this.#claimHandle(manifest);
      } catch (error) {
        if (manifestFile) await fsp.rm(manifestFile, { force: true }).catch(() => {});
        if (workerLease) await this.#releaseWorkerLease(workerLease).catch(() => {});
        for (const entry of acquiredScopes.reverse()) {
          const current = await this.#readScopeClaim(entry.file).catch(() => null);
          if (current?.claimId === claimId && current.ownerId === this.ownerId) await fsp.rm(entry.file, { force: true }).catch(() => {});
        }
        throw error;
      }
    });
  }

  /**
   * Renews one active controller-owned execution claim as a single locked
   * logical transaction. Every durable record receives the same expiry, and
   * any missing, expired, or drifted record refuses renewal rather than
   * allowing a controller to reclaim someone else's capacity or write scope.
   */
  async renewExecutionClaim(handle, { ttlMs = 30 * 60_000 } = {}) {
    if (handle?.released) {
      throw claimError("EXECUTION_CLAIM_IDENTITY_MISMATCH", "Released execution claims cannot be renewed.");
    }
    const validatedTtlMs = claimTtl(ttlMs);
    return this.#withScopeLock(async () => {
      const snapshot = await this.#claimSnapshot(handle);
      const expiresAt = new Date(Date.now() + validatedTtlMs).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(snapshot.manifest.acquiredAt)) {
        throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim renewal expiry is not after its acquisition.");
      }
      const nextWorkerLease = { ...snapshot.workerLease, expiresAt };
      const nextScopes = snapshot.scopes.map(({ file, scope }) => ({ file, previous: scope, next: { ...scope, expiresAt } }));
      const nextManifest = { ...snapshot.manifest, expiresAt };
      const records = [
        ...nextScopes,
        { file: nextWorkerLease.file, previous: snapshot.workerLease, next: nextWorkerLease },
        { file: snapshot.file, previous: snapshot.manifest, next: nextManifest },
      ];
      const written = [];
      try {
        for (const record of records) {
          const { file, ...value } = record.next;
          await atomicJson(record.file, value);
          written.push(record);
        }
      } catch (error) {
        const rollbackFailures = [];
        for (const record of written.reverse()) {
          try {
            const { file, ...value } = record.previous;
            await atomicJson(record.file, value);
          } catch (rollbackError) {
            rollbackFailures.push({ file: record.file, cause: rollbackError?.code ?? rollbackError?.message });
          }
        }
        if (rollbackFailures.length) {
          throw claimError("EXECUTION_CLAIM_DRIFT", "Execution claim renewal could not be rolled back safely.", {
            claimId: handle.claimId,
            cause: error?.code ?? error?.message,
            rollbackFailures,
          });
        }
        throw claimError("EXECUTION_CLAIM_RENEWAL_FAILED", "Execution claim renewal failed without changing durable ownership.", {
          claimId: handle.claimId,
          cause: error?.code ?? error?.message,
        });
      }
      handle.expiresAt = expiresAt;
      handle.workerLease.expiresAt = expiresAt;
      return handle;
    });
  }

  async releaseExecutionClaim(handle) {
    if (handle?.released) return false;
    return this.#withScopeLock(async () => {
      const snapshot = await this.#claimSnapshot(handle);
      for (const entry of snapshot.scopes) await fsp.rm(entry.file, { force: false });
      await this.#releaseWorkerLease(snapshot.workerLease);
      await fsp.rm(snapshot.file, { force: false });
      handle.released = true;
      return true;
    });
  }

  async release(lease) {
    return this.#releaseWorkerLease(lease);
  }

  async #recoveryClaimSnapshot(file, manifest) {
    if (path.resolve(file) !== this.claimFile(manifest.claimId)) {
      throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim filename does not match its claim identity.", { file });
    }
    const workerFile = this.file(manifest.workerId, manifest.workerLease.slot);
    const workerLease = await this.#readLease(workerFile);
    if (!workerLease || workerLease.leaseId !== manifest.workerLease.leaseId || workerLease.packetId !== manifest.packetId
      || workerLease.workerId !== manifest.workerId || workerLease.ownerId !== manifest.ownerId || workerLease.ownerPid !== manifest.ownerPid
      || workerLease.commandIdentity !== manifest.commandIdentity || workerLease.acquiredAt !== manifest.acquiredAt
      || workerLease.expiresAt !== manifest.expiresAt) {
      throw claimError("EXECUTION_CLAIM_INVALID", "Interrupted execution claim worker capacity record drifted; refusing restart recovery.", {
        claimId: manifest.claimId,
      });
    }
    const scopes = [];
    for (const { scopePath } of manifest.scopeClaims) {
      const scopeFile = this.scopeFile(manifest.repositoryId, scopePath);
      const scope = await this.#readScopeClaim(scopeFile);
      if (!scope || scope.claimId !== manifest.claimId || scope.packetId !== manifest.packetId
        || scope.workerId !== manifest.workerId || scope.ownerId !== manifest.ownerId || scope.ownerPid !== manifest.ownerPid
        || scope.repositoryId !== manifest.repositoryId || scope.scopePath !== scopePath
        || scope.expiresAt !== manifest.expiresAt) {
        throw claimError("EXECUTION_CLAIM_INVALID", "Interrupted execution claim write-scope record drifted; refusing restart recovery.", {
          claimId: manifest.claimId, scopePath,
        });
      }
      scopes.push({ type: "scope", file: scopeFile, value: scope });
    }
    return {
      manifest: { type: "manifest", file, value: manifest },
      workerLease: { type: "worker", file: workerFile, value: workerLease },
      scopes,
    };
  }

  async #rereadRecoveryRecord(record) {
    if (record.type === "scope") return this.#readScopeClaim(record.file);
    if (record.type === "worker") return this.#readLease(record.file);
    if (record.type === "manifest") return this.#readClaimManifest(record.file);
    throw claimError("EXECUTION_CLAIM_INVALID", "Restart recovery encountered an unknown claim record type.");
  }

  /**
   * Retires one interrupted claim only during explicit controller restart
   * recovery. The caller's quarantine callback runs under the shared claim
   * lock after the complete bundle validates and before any ownership record
   * is renamed out of service. Normal acquisition never reaps live claims.
   */
  async recoverInterruptedExecutionClaim(packetId, quarantine) {
    text(packetId, "restart recovery packetId");
    if (typeof quarantine !== "function") {
      throw claimError("EXECUTION_CLAIM_INVALID", "Restart recovery requires an explicit receipt quarantine callback.");
    }
    return this.#withScopeLock(async () => {
      const manifestsRoot = path.join(this.claimRoot(), "claims");
      await fsp.mkdir(manifestsRoot, { recursive: true });
      const matches = [];
      for (const entry of await fsp.readdir(manifestsRoot, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim directory contains a reparse entry.", { entry: entry.name });
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(manifestsRoot, entry.name);
        const manifest = await this.#readClaimManifest(file);
        if (manifest?.packetId === packetId) matches.push(await this.#recoveryClaimSnapshot(file, manifest));
      }
      if (matches.length > 1) {
        throw claimError("EXECUTION_CLAIM_INVALID", "Restart recovery found duplicate execution claims for one packet.", { packetId });
      }
      const receipt = await quarantine();
      if (matches.length === 0) return { receipt, recoveredClaim: null };

      const snapshot = matches[0];
      const records = [...snapshot.scopes, snapshot.workerLease, snapshot.manifest];
      for (const record of records) {
        const current = await this.#rereadRecoveryRecord(record);
        if (!current || stableJson(current) !== stableJson(record.value)) {
          throw claimError("EXECUTION_CLAIM_INVALID", "Restart recovery claim identity changed after receipt quarantine; refusing cleanup.", {
            packetId, claimId: snapshot.manifest.value.claimId, recordType: record.type,
          });
        }
      }

      const token = crypto.randomUUID();
      const renamed = [];
      try {
        for (const record of records) {
          const tombstone = `${record.file}.recovered.${process.pid}.${token}`;
          await fsp.rename(record.file, tombstone);
          renamed.push({ ...record, tombstone });
        }
      } catch (error) {
        const rollbackFailures = [];
        for (const record of renamed.reverse()) {
          try { await fsp.rename(record.tombstone, record.file); }
          catch (rollbackError) { rollbackFailures.push({ recordType: record.type, cause: rollbackError?.code ?? rollbackError?.message }); }
        }
        throw claimError("EXECUTION_CLAIM_DRIFT", "Restart recovery could not retire the exact interrupted claim bundle.", {
          packetId, claimId: snapshot.manifest.value.claimId, cause: error?.code ?? error?.message, rollbackFailures,
        });
      }
      await Promise.all(renamed.map((record) => fsp.rm(record.tombstone, { force: true }).catch(() => {})));
      return {
        receipt,
        recoveredClaim: {
          claimId: snapshot.manifest.value.claimId,
          packetId,
          workerId: snapshot.manifest.value.workerId,
          scopeCount: snapshot.scopes.length,
        },
      };
    });
  }

  async list() {
    await fsp.mkdir(this.root, { recursive: true });
    const entries = await fsp.readdir(this.root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(this.root, entry.name));
    return Promise.all(files.map((file) => this.#readLease(file)));
  }

  async recoverExpired() {
    const removed = [];
    await this.#withScopeLock(async () => {
      await this.#cleanupExpiredScopes();
      const manifestsRoot = path.join(this.claimRoot(), "claims");
      await fsp.mkdir(manifestsRoot, { recursive: true });
      for (const entry of await fsp.readdir(manifestsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          if (entry.isSymbolicLink()) throw claimError("EXECUTION_CLAIM_INVALID", "Execution claim directory contains a reparse entry.", { entry: entry.name });
          continue;
        }
        const file = path.join(manifestsRoot, entry.name);
        const manifest = await this.#readClaimManifest(file);
        if (manifest && isExpired(manifest)) await this.#renameExpired(file);
      }
      for (const lease of await this.list()) {
        if (lease && isExpired(lease)) {
          const file = this.file(lease.workerId, lease.slot ?? 0);
          const current = await this.#readLease(file);
          if (current?.leaseId === lease.leaseId && isExpired(current) && await this.#renameExpired(file)) removed.push(lease);
        }
      }
    });
    return removed;
  }
}
