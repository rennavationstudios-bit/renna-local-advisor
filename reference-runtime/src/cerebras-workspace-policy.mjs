import fsp from "node:fs/promises";
import path from "node:path";

import { readStableRegularFile } from "./bounded-local-file.mjs";

export const CEREBRAS_WORKSPACE_POLICY_PATH = "/SETUP_REQUIRED/path-2";
const MAX_POLICY_BYTES = 64 * 1024;

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function comparable(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute directory path.`);
  }
  const resolved = await fsp.realpath(path.resolve(value));
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) throw new Error(`${label} must identify a directory.`);
  return resolved;
}

export async function readCerebrasWorkspacePolicy(policyPath = CEREBRAS_WORKSPACE_POLICY_PATH) {
  const resolvedPolicyPath = path.resolve(policyPath);
  const snapshot = await readStableRegularFile(resolvedPolicyPath, {
    minimumBytes: 2,
    maximumBytes: MAX_POLICY_BYTES,
    requireSingleLink: true,
  });
  let parsed;
  try {
    parsed = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    throw new Error("The host-owned Cerebras workspace policy is malformed.");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || parsed.schemaVersion !== 1
    || parsed.default !== "allow"
    || !Array.isArray(parsed.privateOnlyRoots)
    || Object.keys(parsed).some((key) => !["schemaVersion", "default", "privateOnlyRoots"].includes(key))
  ) {
    throw new Error("The host-owned Cerebras workspace policy has an unsupported schema.");
  }
  if (parsed.privateOnlyRoots.length > 128) {
    throw new Error("The host-owned Cerebras workspace policy has too many roots.");
  }
  return { path: snapshot.realPath, privateOnlyRoots: parsed.privateOnlyRoots };
}

export async function evaluateCerebrasWorkspacePolicy({
  workspaceRoot,
  policyPath = CEREBRAS_WORKSPACE_POLICY_PATH,
  policy,
  includeDescendants = false,
} = {}) {
  const workspace = await canonicalDirectory(workspaceRoot, "workspaceRoot");
  const source = policy ?? await readCerebrasWorkspacePolicy(policyPath);
  const roots = [];
  const seen = new Set();
  for (const value of source.privateOnlyRoots ?? []) {
    const root = await canonicalDirectory(value, "privateOnlyRoots entry");
    const key = comparable(root);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(root);
  }
  roots.sort((left, right) => right.length - left.length);
  const matchedRoot = roots.find((root) => pathInside(root, workspace)
    || includeDescendants && pathInside(workspace, root)) ?? null;
  return {
    allowed: matchedRoot === null,
    workspace,
    policyPath: source.path ? path.resolve(source.path) : path.resolve(policyPath),
    matchedRoot,
    reason: matchedRoot
      ? "The host-owned workspace registry marks this canonical root private-only."
      : "The canonical workspace is not listed as private-only.",
  };
}

export async function assertCerebrasWorkspaceAllowed(options = {}) {
  const decision = await evaluateCerebrasWorkspacePolicy(options);
  if (!decision.allowed) {
    const error = new Error(decision.reason);
    error.code = "CEREBRAS_WORKSPACE_PRIVATE_ONLY";
    throw error;
  }
  return decision;
}

// Source/image selection is a separate boundary from the launching workspace.
// Canonicalize the selected file before testing its containing directory so a
// public workspace cannot grant access to a private child or directory alias.
export async function assertCerebrasFileAllowed({ filePath, policyPath, policy } = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("filePath must be an absolute file path.");
  }
  const canonical = await fsp.realpath(filePath);
  return assertCerebrasWorkspaceAllowed({ workspaceRoot: path.dirname(canonical), policyPath, policy });
}
