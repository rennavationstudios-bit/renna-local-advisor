import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { FleetError } from "./errors.mjs";
import { validateReceipt } from "./schemas.mjs";
import { transitionState } from "./state-machine.mjs";
import { appendJsonl, atomicJson, ensureDir, nowIso, readJson, sha256, stableJson } from "./util.mjs";

export class ReceiptStore {
  constructor(root) {
    this.root = path.resolve(root);
  }

  paths(packetId) {
    const directory = path.join(this.root, "receipts", packetId);
    return {
      directory,
      events: path.join(directory, "events.jsonl"),
      latest: path.join(directory, "latest.json"),
      claim: path.join(directory, "CLAIM"),
      evidence: path.join(directory, "evidence"),
    };
  }

  async init() {
    for (const name of ["receipts", "leases", "quarantine", "worktrees", "artifacts", "queue"]) {
      await ensureDir(path.join(this.root, name));
    }
  }

  async create(packet, details = {}) {
    const paths = this.paths(packet.id);
    await ensureDir(paths.directory);
    try {
      const claim = await fsp.open(paths.claim, "wx");
      try { await claim.writeFile(`${JSON.stringify({ packetId: packet.id, ownerPid: process.pid, claimedAt: nowIso() })}\n`, "utf8"); }
      finally { await claim.close(); }
    } catch (error) {
      if (error?.code === "EEXIST") throw new FleetError("RECEIPT_EXISTS", `Receipt already exists for ${packet.id}.`);
      throw error;
    }
    const receipt = validateReceipt({
      ...details,
      schemaVersion: 1,
      packetId: packet.id,
      state: "PLANNED",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      packetHash: sha256(stableJson(packet)),
      integrationAuthorized: false,
    });
    await appendJsonl(paths.events, { sequence: 1, type: "STATE", at: receipt.updatedAt, state: receipt.state, details });
    await atomicJson(paths.latest, receipt);
    return receipt;
  }

  async load(packetId) {
    return validateReceipt(await readJson(this.paths(packetId).latest));
  }

  async transition(packetId, next, details = {}) {
    const paths = this.paths(packetId);
    const receipt = await this.load(packetId);
    transitionState(receipt.state, next);
    const events = await this.events(packetId);
    const immutable = {
      schemaVersion: receipt.schemaVersion, packetId: receipt.packetId,
      createdAt: receipt.createdAt, packetHash: receipt.packetHash,
    };
    Object.assign(receipt, details);
    Object.assign(receipt, immutable);
    receipt.state = next;
    receipt.updatedAt = nowIso();
    receipt.integrationAuthorized = false;
    validateReceipt(receipt);
    await appendJsonl(paths.events, { sequence: events.length + 1, type: "STATE", at: receipt.updatedAt, state: next, details });
    await atomicJson(paths.latest, receipt);
    return receipt;
  }

  async record(packetId, type, details = {}) {
    const paths = this.paths(packetId);
    const events = await this.events(packetId);
    const event = { sequence: events.length + 1, type, at: nowIso(), details };
    await appendJsonl(paths.events, event);
    return event;
  }

  async evidence(packetId, name, value) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new FleetError("INVALID_EVIDENCE_NAME", `Invalid evidence name: ${name}`);
    const paths = this.paths(packetId);
    await ensureDir(paths.evidence);
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const hash = sha256(buffer);
    const file = path.join(paths.evidence, `${name}.${hash}.evidence`);
    await fsp.writeFile(file, buffer, { flag: "wx" }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    await this.record(packetId, "EVIDENCE", { name, file, sha256: hash, bytes: buffer.length });
    return { name, file, sha256: hash, bytes: buffer.length };
  }

  async events(packetId) {
    try {
      const content = await fsp.readFile(this.paths(packetId).events, "utf8");
      return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async list() {
    await this.init();
    const entries = await fsp.readdir(path.join(this.root, "receipts"), { withFileTypes: true });
    const receipts = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      try { receipts.push(await this.load(entry.name)); } catch { /* incomplete receipt remains evidence */ }
    }
    return receipts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async quarantine(packetId, reason, details = {}) {
    const receipt = await this.load(packetId);
    if (receipt.state !== "BLOCKED") await this.transition(packetId, "BLOCKED", { failure: { reason, ...details } });
    const quarantined = await this.transition(packetId, "QUARANTINED", { quarantine: { at: nowIso(), reason, ...details } });
    await atomicJson(path.join(this.root, "quarantine", `${packetId}.json`), quarantined);
    return quarantined;
  }
}
