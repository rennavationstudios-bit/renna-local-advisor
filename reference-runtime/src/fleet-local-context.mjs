import { assertLocalContextFits, countLocalPromptTokens } from "./advisor-context.mjs";
import { FleetError } from "./errors.mjs";
import { haloHeaders } from "./halo-auth.mjs";

const PINS = Object.freeze([
  Object.freeze({ id: "halo-flash-next", model: "qwen3.8-flash-next-udiq4xs", alias: "local-halo-flash-next", base: "https://worker-6.invalid/v1", contextTokens: 262144 }),
  Object.freeze({ id: "rtx3090-superqwen", model: "rtx3090-superqwen3.8-27b-q4km", alias: "local-rtx3090-superqwen", base: "https://worker-5.invalid/v1", contextTokens: 65536 }),
  Object.freeze({ id: "ryzen-r9700", model: "superqwen3.8-27b-abliterated-q4km-r9700", alias: "local-r9700-qwen", base: "https://worker-3.invalid/v1", contextTokens: 262144 }),
  Object.freeze({ id: "ryzen-r9700-2", model: "superqwen3.8-27b-abliterated-q4km-r9700b", alias: "local-r9700b-qwen", base: "https://worker-4.invalid/v1", contextTokens: 262144 }),
]);
const fail = (code) => { throw new FleetError(code, "The pinned local Fleet model failed its request context or runtime identity gate."); };

export function fleetLocalContextPin(worker) {
  const pin = PINS.find((p) => p.model === worker?.model || (p.id === "rtx3090-superqwen" && p.id === worker?.id));
  if (!pin) return null; // Preserve all unrelated and cloud model contracts.
  if (worker.id !== pin.id || worker.model !== pin.model || worker.litellmModel !== pin.alias ||
      worker.contextTokens !== pin.contextTokens || worker.endpoint !== "https://worker-1.invalid/v1" ||
      (worker.adapterConfig?.litellmApiBase !== undefined && worker.adapterConfig.litellmApiBase !== pin.base)) fail("MODEL_IDENTITY_MISMATCH");
  return pin;
}

export function fleetLocalOutputTokens(worker, packet, legacyMaximum) {
  if (!fleetLocalContextPin(worker)) return legacyMaximum;
  const requested = packet.adapterInput?.maxOutputTokens ?? Math.min(legacyMaximum, 4096);
  if (!Number.isInteger(requested) || requested < 1 || requested > 16384) fail("OUTPUT_BUDGET_INVALID");
  return Math.min(legacyMaximum, requested);
}

export async function assertFleetLocalRequestFits({ worker, body, signal, fetchImpl = fetch, headersForPin = haloHeaders }) {
  const pin = fleetLocalContextPin(worker);
  if (!pin) return;
  if (!Array.isArray(body.messages) || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) fail("LOCAL_CONTEXT_REQUEST_INVALID");
  // Native sleep/unload can briefly block metadata while releasing the model.
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  boundedSignal.throwIfAborted();
  // This destination is host-owned. Never forward LiteLLM Authorization here.
  const response = await fetchImpl(`${pin.base.replace(/\/v1$/, "")}/props`, { headers: await headersForPin(pin), redirect: "error", signal: boundedSignal });
  if (!response.ok) fail("MODEL_IDENTITY_MISMATCH");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 131072) fail("MODEL_IDENTITY_MISMATCH");
    chunks.push(chunk);
  }
  let props;
  try { props = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("MODEL_IDENTITY_MISMATCH"); }
  if (props.model_alias !== pin.model || props.total_slots !== 1 || props.default_generation_settings?.n_ctx !== pin.contextTokens) fail("MODEL_IDENTITY_MISMATCH");
  await assertLocalContextFits({ pin, body, contextTokens: pin.contextTokens, maxOutputTokens: body.max_tokens, signal,
    countTokens: (selected, request, selectedSignal) => countLocalPromptTokens(selected, request, selectedSignal, fetchImpl) });
  signal?.throwIfAborted();
}
