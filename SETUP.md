# Set up with Codex on your computer

The agent doing setup should read this file and the setup skill before changing
anything. There is no need to reproduce the author's network or hardware.

1. **Discover the existing setup.** Inspect the actual Codex version and available
   tools, the selected primary model/effort, operating system, local model servers,
   exact served model identities, available context, tool support, and shared-device
   ownership. Ask only for missing facts. Do not start a stopped service or install
   model weights just to see whether they are available.
2. **Create private configuration.** Copy `config/local.example.json` to
   `.local/advisor-config.json`. Fill it from observed local configuration. Keep
   secrets in an OS credential store or inherited environment variables, referenced
   by name. Never put a key in a prompt, command argument, checked-in file or example.
   `.local/`, environment files, logs and state are ignored by Git.
3. **Adapt the actual reference implementation.** Begin at
   `reference-runtime/src/advisor-local.mjs`, `advisor-parallel.mjs`,
   `advisor-coordinator-tools.mjs` and `advisor-apply-result.mjs`. Map worker pins,
   registry validation, transport, token counting and leases to private configuration.
   Replace every `SETUP_REQUIRED` path and `.invalid` destination that the chosen
   route can reach. Do not replace them by guessing values. The JSON template is a
   setup inventory, not a file the reference implementation already reads.
4. **Port host integrations deliberately.** Existing sandbox binaries, shell helpers,
   GPU health probes, memory guards, on-demand launchers, cancellation hooks, private
   research/retrieval connectors, and Hermes/OpenCode adapters were not exported.
   Use existing supported equivalents on the recipient machine. Keep optional
   integrations unavailable until their prerequisites pass; do not disable guards to
   make a startup check pass. A Linux sandbox and Windows AppContainer are different
   environments. Exact offline argv and disjoint file ownership remain required.
5. **Connect and qualify.** Check current official Codex plugin/MCP documentation.
   Use the user's actual active configuration home rather than a hardcoded home
   directory. Back up files before modifying them, merge the narrow change, and
   preserve other plugins. Do not install both a stock and customized copy with
   colliding identities. Confirm model/effort prerequisites in each Advisor skill;
   preserve the selected primary and report a mismatch without changing it.

## Minimum acceptance before enabling a route

Run a disposable read-only scout assignment first. Confirm the exact model,
source scope, a real response, and the hardware reservation's release. Then test
one small implementation proposal with explicit writable ownership in an isolated
snapshot. Review the returned diff and original source hashes, apply it through
the constrained parent route, and run an authoritative meaningful test.

For parallel workers, demonstrate independent resource ownership, rejection of
overlapping writes and no accidental double-loading on the same physical GPU.
For tools, test that undeclared files, path traversal, unapproved commands and
secret inputs are rejected. Test actual cancellation delivery and cleanup before
claiming unattended cancellation works. A timeout is an unknown outcome until
actual worker/lease state is inspected; never blindly repeat a write.

Enable only the routes that passed. The actual sanitized launchers are stored as
text under `reference-runtime/launcher-templates/`. Restoring an adapted launcher
into `bin/` and removing its source-guard import is the final local setup step
after adaptation, inspection and tests; it is not the adaptation itself. Do not
claim the reference snapshot runs unchanged. Inherited upstream verification
scripts also assume their original repository layouts; adapt those paths and use
their results honestly. `sharp` and optional tool integrations such as Playwright
are not installed by this source kit; resolve their versions and platform support
before enabling the routes that use them.

## Everyday routing

Use local workers for useful independent bounded work, without mandatory worker
counts or filler jobs. Prefer inference from supplied sources when sufficient;
enable a tool loop only for actual file discovery, edits or tests. Keep native
independent acceptance reviews required by the selected Advisor. Local failure
does not authorize a cloud call in a local-only task, nor a model/service change.

## Before publishing your adapted copy

Run `python scripts/verify-public.py`, review the complete staged diff and every
reachable Git blob, and use a separate secret scanner appropriate to your toolchain.
The included check catches specific patterns; it cannot certify arbitrary private
text. Keep the original MIT notices and state exactly what you changed. Never push
the installer's local configuration, logs, receipts or original personal Git history.

Official packaging reference: https://developers.openai.com/plugins/build/plugins
