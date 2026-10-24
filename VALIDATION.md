# Public source-kit validation

Executed October 23, 2026, before the initial public source release.

## Reproducible checks

Requires Python 3.11+ and Node.js 22+; these checks do not install the kit or start
models, model services or external tools.

```sh
python scripts/check-source.py
python scripts/verify-public.py
git diff --cached --check
```

Passed: 44 JavaScript syntax checks (including the text launcher templates),
7 Python syntax checks, 7 JSON parses, 10 TOML parses, and both source-only
launcher guard checks. The executable launchers contain only the guard import;
original sanitized launcher source is retained as text for adaptation.

The privacy-pattern check and sanitized-source SHA-256 checks passed. A separate
private publication check compared the export against the author's removed
bindings and searched credential assignments, JWT-shaped values, private DNS and
personal-path patterns, without printing matched values. The private comparison
map is outside this repository and is not distributed.

## Review scope and limits

Codex Security review covered the publication's source/privacy boundaries and
selected request, transport, filesystem, tool and source-hash application controls.
Independent review found no confirmed embedded credential or private endpoint.
It included whole-export pattern inspection and contextual review of candidates;
semantic security review of all transitive runtime internals remains incomplete.

This is a source kit, not a security-qualified deployable runtime. Host-native
sandbox implementations, actual local models, provider authentication, hardware
leases, deployed cancellation, concurrency, recipient-specific configuration,
and independent-machine installation were not tested by this export. No model
quality, savings percentage or frontier-equivalence claim follows from these
checks. Original upstream tests and verifier scripts were not rerun or claimed
as passing in this rearranged source-kit layout.

Privacy patterns and source hashes are useful checks, not proof that arbitrary
text contains no private information or that a later personalized copy is safe
to publish. Recheck that copy, staged files and reachable history independently.

## Early local-contribution decision gate

Both orchestration entry points now consult their matching public local-first
reference before cloud-auxiliary selection or substantial solo implementation.
The references share the same gate: consider a useful bounded contribution,
record a concrete route or skip reason, prefer suitable direct workers, and
distinguish a guarded on-demand worker that can launch from an unavailable
resident service. Existing model/effort prerequisites, no-auxiliary solo modes,
launch guards and native acceptance-review requirements remain binding.

This is an instruction-level correction. It does not establish future routing
compliance, measured utilization, fewer historical skips or realized savings.
No private audit counts, transcripts, identifiers or installation bindings are
included. The source/privacy checks above apply to the updated public files.

## Implementation allocation and builder handoff

The policy now allocates useful implementation and executable-test packets before
root-only delivery, independently of scouting. Sol can declare a route escalation
for newly discovered useful independent work as well as risk, while preserving
native role pins and mandatory fresh review for substantial delegated work.
Local MCP implementers use their own admission and source-bound receipt checks.

Read-only inference omits writable ownership; builder inference requires exact
allowedFiles and structured returned code files. A validation failure must not be
worked around by relabeling implementation as read-only testing. Parent source
inspection and authoritative tests remain required before accepting a proposal.

Fresh automatic real-work acceptance of these routing and handoff changes remains
pending. Instruction review, worker selection and a delivered receipt alone do not
establish useful accepted implementation or cost savings. Private test transcripts,
receipts, installation bindings and usage counts are excluded from this source kit.

## Codex-credit closing reports

The shared offline helper is preserved byte-for-byte from its reviewed portable
source, including a dated official Codex-credit rate snapshot and synthetic input.
It makes no network, inference or billing-account calls. The public policy links
both Advisors to the shared helper and selects Codex-credit reports for
ChatGPT-authenticated tasks; legacy API-equivalent receipts are conditional on
an explicitly selected API basis.

Fifteen synthetic tests cover exact arithmetic, cache uncertainty, incomplete
usage, repair/disposition accounting, supported speed combinations, safe token
totals, inert Markdown labels, CLI output creation and refusal to overwrite inputs
or existing outputs. Run them with:

```sh
node --test scripts/codex-credit-report/report.test.mjs scripts/codex-credit-report/cli.test.mjs
```

Source freezing, host-provided temporary fixtures and bounded complete-proposal
output guidance are included. No private receipts, account data, installed release
paths or later unreviewed runtime changes are part of this update. Calculator
correctness does not establish actual savings or whole-task usage coverage.

## Adaptive output-budget guidance

Both public local-first references distinguish separately qualified direct
adaptive runtimes (verified in 1.6.12) from older fixed-default contracts. The
guidance covers remaining prompt/schema/history space, reserve and minimum reply,
exact explicit limits, sensitive no-tokenizer admission and per-call evidence.
The optional external Hermes adapter is not qualified for adaptive fitting.

This update changes policy documentation only. The bundled guarded runtime
snapshot predates the adaptive repair; no adaptive implementation or runtime tests
are added here. Source-integrity, privacy-pattern and documentation checks do not
establish real inference, recipient installation or Windows AppContainer
compatibility. Restricted-worker execution remains unqualified; this update
contains no sandbox repair. The offline report helper and its host-test evidence
are unchanged.

## Documentation images

Three generated conceptual illustrations were added after the initial source
release. They contain no private image inputs and were visually reviewed for text,
layout and private details. The public verifier permits only their three exact
paths with SHA-256 values in `assets/images/manifest.json`; it validates PNG chunk
checksums and rejects text/EXIF metadata, unknown chunks and trailing data. The
generator's C2PA provenance is preserved and its readable claim text is checked
for private patterns. Other binary files remain rejected. Seven focused regression tests cover accepted bytes,
changed hashes, hidden metadata, trailing content, corrupt checksums and invalid
dimensions or missing termination, and provenance-claim privacy. Run them with:

```sh
python scripts/test_image_privacy.py
```

Final prompts and generation provenance: [image notes](assets/images/GENERATION.md).
