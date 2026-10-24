# Offline Codex-credit report

Node.js 22+ standard libraries only. No install, network, service, credentials, account queries, or chat/receipt-directory scanning. The helper reads one explicit JSON input and the bundled rate snapshot, then creates JSON and Markdown reports.

From this folder:

```powershell
node cli.mjs --input example.json --json report.json --md report.md
node --test report.test.mjs cli.test.mjs
node cli.mjs --help
```

Output directories must already exist. Both outputs must be new files and distinct from the input. Existing files are never overwritten. Invalid input creates no reports. On an I/O failure between the two writes, the first report may remain; choose fresh names after resolving the error. Exit 0 means written, exit 1 means invalid input or I/O failure.

## Input schema

See `example.json` for a synthetic illustration, not this project's actual usage. The root requires `schemaVersion: 1`, `comparison: {model, speed}`, and `receipts: []`.

Each receipt is one attempt:

| Field | Meaning |
| --- | --- |
| `id` | Unique nonempty receipt identifier. |
| `workId` | Stable identifier for the original work and its repairs. |
| `worker`, `model` | Nonempty descriptive local labels; not pricing selectors. |
| `status` | `DELIVERED` or `FAILED`. |
| `disposition` | Primary's `accepted`, `partial`, `discarded`, or `pending` decision. |
| `runtimeMs` | Nonnegative safe integer or null/omitted for unknown. |
| `usage` | Object with `inputTokens`, `outputTokens`, `cachedInputTokens`; each count is a nonnegative safe integer or null/omitted. |
| `usage.reasoningTokens` | Optional output subset for evidence; never added again. |
| `effort` | Optional descriptive string; no price multiplier. |
| `repairOf` | Optional earlier receipt ID in the same work item. |

Known cached input requires known input and cannot exceed it. Known reasoning cannot exceed known output. There is one original receipt per work item. Repairs must reference an earlier attempt in that work item, so forward references and cycles are invalid. At most one accepted **or** partial attempt can represent a work item; mark superseded attempts discarded before marking a replacement useful. Failed attempts must be discarded. Accepted/partial requires delivery; delivery alone never implies acceptance.

Optional root `observedCodexCredits: {credits, source}` carries a separately supplied observation: finite nonnegative credits and a nonempty provenance string. It is never inferred from account balances, subtracted from a counterfactual, or used to infer savings. Do not put secrets in receipt labels or provenance.

## Report interpretation

The explicit comparison model and speed select a **same-token Codex-credit estimate**, not measured savings. Rates come from the supplied October 23, 2026 snapshot, whose sources are [Codex pricing](https://learn.chatgpt.com/docs/pricing) and [speed configuration](https://learn.chatgpt.com/docs/agent-configuration/speed). This program does not fetch or refresh them. Only combinations listed in `rates.json` are supported.

- Astra Standard: 100,000 uncached input + 10,000 output = **37.5 credits**; all input cached = **15**.
- Sol 6.1 Standard: the same counts = **7.5** or **2.75 credits**.
- Purchased-credit Fast multiplier is **2**; supported Ultrafast is **6**. These are not included-allowance multipliers.

Credit amounts and aggregated counters are decimal strings, preserving exact arithmetic. Unknown cache yields a minimum/maximum range. Missing input or output leaves a **known subtotal** and incomplete coverage; even an exact subtotal is not a whole-task total. Unknown fields are never assumed zero usage. A zero known subtotal can mean no usable usage evidence. Reasoning is already in output, effort has no flat multiplier, and there is no separate cache-write charge or API context surcharge.

`counts` reports attempts (`jobs`) and unique work items separately. Groups include all local processing, accepted useful, partial useful, discarded and pending. Repair processing is an **overlapping subset**, including successful repairs; discarded repair overhead isolates wasted repair attempts. Do not add repair groups to the main groups. Runtime totals are summed attempt durations, not elapsed wall time when jobs overlap.

Markdown escapes untrusted labels; JSON preserves originals. Coverage states how many jobs have known input, output, cache and runtime. User-supplied observed credits remain separate. Local tokenization and reasoning differ from the comparison model; no conversion to dollars, weekly allowance, account credits saved, or actual avoided spend is supported.

## Verification

Tests use synthetic data. Any filesystem fixtures use `os.tmpdir()` (the host-provided scratch directory in a restricted worker), never the read-only source/test directory. The input schema above documents the portable helper; task development receipts are not included in this installation. The CLI can run from a read-only source folder with explicitly writable report destinations.
