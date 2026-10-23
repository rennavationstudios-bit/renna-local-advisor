import { FleetError } from "./errors.mjs";
import { normalizeRelativePath, uniquePaths } from "./util.mjs";

function canonical(value) {
  return normalizeRelativePath(value).toLowerCase();
}

export function pathsOverlap(first, second) {
  const a = canonical(first);
  const b = canonical(second);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function scopesOverlap(first = [], second = []) {
  return first.some((a) => second.some((b) => pathsOverlap(a, b)));
}

export function assertDisjointPackets(packets) {
  for (let index = 0; index < packets.length; index += 1) {
    for (let other = index + 1; other < packets.length; other += 1) {
      if (scopesOverlap(packets[index].allowedFiles, packets[other].allowedFiles)) {
        throw new FleetError("SCOPE_CONFLICT", `Packets ${packets[index].id} and ${packets[other].id} have overlapping write scopes.`);
      }
    }
  }
  return true;
}

export function assertChangedFilesAllowed(changedFiles, packet) {
  const changed = uniquePaths(changedFiles);
  const outside = changed.filter((file) => !packet.allowedFiles.some((allowed) => pathsOverlap(file, allowed)));
  const forbidden = changed.filter((file) => packet.forbiddenFiles.some((denied) => pathsOverlap(file, denied)));
  if (outside.length || forbidden.length) {
    throw new FleetError("OUT_OF_SCOPE_CHANGE", "Worker changed files outside the packet scope.", { outside, forbidden });
  }
  return changed;
}
