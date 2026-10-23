import { FleetError } from "./errors.mjs";
import { sha256 } from "./util.mjs";

export const CEREBRAS_DIRECT_BASE_URL = "https://api.cerebras.ai/v1";
export const CEREBRAS_DIRECT_CHAT_URL = `${CEREBRAS_DIRECT_BASE_URL}/chat/completions`;
export const CEREBRAS_DIRECT_MODEL_IDS = Object.freeze([
  "qwen-3.8-27b",
]);
const PINNED_MODEL_IDS = new Set(CEREBRAS_DIRECT_MODEL_IDS);

const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_KEY_CHARS = 512;

function readProtectedKey(environment) {
  const key = environment?.CEREBRAS_API_KEY;
  if (
    typeof key !== "string"
    || key.length < 20
    || key.length > MAX_KEY_CHARS
    || key.trim() !== key
    || /\s/u.test(key)
    || !/^[\x21-\x7e]+$/u.test(key)
  ) {
    throw new FleetError(
      "CEREBRAS_DIRECT_CREDENTIAL_INVALID",
      "CEREBRAS_API_KEY is missing or malformed in the persistent MCP process environment.",
    );
  }
  return key;
}

async function boundedJson(response, maximumBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    try { await response.body?.cancel?.(); } catch { /* bounded failure is already determined */ }
    throw new FleetError("CEREBRAS_DIRECT_RESPONSE_TOO_LARGE", "Direct Cerebras response exceeded its bounded size.");
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
          throw new FleetError("CEREBRAS_DIRECT_RESPONSE_TOO_LARGE", "Direct Cerebras response exceeded its bounded size.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const chunk = Buffer.from(await response.arrayBuffer());
    totalBytes = chunk.length;
    if (totalBytes > maximumBytes) {
      throw new FleetError("CEREBRAS_DIRECT_RESPONSE_TOO_LARGE", "Direct Cerebras response exceeded its bounded size.");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  const bodySha256 = sha256(bytes);
  try {
    return { body: JSON.parse(bytes.toString("utf8")), sha256: bodySha256 };
  } catch {
    throw new FleetError("CEREBRAS_DIRECT_RESPONSE_INVALID", "Direct Cerebras returned invalid JSON.", { bodySha256 });
  }
}

/**
 * Minimal persistent-process Cerebras Chat Completions client.
 *
 * Node's process-global fetch dispatcher owns the warm HTTPS connection pool.
 * Keeping one instance alive in the MCP module therefore reuses both this
 * client and its underlying keep-alive connections without adding an SDK or a
 * second proxy hop to the pre-model critical path.
 */
export class CerebrasDirectClient {
  constructor({ fetchImpl = globalThis.fetch, environment = process.env } = {}) {
    this.fetchImpl = fetchImpl;
    this.environment = environment;
    this.baseUrl = CEREBRAS_DIRECT_BASE_URL;
    this.transport = "direct-cerebras";
  }

  async chat(body, { timeoutMs = 30_000, signal } = {}) {
    if (typeof this.fetchImpl !== "function") {
      throw new FleetError("FETCH_UNAVAILABLE", "Direct Cerebras requires fetch.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || !PINNED_MODEL_IDS.has(body.model)) {
      throw new FleetError(
        "CEREBRAS_DIRECT_MODEL_INVALID",
        "Direct Cerebras accepts only the pinned qwen-3.8-27b model ID.",
      );
    }
    const key = readProtectedKey(this.environment);
    let serializedBody;
    try { serializedBody = JSON.stringify(body); }
    catch {
      throw new FleetError("CEREBRAS_DIRECT_REQUEST_INVALID", "Direct Cerebras request was not serializable.");
    }
    if (Buffer.byteLength(serializedBody, "utf8") > MAX_REQUEST_BYTES) {
      throw new FleetError("CEREBRAS_DIRECT_REQUEST_TOO_LARGE", "Direct Cerebras request exceeded its bounded size.");
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(CEREBRAS_DIRECT_CHAT_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: serializedBody,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new FleetError("CEREBRAS_DIRECT_REQUEST_FAILED", "Direct Cerebras request failed.", {
        causeCode: error?.cause?.code ?? error?.name ?? "UNKNOWN",
      });
    }
    const parsed = await boundedJson(response);
    if (!response.ok) {
      throw new FleetError("CEREBRAS_DIRECT_RESPONSE_FAILED", `Direct Cerebras returned HTTP ${response.status}.`, {
        status: response.status,
        bodySha256: parsed.sha256,
        errorType: typeof parsed.body?.error?.type === "string" ? parsed.body.error.type.slice(0, 120) : null,
        errorCode: typeof parsed.body?.error?.code === "string" ? parsed.body.error.code.slice(0, 120) : null,
      });
    }
    return { ...parsed, response };
  }
}
