import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function localFileError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function comparablePath(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableState(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readAtMost(handle, maximumBytes) {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

async function pathBinding(resolvedPath, expectedRealPath, openedStat) {
  const [lexicalStat, reboundRealPath, targetStat] = await Promise.all([
    fsp.lstat(resolvedPath, { bigint: true }),
    fsp.realpath(resolvedPath),
    fsp.stat(expectedRealPath, { bigint: true }),
  ]);
  if (
    lexicalStat.isSymbolicLink()
    || comparablePath(reboundRealPath) !== comparablePath(expectedRealPath)
    || !sameIdentity(openedStat, targetStat)
  ) {
    throw localFileError("BOUNDED_LOCAL_FILE_PATH_CHANGED", "The local file path changed while it was being read.");
  }
  return targetStat;
}

/**
 * Read one stable regular-file snapshot without following a final symlink and
 * without ever allocating or reading more than maximumBytes + 1. The second
 * handle read plus bigint timestamps catches same-size in-place mutation.
 * `afterFirstRead` is an internal deterministic-test hook; production callers
 * leave it unset.
 */
export async function readStableRegularFile(filePath, {
  maximumBytes,
  minimumBytes = 0,
  requireSingleLink = false,
  afterFirstRead,
} = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw localFileError("BOUNDED_LOCAL_FILE_ARGUMENT_INVALID", "maximumBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes < 0 || minimumBytes > maximumBytes) {
    throw localFileError("BOUNDED_LOCAL_FILE_ARGUMENT_INVALID", "minimumBytes must be between zero and maximumBytes.");
  }
  const resolvedPath = path.resolve(filePath);
  let lexicalStat;
  try {
    lexicalStat = await fsp.lstat(resolvedPath, { bigint: true });
  } catch (cause) {
    throw localFileError("BOUNDED_LOCAL_FILE_UNREADABLE", "The local file could not be inspected.", { causeCode: cause?.code ?? "UNKNOWN" });
  }
  if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) {
    throw localFileError("BOUNDED_LOCAL_FILE_TYPE_INVALID", "The local file must be a non-symlink regular file.");
  }

  let realPath;
  try {
    realPath = await fsp.realpath(resolvedPath);
  } catch (cause) {
    throw localFileError("BOUNDED_LOCAL_FILE_UNREADABLE", "The local file could not be canonicalized.", { causeCode: cause?.code ?? "UNKNOWN" });
  }

  let handle;
  try {
    const flags = process.platform === "win32" ? "r" : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    handle = await fsp.open(realPath, flags);
  } catch (cause) {
    throw localFileError("BOUNDED_LOCAL_FILE_UNREADABLE", "The local file could not be opened safely.", { causeCode: cause?.code ?? "UNKNOWN" });
  }

  try {
    const initialStat = await handle.stat({ bigint: true });
    const minimum = BigInt(minimumBytes);
    const maximum = BigInt(maximumBytes);
    if (!initialStat.isFile() || initialStat.size < minimum || initialStat.size > maximum) {
      throw localFileError("BOUNDED_LOCAL_FILE_SIZE_INVALID", `The local file must be between ${minimumBytes} and ${maximumBytes} bytes.`);
    }
    if (requireSingleLink && initialStat.nlink !== 1n) {
      throw localFileError("BOUNDED_LOCAL_FILE_LINK_INVALID", "The local file must not be hard-linked.");
    }
    const boundStat = await pathBinding(resolvedPath, realPath, initialStat);
    if (!sameStableState(initialStat, boundStat)) {
      throw localFileError("BOUNDED_LOCAL_FILE_CONTENT_CHANGED", "The local file changed while it was being opened.");
    }

    const first = await readAtMost(handle, maximumBytes);
    if (first.length > maximumBytes) {
      throw localFileError("BOUNDED_LOCAL_FILE_SIZE_INVALID", `The local file grew beyond ${maximumBytes} bytes while it was being read.`);
    }
    if (typeof afterFirstRead === "function") await afterFirstRead({ realPath, handle });
    const middleStat = await handle.stat({ bigint: true });
    const second = await readAtMost(handle, maximumBytes);
    const finalStat = await handle.stat({ bigint: true });
    const finalBoundStat = await pathBinding(resolvedPath, realPath, finalStat);
    if (second.length > maximumBytes) {
      throw localFileError("BOUNDED_LOCAL_FILE_SIZE_INVALID", `The local file grew beyond ${maximumBytes} bytes while it was being read.`);
    }
    if (
      second.length < minimumBytes
      || !first.equals(second)
      || !sameStableState(initialStat, middleStat)
      || !sameStableState(middleStat, finalStat)
      || !sameStableState(finalStat, finalBoundStat)
    ) {
      throw localFileError("BOUNDED_LOCAL_FILE_CONTENT_CHANGED", "The local file changed while it was being read.");
    }
    return { bytes: second, realPath, stat: finalStat };
  } finally {
    await handle.close();
  }
}
