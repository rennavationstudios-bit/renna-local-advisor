import fsp from "node:fs/promises";

import { FleetError } from "./errors.mjs";
import { assertNoSecretValues, nowIso, sha256 } from "./util.mjs";

const LOOPBACK_HOSTS = new Set(["SETUP_REQUIRED_ADDRESS_1", "::1", "localhost"]);

export function validateLiteLLMBaseUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new FleetError("LITELLM_CONFIG_INVALID", "LiteLLM base URL is invalid."); }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.port !== "33192" || !/^\/v1\/?$/.test(url.pathname)) {
    throw new FleetError("LITELLM_CONFIG_INVALID", "LiteLLM must use the fixed loopback gateway https://worker-1.invalid/v1.");
  }
  return "https://worker-1.invalid/v1";
}

async function readKey(file) {
  const key = (await fsp.readFile(file, "utf8")).trim();
  if (!/^sk-[A-Za-z0-9_-]{32,200}$/.test(key)) throw new FleetError("LITELLM_CREDENTIAL_INVALID", "LiteLLM credential file is missing or malformed.");
  return key;
}

async function boundedJson(response, maximumBytes = 2_000_000) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new FleetError("LITELLM_RESPONSE_TOO_LARGE", "LiteLLM response exceeded its bounded size.");
  try { return { body: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) }; }
  catch { throw new FleetError("LITELLM_RESPONSE_INVALID", "LiteLLM returned invalid JSON.", { bodySha256: sha256(bytes) }); }
}

export class LiteLLMClient {
  constructor({ baseUrl, credentialRef, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = validateLiteLLMBaseUrl(baseUrl);
    this.credentialRef = credentialRef;
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, { method = "GET", body, timeoutMs = 30_000, signal } = {}) {
    if (typeof this.fetchImpl !== "function") throw new FleetError("FETCH_UNAVAILABLE", "LiteLLM requires fetch.");
    const key = await readKey(this.credentialRef);
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      method,
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((error) => {
      throw new FleetError("LITELLM_REQUEST_FAILED", "LiteLLM request failed.", { causeCode: error?.cause?.code ?? error?.name ?? "UNKNOWN" });
    });
    const parsed = await boundedJson(response);
    if (!response.ok) throw new FleetError("LITELLM_RESPONSE_FAILED", `LiteLLM returned HTTP ${response.status}.`, {
      status: response.status,
      bodySha256: parsed.sha256,
      errorType: parsed.body?.error?.type ?? null,
      errorCode: parsed.body?.error?.code ?? null,
    });
    return { ...parsed, response };
  }

  async health() {
    const checkedAt = nowIso();
    const { body, sha256: bodySha256 } = await this.request("/models", { timeoutMs: 15_000 });
    const models = Array.isArray(body?.data) ? body.data.map((item) => item?.id).filter((id) => typeof id === "string").sort() : [];
    const result = { ok: true, baseUrl: this.baseUrl, models, checkedAt, bodySha256, providerRouter: "LiteLLM", integrationAuthorized: false };
    assertNoSecretValues(result, "litellm-health");
    return result;
  }

  async chat(body, options = {}) { return this.request("/chat/completions", { ...options, method: "POST", body }); }
  async responses(body, options = {}) { return this.request("/responses", { ...options, method: "POST", body }); }
}
