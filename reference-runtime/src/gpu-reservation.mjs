import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const failure = (code, message) => Object.assign(new Error(message), { code });
export async function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    // Permission/unknown errors cannot establish death.
    return error.code !== "ESRCH";
  }
}

// No automatic stale recovery: a dead coordinator may leave a live detached GPU
// child. Partial publication and malformed ownership always reserve the GPU.
export class DirectoryLease {
  constructor({ directory, ownerKind = "evie", exists = processExists }) {
    this.directory = path.resolve(directory);
    this.ownerFile = path.join(this.directory, "owner.json");
    this.ownerKind = ownerKind;
    this.exists = exists;
    this.ownerId = crypto.randomUUID();
    this.pending = Promise.resolve();
  }
  serial(action) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  async status() {
    try { return JSON.parse(await fsp.readFile(this.ownerFile, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { await fsp.stat(this.directory); return { publication_pending: true }; }
      catch (missing) { if (missing.code === "ENOENT") return null; throw missing; }
    }
  }
  async write(owner) {
    const temporary = `${this.ownerFile}.${this.ownerId}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await fsp.rename(temporary, this.ownerFile);
  }
  async assertOwned() {
    const owner = await this.status();
    if (!owner || owner.owner_id !== this.ownerId) throw failure("LEASE_NOT_OWNED", "GPU reservation is not owned by this controller");
    return owner;
  }
  acquire(metadata = {}) {
    return this.serial(async () => {
      await fsp.mkdir(path.dirname(this.directory), { recursive: true });
      try { await fsp.mkdir(this.directory); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await this.status();
        if (owner?.owner_id === this.ownerId) return owner;
        throw failure("GPU_BUSY", "GPU reservation exists; verified recovery is required for abandoned reservations");
      }
      const owner = { ...metadata, schema_version: 2, owner_kind: this.ownerKind, owner_id: this.ownerId, host_pid: process.pid, acquired_utc: new Date().toISOString(), child_pid: null };
      await this.write(owner);
      return owner;
    });
  }
  registerChild(pid) {
    return this.serial(async () => {
      if (!Number.isInteger(pid) || pid < 1) throw failure("INVALID_CHILD_PID", "A valid child PID is required");
      const owner = await this.assertOwned();
      if (owner.child_pid && owner.child_pid !== pid) throw failure("LEASE_CHILD_MISMATCH", "Reservation already has a different child");
      await this.write({ ...owner, child_pid: pid });
    });
  }
  release() {
    return this.serial(async () => {
      const owner = await this.assertOwned();
      if (owner.child_pid && await this.exists(owner.child_pid)) throw failure("GPU_CHILD_ALIVE", "Cannot release reservation before confirmed child exit");
      await fsp.unlink(this.ownerFile);
      await fsp.rmdir(this.directory);
    });
  }
  // Caller must verify the exact process/runtime receipt before transferring a
  // persisted token across CLI invocations. Never adopt solely by PID or port.
  static async resume({ directory, ownerId, childPid, verifyChild, exists }) {
    const lease = new DirectoryLease({ directory, exists });
    lease.ownerId = ownerId;
    const owner = await lease.assertOwned();
    if (!Number.isInteger(childPid) || owner.child_pid !== childPid || typeof verifyChild !== "function" || await verifyChild(childPid) !== true) throw failure("LEASE_TRANSFER_DENIED", "Exact owned child verification is required");
    return lease;
  }
}
