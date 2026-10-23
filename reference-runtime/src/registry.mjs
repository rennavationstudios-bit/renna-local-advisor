import path from "node:path";
import { FleetError } from "./errors.mjs";
import { validateRegistry, validateWorker } from "./schemas.mjs";
import { atomicJson, readJson } from "./util.mjs";

export class WorkerRegistry {
  constructor(data, { file = null } = {}) {
    this.data = validateRegistry(data);
    this.file = file ? path.resolve(file) : null;
  }

  static async load(file) {
    return new WorkerRegistry(await readJson(file), { file });
  }

  list() {
    return structuredClone(this.data.workers);
  }

  get(workerId) {
    return this.data.workers.find((worker) => worker.id === workerId) ?? null;
  }

  isEligible(worker, packet, activeCounts = new Map()) {
    if (!worker || worker.status !== "verified" || worker.adapter === "disabled") return false;
    if (worker.explicitSelectionRequired === true && packet.preferredWorkerId !== worker.id) return false;
    if ((activeCounts.get(worker.id) ?? 0) >= worker.maxConcurrentPackets) return false;
    if (packet.routingClass && !(worker.routeClasses ?? []).includes(packet.routingClass)) return false;
    return packet.requiredCapabilities.every((capability) => worker.capabilities.includes(capability));
  }

  assertFleetCapacity(packet) {
    const policy = this.data.capacityPolicy;
    if (packet.resourceIntent === "launch-additional-large-model" && policy?.allowAdditionalLargeModelLaunch === false) {
      throw new FleetError("FLEET_CAPACITY_GUARD", "The registered production large-model services already consume the authorized resident-model capacity; an additional large-model launch is prohibited.", {
        residentLargeModelWorkerIds: policy.residentLargeModelWorkerIds,
        maxResidentLargeModels: policy.maxResidentLargeModels,
      });
    }
  }

  select(packet, activeCounts = new Map()) {
    this.assertFleetCapacity(packet);
    const candidates = this.data.workers.filter((worker) => this.isEligible(worker, packet, activeCounts));
    if (packet.preferredWorkerId) {
      const preferred = candidates.find((worker) => worker.id === packet.preferredWorkerId);
      if (preferred) return structuredClone(preferred);
      const configured = this.get(packet.preferredWorkerId);
      throw new FleetError("WORKER_UNAVAILABLE", `Preferred worker ${packet.preferredWorkerId} is unavailable; provider retry and fallback belong to LiteLLM.`, {
        configuredStatus: configured?.status ?? "missing",
      });
    }
    if (!candidates.length) throw new FleetError("NO_COMPATIBLE_WORKER", `No verified worker can run packet ${packet.id}.`);
    candidates.sort((a, b) =>
      (activeCounts.get(a.id) ?? 0) - (activeCounts.get(b.id) ?? 0) ||
      (b.schedulingPriority ?? 0) - (a.schedulingPriority ?? 0) ||
      a.id.localeCompare(b.id));
    return structuredClone(candidates[0]);
  }

  register(rawWorker) {
    const worker = validateWorker(rawWorker);
    if (this.get(worker.id)) throw new FleetError("DUPLICATE_WORKER", `Worker ${worker.id} already exists.`);
    if (worker.status === "verified") throw new FleetError("CANARY_REQUIRED", "New workers must be registered pending or disabled before verification.");
    this.data.workers.push(worker);
    this.data.workers.sort((a, b) => a.id.localeCompare(b.id));
    this.data.revision = `${this.data.revision}+register-${worker.id}`;
    return structuredClone(worker);
  }

  disable(workerId) {
    const worker = this.get(workerId);
    if (!worker) throw new FleetError("WORKER_NOT_FOUND", `Worker ${workerId} is not registered.`);
    worker.status = "disabled";
    worker.adapter = "disabled";
    worker.maxConcurrentPackets = 0;
    this.data.revision = `${this.data.revision}+disable-${worker.id}`;
    return structuredClone(worker);
  }

  async save() {
    if (!this.file) throw new FleetError("REGISTRY_READ_ONLY", "Registry has no writable file path.");
    validateRegistry(this.data);
    await atomicJson(this.file, this.data);
  }
}
