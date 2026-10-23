import crypto from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { FleetError } from "./errors.mjs";
import { assertNoSecretValues, sha256 } from "./util.mjs";

export const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa";
export const EXA_MCP_SERVER_NAME = "exa-search-server";
export const EXA_MCP_PROTOCOL_VERSION = "2025-06-18";
export const EXA_MCP_TOOL_NAMES = Object.freeze(["web_search_exa", "web_fetch_exa"]);

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_QUERY_CHARS = 500;
const MAX_URLS = 8;
const SESSION_RETRY_CODES = new Set(["EXA_MCP_SESSION_INVALID"]);
const COORDINATION_POLL_MS = 50;
const COORDINATION_STALE_MS = 180_000;

function error(code, message, details = {}) {
  return new FleetError(code, message, details);
}

function delay(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(error("EXA_MCP_REQUEST_FAILED", "Exa MCP request was aborted.", { causeCode: "AbortError" }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(error("EXA_MCP_REQUEST_FAILED", "Exa MCP request was aborted.", { causeCode: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMilliseconds(response) {
  const value = String(response.headers?.get?.("retry-after") ?? "").trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Math.min(Math.ceil(Number(value) * 1_000), 30_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 30_000) : null;
}

async function boundedTextResponse(response, maximumBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    try { await response.body?.cancel?.(); } catch { /* size failure is already determined */ }
    throw error("EXA_MCP_RESPONSE_TOO_LARGE", "Exa MCP response exceeded its bounded size.");
  }
  const chunks = [];
  let totalBytes = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maximumBytes) {
          await reader.cancel().catch(() => {});
          throw error("EXA_MCP_RESPONSE_TOO_LARGE", "Exa MCP response exceeded its bounded size.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer());
    if (chunk.length > maximumBytes) {
      throw error("EXA_MCP_RESPONSE_TOO_LARGE", "Exa MCP response exceeded its bounded size.");
    }
    totalBytes = chunk.length;
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  return { text: bytes.toString("utf8"), sha256: sha256(bytes), bytes: totalBytes };
}

function parseSse(text) {
  const payloads = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try { payloads.push(JSON.parse(data)); }
    catch { throw error("EXA_MCP_RESPONSE_INVALID", "Exa MCP returned malformed SSE JSON."); }
  };
  for (const line of String(text).split(/\r?\n/u)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  if (!payloads.length) throw error("EXA_MCP_RESPONSE_INVALID", "Exa MCP returned no JSON-RPC payload.");
  return payloads.at(-1);
}

function parseMcpPayload(response, responseBody, { notification = false } = {}) {
  if (notification && responseBody.bytes === 0) return null;
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) return parseSse(responseBody.text);
  try { return JSON.parse(responseBody.text); }
  catch { throw error("EXA_MCP_RESPONSE_INVALID", "Exa MCP returned malformed JSON.", { responseSha256: responseBody.sha256 }); }
}

function ipv4Number(value) {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inIpv4Range(value, base, prefix) {
  const number = ipv4Number(value);
  const baseNumber = ipv4Number(base);
  if (number === null || baseNumber === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (number & mask) === (baseNumber & mask);
}

function unsafeIpLiteral(hostname) {
  const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const version = net.isIP(literal);
  if (version === 4) {
    return [
      ["SETUP_REQUIRED_ADDRESS_2", 8], ["SETUP_REQUIRED_ADDRESS_3", 8], ["SETUP_REQUIRED_ADDRESS_4", 10], ["SETUP_REQUIRED_ADDRESS_5", 8],
      ["SETUP_REQUIRED_ADDRESS_6", 16], ["SETUP_REQUIRED_ADDRESS_7", 12], ["SETUP_REQUIRED_ADDRESS_8", 24], ["SETUP_REQUIRED_ADDRESS_9", 24],
      ["SETUP_REQUIRED_ADDRESS_10", 16], ["SETUP_REQUIRED_ADDRESS_11", 15], ["SETUP_REQUIRED_ADDRESS_12", 24], ["SETUP_REQUIRED_ADDRESS_13", 24],
      ["SETUP_REQUIRED_ADDRESS_14", 4],
    ].some(([base, prefix]) => inIpv4Range(literal, base, prefix));
  }
  if (version === 6) {
    const normalized = literal.toLowerCase();
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/u.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:")
      || normalized.startsWith("::ffff:");
  }
  return false;
}

export function validateResearchUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) {
    throw error("EXA_MCP_URL_INVALID", "Research URLs must be bounded non-empty strings.");
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw error("EXA_MCP_URL_INVALID", "Research URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw error("EXA_MCP_URL_DENIED", "Research fetch accepts only credential-free HTTPS URLs on the default port.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    !hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".test")
    || hostname.endsWith(".invalid")
    || hostname.endsWith(".example")
    || hostname.endsWith(".onion")
    || hostname === "metadata.google.internal"
    || unsafeIpLiteral(hostname)
  ) {
    throw error("EXA_MCP_URL_DENIED", "Research fetch rejected a local, private, reserved, or non-public target.");
  }
  let decodedPath;
  try { decodedPath = decodeURIComponent(url.pathname); }
  catch { throw error("EXA_MCP_URL_DENIED", "Research URL contains invalid path encoding."); }
  try { assertNoSecretValues(decodedPath, "exa-mcp-url-path"); }
  catch { throw error("EXA_MCP_URL_DENIED", "Research URL contains credential-shaped path content."); }
  for (const [key, parameterValue] of url.searchParams.entries()) {
    if (/(?:key|token|secret|password|passwd|credential|signature|auth)/iu.test(key)) {
      throw error("EXA_MCP_URL_DENIED", "Research URL contains a credential-shaped query parameter.");
    }
    try { assertNoSecretValues(parameterValue, `exa-mcp-url-query.${key}`); }
    catch { throw error("EXA_MCP_URL_DENIED", "Research URL contains credential-shaped query content."); }
  }
  url.hash = "";
  return url.href;
}

function validateQuery(value) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_QUERY_CHARS || /[\r\n\0]/u.test(value)) {
    throw error("EXA_MCP_QUERY_INVALID", `Research query must be one line and no more than ${MAX_QUERY_CHARS} characters.`);
  }
  const query = value.trim().replace(/\s+/gu, " ");
  assertNoSecretValues(query, "exa-mcp-query");
  return query;
}

function validateToolContracts(tools) {
  const byName = new Map(tools.map((tool) => [tool?.name, tool]));
  const search = byName.get("web_search_exa")?.inputSchema;
  const fetch = byName.get("web_fetch_exa")?.inputSchema;
  const searchRequired = Array.isArray(search?.required) ? search.required : [];
  const fetchRequired = Array.isArray(fetch?.required) ? fetch.required : [];
  return search?.type === "object"
    && search?.properties?.query?.type === "string"
    && search?.properties?.numResults?.type === "number"
    && searchRequired.includes("query")
    && fetch?.type === "object"
    && fetch?.properties?.urls?.type === "array"
    && fetch?.properties?.urls?.items?.type === "string"
    && fetch?.properties?.maxCharacters?.type === "number"
    && fetchRequired.includes("urls");
}

export class ExaMcpClient {
  constructor({ fetchImpl = globalThis.fetch, endpoint = EXA_MCP_ENDPOINT, coordinationRoot = null } = {}) {
    if (endpoint !== EXA_MCP_ENDPOINT) throw error("EXA_MCP_ENDPOINT_INVALID", "Exa MCP endpoint must remain pinned.");
    if (coordinationRoot !== null && (typeof coordinationRoot !== "string" || !path.isAbsolute(coordinationRoot))) {
      throw error("EXA_MCP_COORDINATION_INVALID", "Exa MCP coordination root must be an absolute path.");
    }
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
    this.coordinationRoot = coordinationRoot ? path.resolve(coordinationRoot) : null;
    this.coordinationLockPath = this.coordinationRoot ? path.join(this.coordinationRoot, "exa-mcp-transport.lock") : null;
    this.sessionId = null;
    this.initializing = null;
    this.nextId = 1;
    this.queue = Promise.resolve();
  }

  resetSession() {
    this.sessionId = null;
    this.initializing = null;
  }

  #enqueue(operation) {
    const scheduled = this.queue.then(operation, operation);
    this.queue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  async #acquireCoordination({ timeoutMs, signal }) {
    if (!this.coordinationLockPath) return { waitMs: 0, release: async () => {} };
    await fsp.mkdir(this.coordinationRoot, { recursive: true });
    const started = performance.now();
    const deadline = Date.now() + timeoutMs;
    const nonce = crypto.randomUUID();
    while (true) {
      if (signal?.aborted) throw error("EXA_MCP_COORDINATION_TIMEOUT", "Exa MCP coordination was aborted before the bounded web call.");
      let handle;
      try {
        handle = await fsp.open(this.coordinationLockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, acquiredAt: new Date().toISOString() }), "utf8");
        return {
          waitMs: Math.round(performance.now() - started),
          release: async () => {
            try { await handle.close(); } catch { /* release continues through exact ownership check */ }
            try {
              const current = JSON.parse(await fsp.readFile(this.coordinationLockPath, "utf8"));
              if (current?.nonce === nonce) await fsp.unlink(this.coordinationLockPath);
            } catch { /* a stale-lock recovery or process exit already removed it */ }
          },
        };
      } catch (cause) {
        try { await handle?.close(); } catch { /* no acquired lease */ }
        if (cause?.code !== "EEXIST") throw error("EXA_MCP_COORDINATION_FAILED", "Exa MCP could not acquire its host-wide bounded web gate.", { causeCode: cause?.code ?? "UNKNOWN" });
      }
      try {
        const stat = await fsp.stat(this.coordinationLockPath);
        if (Date.now() - stat.mtimeMs > COORDINATION_STALE_MS) {
          const stalePath = `${this.coordinationLockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
          try {
            await fsp.rename(this.coordinationLockPath, stalePath);
            await fsp.unlink(stalePath);
            continue;
          } catch { /* another contender recovered it or the owner released it */ }
        }
      } catch (cause) {
        if (cause?.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw error("EXA_MCP_COORDINATION_TIMEOUT", "Exa MCP timed out waiting for its host-wide bounded web gate.");
      await delay(COORDINATION_POLL_MS, signal);
    }
  }

  async #post(message, { timeoutMs = 30_000, notification = false, signal } = {}) {
    if (typeof this.fetchImpl !== "function") throw error("FETCH_UNAVAILABLE", "Exa MCP requires fetch.");
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
      throw error("EXA_MCP_REQUEST_TOO_LARGE", "Exa MCP request exceeded its bounded size.");
    }
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const started = performance.now();
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers,
        body: serialized,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw error("EXA_MCP_REQUEST_FAILED", "Exa MCP request failed.", { causeCode: cause?.cause?.code ?? cause?.name ?? "UNKNOWN" });
    }
    const responseBody = await boundedTextResponse(response);
    if (!response.ok) {
      const code = [404, 410].includes(response.status) ? "EXA_MCP_SESSION_INVALID" : "EXA_MCP_RESPONSE_FAILED";
      throw error(code, `Exa MCP returned HTTP ${response.status}.`, {
        status: response.status,
        retryAfterMs: retryAfterMilliseconds(response),
        responseSha256: responseBody.sha256,
      });
    }
    const payload = parseMcpPayload(response, responseBody, { notification });
    if (payload && (payload.jsonrpc !== "2.0" || (message.id !== undefined && payload.id !== message.id))) {
      throw error("EXA_MCP_RESPONSE_INVALID", "Exa MCP returned a mismatched JSON-RPC response.", { responseSha256: responseBody.sha256 });
    }
    if (payload?.error) {
      throw error("EXA_MCP_TOOL_FAILED", "Exa MCP returned a JSON-RPC error.", {
        rpcCode: Number.isInteger(payload.error.code) ? payload.error.code : null,
        responseSha256: responseBody.sha256,
      });
    }
    return {
      payload,
      sessionId: response.headers?.get?.("mcp-session-id") ?? null,
      latencyMs: Math.round(performance.now() - started),
      responseSha256: responseBody.sha256,
      responseBytes: responseBody.bytes,
    };
  }

  async #initialize({ timeoutMs = 30_000, signal } = {}) {
    if (this.sessionId) return;
    this.initializing ??= (async () => {
      const initialized = await this.#post({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: EXA_MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "local-ai-fleet-cerebras-research", version: "1.0.0" },
        },
      }, { timeoutMs, signal });
      if (
        initialized.payload?.result?.serverInfo?.name !== EXA_MCP_SERVER_NAME
        || initialized.payload?.result?.protocolVersion !== EXA_MCP_PROTOCOL_VERSION
        || typeof initialized.sessionId !== "string"
        || !/^[\x21-\x7e]{1,512}$/u.test(initialized.sessionId)
      ) {
        throw error("EXA_MCP_IDENTITY_MISMATCH", "Exa MCP initialize response failed its pinned identity contract.", {
          responseSha256: initialized.responseSha256,
        });
      }
      this.sessionId = initialized.sessionId;
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, { notification: true, timeoutMs, signal });
      const listed = await this.#post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} }, { timeoutMs, signal });
      const tools = Array.isArray(listed.payload?.result?.tools) ? listed.payload.result.tools : [];
      const names = tools.map((tool) => tool?.name).filter((name) => typeof name === "string").sort();
      const expected = [...EXA_MCP_TOOL_NAMES].sort();
      if (names.length !== expected.length || names.some((name, index) => name !== expected[index]) || !validateToolContracts(tools)) {
        throw error("EXA_MCP_IDENTITY_MISMATCH", "Exa MCP exposed an unexpected tool set.", { responseSha256: listed.responseSha256 });
      }
    })();
    try { await this.initializing; }
    catch (cause) {
      this.sessionId = null;
      throw cause;
    } finally {
      this.initializing = null;
    }
  }

  async #callToolLocked(name, args, { timeoutMs = 30_000, retrySession = true, signal, coordinationWaitMs = 0 } = {}) {
    if (!EXA_MCP_TOOL_NAMES.includes(name)) throw error("EXA_MCP_TOOL_DENIED", "Only the pinned Exa search and fetch tools are permitted.");
    await this.#initialize({ timeoutMs, signal });
    try {
      const response = await this.#post({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }, { timeoutMs, signal });
      const result = response.payload?.result;
      if (result?.isError === true) throw error("EXA_MCP_TOOL_FAILED", `Exa ${name} reported failure.`, { responseSha256: response.responseSha256 });
      const text = Array.isArray(result?.content)
        ? result.content.filter((item) => item?.type === "text").map((item) => String(item.text ?? "")).join("\n").trim()
        : "";
      if (!text) throw error("EXA_MCP_TOOL_FAILED", `Exa ${name} returned no text evidence.`, { responseSha256: response.responseSha256 });
      return {
        text,
        latencyMs: response.latencyMs,
        responseSha256: response.responseSha256,
        responseBytes: response.responseBytes,
        providerTimeMs: Number.isFinite(result?.content?.[0]?._meta?.searchTime) ? result.content[0]._meta.searchTime : null,
        coordinationWaitMs,
      };
    } catch (cause) {
      if (retrySession && SESSION_RETRY_CODES.has(cause?.code)) {
        this.resetSession();
        return this.#callToolLocked(name, args, { timeoutMs, retrySession: false, signal, coordinationWaitMs });
      }
      throw cause;
    }
  }

  callTool(name, args, { timeoutMs = 30_000, retrySession = true, signal } = {}) {
    return this.#enqueue(async () => {
      const coordination = await this.#acquireCoordination({ timeoutMs, signal });
      try {
        return await this.#callToolLocked(name, args, {
          timeoutMs,
          retrySession,
          signal,
          coordinationWaitMs: coordination.waitMs,
        });
      } finally {
        await coordination.release();
      }
    });
  }

  search(query, { numResults = 3, timeoutMs = 30_000, signal } = {}) {
    const boundedQuery = validateQuery(query);
    if (!Number.isInteger(numResults) || numResults < 1 || numResults > 5) {
      throw error("EXA_MCP_ARGUMENT_INVALID", "Exa search numResults must be an integer from one through five.");
    }
    return this.callTool("web_search_exa", { query: boundedQuery, numResults }, { timeoutMs, signal });
  }

  fetchUrls(urls, { maxCharacters = 24_000, timeoutMs = 30_000, signal } = {}) {
    if (!Array.isArray(urls) || !urls.length || urls.length > MAX_URLS) {
      throw error("EXA_MCP_ARGUMENT_INVALID", `Exa fetch accepts one through ${MAX_URLS} URLs.`);
    }
    const safeUrls = [...new Set(urls.map(validateResearchUrl))];
    if (!Number.isInteger(maxCharacters) || maxCharacters < 1_000 || maxCharacters > 64_000) {
      throw error("EXA_MCP_ARGUMENT_INVALID", "Exa fetch maxCharacters must be from 1,000 through 64,000.");
    }
    return this.callTool("web_fetch_exa", { urls: safeUrls, maxCharacters }, { timeoutMs, signal });
  }
}
