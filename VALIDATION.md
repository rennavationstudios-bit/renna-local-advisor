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
