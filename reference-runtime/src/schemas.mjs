import path from "node:path";
import { FleetError } from "./errors.mjs";
import { pathsOverlap } from "./scope.mjs";
import { assertNoSecretValues, normalizeRelativePath, uniquePaths } from "./util.mjs";

export const WORKER_STATUSES = Object.freeze(["verified", "degraded", "offline", "pending", "disabled"]);
export const PACKET_STATES = Object.freeze([
  "PLANNED", "VALIDATED", "CLAIMED", "RUNNING", "DELIVERED", "VERIFYING", "RETAINED",
  "INTEGRATION_PENDING", "BLOCKED", "QUARANTINED", "STOPPED",
]);
export const DIRTY_WORKTREE_MODES = Object.freeze([
  "CLEAN_REQUIRED", "PRESERVE_EXISTING_CHANGES", "OWNED_DIRTY_WORKTREE", "ISOLATED_WORKTREE",
]);
export const ADAPTERS = Object.freeze([
  "fixture", "codex-profile", "opencode-profile", "halo-agent-service", "openai-compatible", "nemotron-bounded", "disabled",
]);
export const MAX_ADAPTER_PROMPT_BYTES = 64_000;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FleetError("SCHEMA_INVALID", `${label} must be an object.`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new FleetError("SCHEMA_INVALID", `${label} must be a non-empty string.`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new FleetError("SCHEMA_INVALID", `${label} must be an integer >= ${minimum}.`);
  }
  return value;
}

function finiteNumber(value, label, minimum = 0) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new FleetError("SCHEMA_INVALID", `${label} must be a finite number >= ${minimum}.`);
  }
  return value;
}

function windowsSafeRelativePath(value, label) {
  const normalized = normalizeRelativePath(value);
  for (const segment of normalized.split("/")) {
    if (!segment || /[<>:"|?*\u0000-\u001f]/.test(segment) || /[. ]$/.test(segment) || WINDOWS_RESERVED_BASENAME.test(segment)) {
      throw new FleetError("SCHEMA_INVALID", `${label} contains a noncanonical Windows path: ${normalized}`);
    }
  }
  return normalized;
}

function stringArray(value, label, { min = 0, paths = false } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new FleetError("SCHEMA_INVALID", `${label} must be a string array with at least ${min} entries.`);
  }
  return paths ? uniquePaths(value).map((entry) => windowsSafeRelativePath(entry, label)) : [...new Set(value)];
}

function exactKeys(value, allowed, label) {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new FleetError("SCHEMA_UNKNOWN_FIELDS", `${label} has unknown fields: ${extras.join(", ")}`);
}

const SECRET_ARGUMENT = /^--?(?:api[-_]?key|token|password|passwd|client[-_]?secret|private[-_]?key)(?:=|$)/i;

export function validateWorker(raw) {
  const worker = object(structuredClone(raw), "worker");
  exactKeys(worker, [
    "id", "status", "adapter", "transport", "endpoint", "authRef", "model", "litellmModel", "contextTokens",
    "maxConcurrentPackets", "schedulingPriority", "capabilities", "roles", "limitations",
    "routeClasses", "hardware", "preflightRequirements", "operatingRules", "networkPolicy", "adapterConfig", "healthCheck",
    "explicitSelectionRequired",
  ], "worker");
  worker.id = string(worker.id, "worker.id");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/.test(worker.id)) throw new FleetError("SCHEMA_INVALID", "worker.id is invalid.");
  if (!WORKER_STATUSES.includes(worker.status)) throw new FleetError("SCHEMA_INVALID", `Invalid worker status: ${worker.status}`);
  if (!ADAPTERS.includes(worker.adapter)) throw new FleetError("SCHEMA_INVALID", `Invalid worker adapter: ${worker.adapter}`);
  if (worker.explicitSelectionRequired !== undefined && typeof worker.explicitSelectionRequired !== "boolean") {
    throw new FleetError("SCHEMA_INVALID", "worker.explicitSelectionRequired must be boolean.");
  }
  if (worker.adapter === "halo-agent-service" && worker.explicitSelectionRequired !== true) {
    throw new FleetError("SCHEMA_INVALID", "Halo service workers must require explicit selection.");
  }
  worker.transport = string(worker.transport, "worker.transport");
  if (worker.endpoint !== null && worker.endpoint !== undefined) {
    const endpoint = new URL(string(worker.endpoint, "worker.endpoint"));
    if (!/^https?:$/.test(endpoint.protocol)) throw new FleetError("SCHEMA_INVALID", "Worker endpoint must use HTTP(S).");
  }
  if (worker.authRef !== null && worker.authRef !== undefined) string(worker.authRef, "worker.authRef");
  if (worker.model !== null && worker.model !== undefined) string(worker.model, "worker.model");
  if (worker.litellmModel !== undefined && worker.litellmModel !== null) worker.litellmModel = string(worker.litellmModel, "worker.litellmModel");
  else if (!['fixture', 'disabled', 'halo-agent-service'].includes(worker.adapter)) throw new FleetError("SCHEMA_INVALID", "Live workers require a LiteLLM model group.");
  if (worker.contextTokens !== null && worker.contextTokens !== undefined) integer(worker.contextTokens, "worker.contextTokens", 1);
  integer(worker.maxConcurrentPackets, "worker.maxConcurrentPackets");
  worker.schedulingPriority = integer(worker.schedulingPriority ?? 0, "worker.schedulingPriority");
  worker.capabilities = stringArray(worker.capabilities, "worker.capabilities");
  worker.routeClasses = stringArray(worker.routeClasses ?? [], "worker.routeClasses");
  worker.roles = stringArray(worker.roles ?? [], "worker.roles");
  worker.limitations = stringArray(worker.limitations ?? [], "worker.limitations");
  worker.preflightRequirements = stringArray(worker.preflightRequirements ?? [], "worker.preflightRequirements");
  worker.operatingRules = stringArray(worker.operatingRules ?? [], "worker.operatingRules");
  if (worker.hardware !== undefined) object(worker.hardware, "worker.hardware");
  if (worker.status === "disabled" && worker.maxConcurrentPackets !== 0) {
    throw new FleetError("DISABLED_CAPACITY", "Disabled workers must have zero capacity.");
  }
  assertNoSecretValues(worker, `worker:${worker.id}`);
  return worker;
}

export function validateRegistry(raw) {
  const registry = object(structuredClone(raw), "registry");
  exactKeys(registry, ["schemaVersion", "revision", "workers", "paidPolicy", "continuousDefaults", "economicsPolicy", "capacityPolicy", "operatingPolicy"], "registry");
  if (registry.schemaVersion !== 1) throw new FleetError("SCHEMA_VERSION", "Registry schemaVersion must be 1.");
  registry.revision = string(registry.revision ?? "candidate-1", "registry.revision");
  if (!Array.isArray(registry.workers)) throw new FleetError("SCHEMA_INVALID", "registry.workers must be an array.");
  registry.workers = registry.workers.map(validateWorker);
  const ids = registry.workers.map((worker) => worker.id);
  if (new Set(ids).size !== ids.length) throw new FleetError("DUPLICATE_WORKER", "Worker IDs must be unique.");
  if (registry.operatingPolicy !== undefined) {
    const policy = object(registry.operatingPolicy, "registry.operatingPolicy");
    exactKeys(policy, [
      "supervisedLocalWorkEnabled", "autonomousIntegrationEnabled", "maxLocalRounds",
      "defaultLocalRounds", "maxNoProgressRounds",
    ], "registry.operatingPolicy");
    if (policy.supervisedLocalWorkEnabled !== true) {
      throw new FleetError("SCHEMA_INVALID", "Supervised local work must be explicitly enabled when an operating policy is present.");
    }
    if (policy.autonomousIntegrationEnabled !== false) {
      throw new FleetError("SCHEMA_INVALID", "Autonomous integration must remain disabled.");
    }
    policy.maxLocalRounds = integer(policy.maxLocalRounds, "registry.operatingPolicy.maxLocalRounds", 1);
    policy.defaultLocalRounds = integer(policy.defaultLocalRounds, "registry.operatingPolicy.defaultLocalRounds", 1);
    policy.maxNoProgressRounds = integer(policy.maxNoProgressRounds, "registry.operatingPolicy.maxNoProgressRounds", 1);
    if (policy.maxLocalRounds > 5 || policy.defaultLocalRounds > policy.maxLocalRounds) {
      throw new FleetError("SCHEMA_INVALID", "Local round limits must be bounded at five and the default cannot exceed the maximum.");
    }
    if (policy.maxNoProgressRounds > 2 || policy.maxNoProgressRounds > policy.defaultLocalRounds) {
      throw new FleetError("SCHEMA_INVALID", "No-progress rounds must be bounded at two and cannot exceed the default round budget.");
    }
  }
  if (registry.capacityPolicy !== undefined) {
    const policy = object(registry.capacityPolicy, "registry.capacityPolicy");
    exactKeys(policy, [
      "residentLargeModelWorkerIds", "maxResidentLargeModels", "allowAdditionalLargeModelLaunch",
      "maxConcurrentInferencesPerWorker", "memoryMode", "layerSplitPolicy", "memoryAccountingSignals",
      "memAvailableAloneSufficient", "runtimeSuspend",
    ], "registry.capacityPolicy");
    policy.residentLargeModelWorkerIds = stringArray(policy.residentLargeModelWorkerIds, "registry.capacityPolicy.residentLargeModelWorkerIds", { min: 1 });
    for (const workerId of policy.residentLargeModelWorkerIds) {
      if (!ids.includes(workerId)) throw new FleetError("SCHEMA_INVALID", `Capacity policy references unknown worker: ${workerId}`);
    }
    policy.maxResidentLargeModels = integer(policy.maxResidentLargeModels, "registry.capacityPolicy.maxResidentLargeModels", 1);
    if (policy.maxResidentLargeModels !== policy.residentLargeModelWorkerIds.length) {
      throw new FleetError("SCHEMA_INVALID", "Capacity policy must account for every resident large-model worker.");
    }
    if (policy.allowAdditionalLargeModelLaunch !== false) throw new FleetError("SCHEMA_INVALID", "Additional large-model launches must fail closed.");
    if (policy.maxConcurrentInferencesPerWorker !== 1) throw new FleetError("SCHEMA_INVALID", "Each production server supports exactly one active inference.");
    if (policy.memoryMode !== "separate-endpoints-only") throw new FleetError("SCHEMA_INVALID", "Fleet memory must remain separate by default.");
    if (policy.layerSplitPolicy !== "experimental-overflow-only") throw new FleetError("SCHEMA_INVALID", "Layer splitting must remain an explicit overflow experiment.");
    policy.memoryAccountingSignals = stringArray(policy.memoryAccountingSignals, "registry.capacityPolicy.memoryAccountingSignals", { min: 3 });
    for (const signal of ["mem_info_vram_used", "mem_info_gtt_used", "MemAvailable"]) {
      if (!policy.memoryAccountingSignals.includes(signal)) throw new FleetError("SCHEMA_INVALID", `Capacity policy must include ${signal}.`);
    }
    if (policy.memAvailableAloneSufficient !== false) throw new FleetError("SCHEMA_INVALID", "MemAvailable alone cannot authorize capacity.");
    const runtimeSuspend = object(policy.runtimeSuspend, "registry.capacityPolicy.runtimeSuspend");
    exactKeys(runtimeSuspend, ["workerId", "defaultPowerControl", "expectedIdleStatus", "experimentsRequireExplicitApproval"], "registry.capacityPolicy.runtimeSuspend");
    runtimeSuspend.workerId = string(runtimeSuspend.workerId, "registry.capacityPolicy.runtimeSuspend.workerId");
    if (!policy.residentLargeModelWorkerIds.includes(runtimeSuspend.workerId)) throw new FleetError("SCHEMA_INVALID", "Runtime-suspend worker must be a resident large-model worker.");
    const runtimeWorker = registry.workers.find((entry) => entry.id === runtimeSuspend.workerId);
    const windowsManaged = runtimeWorker?.hardware?.operatingSystem === "windows"
      && runtimeSuspend.defaultPowerControl === "windows-managed"
      && runtimeSuspend.expectedIdleStatus === "driver-managed";
    const linuxManaged = runtimeWorker?.hardware?.operatingSystem !== "windows"
      && runtimeSuspend.defaultPowerControl === "auto"
      && runtimeSuspend.expectedIdleStatus === "suspended";
    if ((!windowsManaged && !linuxManaged) || runtimeSuspend.experimentsRequireExplicitApproval !== true) {
      throw new FleetError("SCHEMA_INVALID", "Runtime-suspend defaults or experiment gate are invalid.");
    }
    for (const workerId of policy.residentLargeModelWorkerIds) {
      const worker = registry.workers.find((entry) => entry.id === workerId);
      if (worker.maxConcurrentPackets > policy.maxConcurrentInferencesPerWorker) {
        throw new FleetError("SCHEMA_INVALID", `Worker ${workerId} exceeds the fleet inference limit.`);
      }
    }
  }
  if (registry.economicsPolicy !== undefined) {
    const policy = object(registry.economicsPolicy, "registry.economicsPolicy");
    exactKeys(policy, ["electricityUsdPerKwh", "cloudBenchmark", "workers", "rateSource"], "registry.economicsPolicy");
    policy.electricityUsdPerKwh = finiteNumber(policy.electricityUsdPerKwh, "registry.economicsPolicy.electricityUsdPerKwh");
    const benchmark = object(policy.cloudBenchmark, "registry.economicsPolicy.cloudBenchmark");
    exactKeys(benchmark, ["model", "pricingAsOf", "inputUsdPerMillionTokens", "methodology"], "registry.economicsPolicy.cloudBenchmark");
    benchmark.model = string(benchmark.model, "registry.economicsPolicy.cloudBenchmark.model");
    benchmark.pricingAsOf = string(benchmark.pricingAsOf, "registry.economicsPolicy.cloudBenchmark.pricingAsOf");
    benchmark.inputUsdPerMillionTokens = finiteNumber(benchmark.inputUsdPerMillionTokens, "registry.economicsPolicy.cloudBenchmark.inputUsdPerMillionTokens");
    benchmark.methodology = string(benchmark.methodology, "registry.economicsPolicy.cloudBenchmark.methodology");
    const workerEconomics = object(policy.workers, "registry.economicsPolicy.workers");
    for (const [id, rawWorkerPolicy] of Object.entries(workerEconomics)) {
      if (!ids.includes(id)) throw new FleetError("SCHEMA_INVALID", `Economics policy references unknown worker: ${id}`);
      const workerPolicy = object(rawWorkerPolicy, `registry.economicsPolicy.workers.${id}`);
      exactKeys(workerPolicy, ["powerCeilingWatts", "basis"], `registry.economicsPolicy.workers.${id}`);
      workerPolicy.powerCeilingWatts = finiteNumber(workerPolicy.powerCeilingWatts, `registry.economicsPolicy.workers.${id}.powerCeilingWatts`);
      workerPolicy.basis = string(workerPolicy.basis, `registry.economicsPolicy.workers.${id}.basis`);
    }
    const rateSource = object(policy.rateSource, "registry.economicsPolicy.rateSource");
    exactKeys(rateSource, ["provider", "postalCode", "verifiedAsOf", "methodology"], "registry.economicsPolicy.rateSource");
    for (const key of ["provider", "postalCode", "verifiedAsOf", "methodology"]) rateSource[key] = string(rateSource[key], `registry.economicsPolicy.rateSource.${key}`);
  }
  assertNoSecretValues(registry, "registry");
  return registry;
}

function validateCommand(raw, index) {
  const command = object(structuredClone(raw), `requiredCommands[${index}]`);
  exactKeys(command, ["argv", "cwd", "timeoutMs"], `requiredCommands[${index}]`);
  command.argv = stringArray(command.argv, `requiredCommands[${index}].argv`, { min: 1 });
  if (command.argv.some((entry) => SECRET_ARGUMENT.test(entry))) {
    throw new FleetError("SECRET_ARGUMENT_REJECTED", `requiredCommands[${index}] contains a credential-bearing argument.`);
  }
  if (command.cwd !== undefined) command.cwd = windowsSafeRelativePath(command.cwd, `requiredCommands[${index}].cwd`);
  command.timeoutMs = integer(command.timeoutMs ?? 120_000, `requiredCommands[${index}].timeoutMs`, 1);
  return command;
}

export function validatePacket(raw) {
  const packet = object(structuredClone(raw), "packet");
  exactKeys(packet, [
    "schemaVersion", "id", "repository", "exactBase", "dirtyWorktreeMode", "kind", "allowedFiles",
    "forbiddenFiles", "baselineHashes", "sourceFiles", "expectedOutputs", "requiredCommands",
    "runtimeRequirements", "budgets", "acceptanceCriteria", "requiredCapabilities", "preferredWorkerId",
    "routingClass", "resourceIntent", "expectedArtifacts", "adapterInput", "canary", "independentVerifier", "localFirst",
    "executionMode", "toolCapabilities",
  ], "packet");
  if (packet.schemaVersion !== 1) throw new FleetError("SCHEMA_VERSION", "Packet schemaVersion must be 1.");
  packet.id = string(packet.id, "packet.id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(packet.id)) throw new FleetError("SCHEMA_INVALID", "packet.id is invalid.");
  packet.repository = path.resolve(string(packet.repository, "packet.repository"));
  packet.exactBase = string(packet.exactBase, "packet.exactBase");
  if (!/^[0-9a-f]{40}$/i.test(packet.exactBase)) throw new FleetError("SCHEMA_INVALID", "packet.exactBase must be a full commit SHA.");
  if (!DIRTY_WORKTREE_MODES.includes(packet.dirtyWorktreeMode)) throw new FleetError("SCHEMA_INVALID", "Invalid dirtyWorktreeMode.");
  if (!["read", "edit"].includes(packet.kind)) throw new FleetError("SCHEMA_INVALID", "packet.kind must be read or edit.");
  packet.allowedFiles = stringArray(packet.allowedFiles ?? [], "packet.allowedFiles", { min: packet.kind === "edit" ? 1 : 0, paths: true });
  packet.forbiddenFiles = stringArray(packet.forbiddenFiles ?? [], "packet.forbiddenFiles", { paths: true });
  packet.sourceFiles = stringArray(packet.sourceFiles ?? [], "packet.sourceFiles", { paths: true });
  packet.expectedArtifacts = stringArray(packet.expectedArtifacts ?? [], "packet.expectedArtifacts", { paths: true });
  const artifactsOutsideWriteScope = packet.kind === "edit"
    ? packet.expectedArtifacts.filter(
        (artifact) => !packet.allowedFiles.some((allowed) => pathsOverlap(artifact, allowed)),
      )
    : [];
  if (artifactsOutsideWriteScope.length) {
    throw new FleetError(
      "ARTIFACT_SCOPE_CONFLICT",
      `Expected artifacts must be inside allowedFiles: ${artifactsOutsideWriteScope.join(", ")}`,
    );
  }
  if (packet.kind === "read" && packet.expectedArtifacts.length === 0) {
    throw new FleetError("ARTIFACT_REQUIRED", "Read-only packets require at least one hashed expected artifact.");
  }
  packet.expectedOutputs = stringArray(packet.expectedOutputs, "packet.expectedOutputs", { min: 1 });
  packet.runtimeRequirements = stringArray(packet.runtimeRequirements ?? [], "packet.runtimeRequirements");
  packet.acceptanceCriteria = stringArray(packet.acceptanceCriteria, "packet.acceptanceCriteria", { min: 1 });
  packet.requiredCapabilities = stringArray(packet.requiredCapabilities ?? [], "packet.requiredCapabilities");
  if (packet.executionMode !== undefined) {
    packet.executionMode = string(packet.executionMode, "packet.executionMode").toLowerCase();
    if (!["inference", "tools"].includes(packet.executionMode)) throw new FleetError("SCHEMA_INVALID", "packet.executionMode must be inference or tools.");
    packet.toolCapabilities = stringArray(packet.toolCapabilities ?? [], "packet.toolCapabilities");
    if (new Set(packet.toolCapabilities).size !== packet.toolCapabilities.length) throw new FleetError("SCHEMA_INVALID", "packet.toolCapabilities contains duplicates.");
    const required = new Set(packet.requiredCapabilities);
    if (packet.toolCapabilities.some((capability) => !required.has(capability))) {
      throw new FleetError("SCHEMA_INVALID", "Every packet tool capability must also be a required capability.");
    }
    if (packet.executionMode === "inference" && packet.toolCapabilities.length) {
      throw new FleetError("SCHEMA_INVALID", "Inference packets cannot declare tool capabilities.");
    }
    if (packet.executionMode === "tools" && !packet.toolCapabilities.length) {
      throw new FleetError("SCHEMA_INVALID", "Tools packets require at least one named tool capability.");
    }
  } else if (packet.toolCapabilities !== undefined) {
    throw new FleetError("SCHEMA_INVALID", "packet.toolCapabilities requires packet.executionMode.");
  }
  if (packet.routingClass !== undefined) packet.routingClass = string(packet.routingClass, "packet.routingClass");
  packet.resourceIntent = packet.resourceIntent ?? "use-resident-service";
  if (!["use-resident-service", "use-on-demand-service", "launch-additional-large-model"].includes(packet.resourceIntent)) {
    throw new FleetError("SCHEMA_INVALID", "packet.resourceIntent is invalid.");
  }
  packet.requiredCommands = (packet.requiredCommands ?? []).map(validateCommand);
  if (packet.adapterInput !== undefined) {
    packet.adapterInput = object(packet.adapterInput, "packet.adapterInput");
    if (Object.hasOwn(packet.adapterInput, "prompt")) {
      packet.adapterInput.prompt = string(packet.adapterInput.prompt, "packet.adapterInput.prompt");
      const promptBytes = Buffer.byteLength(packet.adapterInput.prompt, "utf8");
      if (promptBytes > MAX_ADAPTER_PROMPT_BYTES) {
        throw new FleetError("PROMPT_BUDGET_EXCEEDED", "packet.adapterInput.prompt exceeds the controller input budget.", {
          observedBytes: promptBytes,
          limitBytes: MAX_ADAPTER_PROMPT_BYTES,
        });
      }
    }
  }
  packet.baselineHashes = object(packet.baselineHashes, "packet.baselineHashes");
  for (const [file, hash] of Object.entries(packet.baselineHashes)) {
    windowsSafeRelativePath(file, "packet.baselineHashes");
    if (hash !== "ABSENT" && !/^[0-9a-f]{64}$/i.test(hash)) throw new FleetError("SCHEMA_INVALID", `Invalid baseline hash for ${file}.`);
  }
  const baselineByPath = new Map(Object.entries(packet.baselineHashes).map(
    ([entry, hash]) => [normalizeRelativePath(entry).toLowerCase(), hash],
  ));
  if (packet.kind === "read") {
    const unhashedArtifacts = packet.expectedArtifacts.filter((artifact) => {
      const baseline = baselineByPath.get(normalizeRelativePath(artifact).toLowerCase());
      return baseline === undefined || baseline === "ABSENT";
    });
    if (unhashedArtifacts.length) {
      throw new FleetError(
        "ARTIFACT_BASELINE_REQUIRED",
        `Read-only expected artifacts must be existing non-ABSENT baseline-hashed files: ${unhashedArtifacts.join(", ")}`,
      );
    }
  }
  const declared = uniquePaths([
    ...packet.allowedFiles,
    ...packet.forbiddenFiles,
    ...packet.sourceFiles,
    ...(packet.kind === "read" ? packet.expectedArtifacts : []),
  ]);
  const baselineKeys = new Set(baselineByPath.keys());
  const missing = declared.filter((entry) => !baselineKeys.has(entry.toLowerCase()));
  if (missing.length) throw new FleetError("BASELINE_HASH_MISSING", `Missing baseline hashes for: ${missing.join(", ")}`);
  const allowed = new Set(packet.allowedFiles.map((entry) => entry.toLowerCase()));
  const overlap = packet.forbiddenFiles.filter((entry) => allowed.has(entry.toLowerCase()));
  if (overlap.length) throw new FleetError("SCOPE_CONFLICT", `Files cannot be allowed and forbidden: ${overlap.join(", ")}`);
  const budgets = validateBudget(packet.budgets, "packet.budgets");
  packet.budgets = budgets;

  if (packet.localFirst !== undefined) {
    if (packet.kind !== "edit") throw new FleetError("SCHEMA_INVALID", "Local-first iteration is available only for edit packets.");
    const localFirst = object(packet.localFirst, "packet.localFirst");
    exactKeys(localFirst, ["reviewerWorkerId", "maxRounds", "maxNoProgressRounds"], "packet.localFirst");
    localFirst.reviewerWorkerId = string(localFirst.reviewerWorkerId, "packet.localFirst.reviewerWorkerId");
    localFirst.maxRounds = integer(localFirst.maxRounds, "packet.localFirst.maxRounds", 1);
    localFirst.maxNoProgressRounds = integer(localFirst.maxNoProgressRounds, "packet.localFirst.maxNoProgressRounds", 1);
    if (localFirst.maxRounds > 5) throw new FleetError("SCHEMA_INVALID", "packet.localFirst.maxRounds cannot exceed five.");
    if (localFirst.maxNoProgressRounds > 2 || localFirst.maxNoProgressRounds > localFirst.maxRounds) {
      throw new FleetError("SCHEMA_INVALID", "packet.localFirst.maxNoProgressRounds must be within the packet round budget and cannot exceed two.");
    }
    if (packet.preferredWorkerId !== undefined && packet.preferredWorkerId === localFirst.reviewerWorkerId) {
      throw new FleetError("SCHEMA_INVALID", "The local-first implementer and adversarial reviewer must be different workers.");
    }
    if (budgets.maxWriteCycles < localFirst.maxRounds) {
      throw new FleetError("BUDGET_EXCEEDED", "maxWriteCycles must cover every authorized local-first implementation round.");
    }
    if (packet.independentVerifier !== true) {
      throw new FleetError("VERIFIER_REQUIRED", "Local-first packets must explicitly require independent verification.");
    }
  }

  if (packet.allowedFiles.length > budgets.maxFiles) throw new FleetError("BUDGET_EXCEEDED", "Allowed files exceed maxFiles.");
  if (packet.requiredCommands.length > budgets.maxCommands) throw new FleetError("BUDGET_EXCEEDED", "Required commands exceed maxCommands.");
  if (packet.preferredWorkerId !== undefined) string(packet.preferredWorkerId, "packet.preferredWorkerId");
  if (packet.independentVerifier !== undefined && typeof packet.independentVerifier !== "boolean") throw new FleetError("SCHEMA_INVALID", "independentVerifier must be boolean.");
  if (packet.independentVerifier === false) throw new FleetError("VERIFIER_REQUIRED", "Independent verification cannot be disabled.");
  assertNoSecretValues(packet, `packet:${packet.id}`);
  return packet;
}

export function validateBudget(raw, label = "budget") {
  const budgets = object(structuredClone(raw), label);
  exactKeys(budgets, ["maxFiles", "maxChangedLines", "maxCommands", "maxWriteCycles", "maxFailures", "timeoutMs", "maxOutputBytes"], label);
  for (const key of ["maxFiles", "maxChangedLines", "maxCommands", "maxWriteCycles", "maxFailures", "timeoutMs", "maxOutputBytes"]) {
    budgets[key] = integer(budgets[key], `${label}.${key}`, key === "maxFailures" ? 0 : 1);
  }
  return budgets;
}

export function validateLease(raw) {
  const lease = object(structuredClone(raw), "lease");
  exactKeys(lease, ["leaseId", "workerId", "packetId", "ownerId", "commandIdentity", "ownerPid", "acquiredAt", "expiresAt", "slot"], "lease");
  for (const key of ["leaseId", "workerId", "packetId", "ownerId", "commandIdentity", "acquiredAt", "expiresAt"]) string(lease[key], `lease.${key}`);
  if (!Number.isInteger(lease.ownerPid) || lease.ownerPid <= 0) throw new FleetError("SCHEMA_INVALID", "lease.ownerPid must be positive.");
  integer(lease.slot, "lease.slot", 0);
  if (Date.parse(lease.expiresAt) <= Date.parse(lease.acquiredAt)) throw new FleetError("SCHEMA_INVALID", "Lease expiry must follow acquisition.");
  return lease;
}

export function validateHealth(raw) {
  const health = object(structuredClone(raw), "health");
  for (const key of ["workerId", "checkedAt", "status", "evidenceHash"]) string(health[key], `health.${key}`);
  if (!["verified", "degraded", "offline"].includes(health.status)) throw new FleetError("SCHEMA_INVALID", "Invalid health status.");
  if (!/^[0-9a-f]{64}$/i.test(health.evidenceHash)) throw new FleetError("SCHEMA_INVALID", "Invalid health evidence hash.");
  return health;
}

export function validateVerifierInput(raw) {
  const input = object(structuredClone(raw), "verifierInput");
  for (const key of ["packet", "worker", "lease", "exactDiff", "changedFiles", "changedLines", "commands", "artifacts", "runtimeEvidence", "writeCycles"]) {
    if (!(key in input)) throw new FleetError("VERIFIER_INPUT_INCOMPLETE", `Missing verifier input: ${key}`);
  }
  validatePacket(input.packet);
  validateWorker(input.worker);
  validateLease(input.lease);
  if (typeof input.exactDiff !== "string") throw new FleetError("SCHEMA_INVALID", "exactDiff must be a string.");
  stringArray(input.changedFiles, "verifierInput.changedFiles", { paths: true });
  integer(input.changedLines, "verifierInput.changedLines", 0);
  integer(input.writeCycles, "verifierInput.writeCycles", 0);
  if (!Array.isArray(input.commands) || !Array.isArray(input.artifacts)) throw new FleetError("SCHEMA_INVALID", "Verifier commands/artifacts must be arrays.");
  return input;
}

export function validateReceipt(raw) {
  const receipt = object(structuredClone(raw), "receipt");
  if (receipt.schemaVersion !== 1) throw new FleetError("SCHEMA_VERSION", "Receipt schemaVersion must be 1.");
  for (const key of ["packetId", "state", "createdAt", "updatedAt", "packetHash"]) string(receipt[key], `receipt.${key}`);
  if (!PACKET_STATES.includes(receipt.state)) throw new FleetError("SCHEMA_INVALID", "Receipt state is invalid.");
  if (!/^[0-9a-f]{64}$/i.test(receipt.packetHash)) throw new FleetError("SCHEMA_INVALID", "Receipt packetHash is invalid.");
  if (receipt.integrationAuthorized !== false) throw new FleetError("INTEGRATION_NOT_AUTHORIZED", "Candidate receipts may not authorize integration.");
  if (Number.isNaN(Date.parse(receipt.createdAt)) || Number.isNaN(Date.parse(receipt.updatedAt))) throw new FleetError("SCHEMA_INVALID", "Receipt timestamps are invalid.");
  assertNoSecretValues(receipt, `receipt:${receipt.packetId}`);
  return receipt;
}

export const CONTRACT_SCHEMAS = Object.freeze({
  registry: { schemaVersion: 1, validator: "validateRegistry" },
  packet: { schemaVersion: 1, validator: "validatePacket" },
  receipt: { schemaVersion: 1, validator: "validateReceipt", stateEnum: PACKET_STATES },
  health: { schemaVersion: 1, validator: "validateHealth" },
  lease: { schemaVersion: 1, validator: "validateLease" },
  budget: { schemaVersion: 1, validator: "validateBudget", contract: "packet.budgets" },
  verifierInput: { schemaVersion: 1, validator: "validateVerifierInput" },
});
