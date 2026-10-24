# Codex-credit closing report

For ChatGPT-authenticated Astra and Sol tasks, report Codex-credit equivalent rather than API-dollar equivalent. Keep actual API work and explicitly requested API comparisons separate. If the billing basis is not observable, label the scenario instead of claiming observed billing.

Use the shared offline [helper and schema](../scripts/codex-credit-report/README.md). It requires Node.js 22+ and makes no network or inference calls. Its [rate card](../scripts/codex-credit-report/rates.json) is an October 23, 2026 snapshot from [official Codex pricing](https://learn.chatgpt.com/docs/pricing) and [speed configuration](https://learn.chatgpt.com/docs/agent-configuration/speed); it is not a live-price guarantee. Preserve historical reports when updating rates.

## Evidence and primary disposition

Create one explicit input JSON from this task's known receipt metadata. Do not scan unrelated chats, query billing accounts, collect credentials or launch a telemetry service. Record the evidence source and cutoff in the existing checkpoint. Each attempt has a unique receipt ID, stable work ID, worker/model, status, primary disposition, known usage and duration. Use null/omitted values for missing counts. Delivery does not establish useful work: inspect code/results and tests first. Only the primary assigns accepted, partial, discarded or pending.

Repairs reference earlier attempts within the same work item. Only one accepted or partial representative per work item is permitted; superseded attempts remain visible as discarded overhead. Repair processing is an overlapping subset, not an additional total. Classify model/code defects, harness failures and parent source mutations separately in the checkpoint. Do not use a hardware-failure narrative to hide rejected code, or blame a model for a demonstrated harness failure.

The model and speed in `comparison` are an explicit counterfactual scenario. Prefer the actual selected Codex primary when observable; preserve its effort as metadata. Unknown speed can be an explicitly labelled Standard assumption, never observed billing. The card uses purchased-credit Fast 2x/Ultrafast 6x where supported, not included-subscription allowance multipliers. No flat High-effort multiplier, separate cache-write fee or API context premium is added.

Local input/output counts are not equivalent tokenizer or reasoning behavior on Codex. Unknown cache yields a range; missing token usage yields only a known subtotal and coverage. Reasoning is already included in output. A subset of local attempts cannot establish complete parent/delegate/reviewer usage, whole-task credits, net credits avoided, weekly allowance saved or dollars saved. Any explicitly attributed observed Codex usage remains separate. Account-wide balance changes are not attributable while other tasks run.

## Run and retain

Use this source kit's bundled helper, resolving it relative to the repository rather than guessing a plugin cache version. From the repository root, run:

```text
node scripts/codex-credit-report/cli.mjs --input <explicit-input.json> --json <new-report.json> --md <new-report.md>
```

Keep private input and reports in an ignored task-output directory such as `.local/`, using unique names. The helper refuses existing output files and requires existing parent directories. Preserve the input and report; link the report and usage provenance from the existing recovery checkpoint. Do not publish private receipt IDs, paths, source text, prompts, credentials, account identifiers or production data. Public fixtures must be synthetic.

At completion, show a compact **Codex-credit report**: useful/partial/discarded attempt counts, known token coverage, accepted-work equivalent or explicit unavailability, repair overhead, rate date, and the limitation that this is not measured savings. Link the detailed report when useful. With no delegation, say no local work was delegated; never manufacture savings. With no usage, state unavailable and report the observed outcomes instead of zero cost. Failed or blocked tasks retain their failure accounting.

Do not restart workers merely to calculate a report. The calculator does not authorize account changes, code integration or publication. Original-source freezing, exact ownership, sandbox protections, GPU leases and required independent acceptance review remain unchanged.
