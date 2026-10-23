---
name: ultraburn
description: "Manually activate Sol Advisor UltraBurn to plan, run, inspect, or stop bounded high-compute engineering work before premium capacity resets. Explicit-only; never starts automatically or grants deployment, production, billing, trading, credential, account, publishing, messaging, or other external authority."
---

# Sol Advisor UltraBurn

UltraBurn is an explicit, temporary operating envelope inside Sol Advisor. Its
purpose is unused premium compute -> useful verified engineering work. It is not
a daemon, quota monitor, second scheduler, or reason to manufacture low-value
tasks. Normal Sol Advisor continues to use the exact `solo`, `delegate`, `audit`,
and `full` routes unchanged.

Read [the state contract](references/state-contract.md) before any operation.

## Require deliberate activation

Run only when the user explicitly invokes `$sol-advisor:ultraburn` or names
UltraBurn in the current request. Never infer activation from a deadline, usage
reset, large backlog, idle capacity, or an earlier run.

Accept four operations:

- `plan`: inspect and rank work without modifying repository files.
- `run`: execute an existing planned run or create and execute a new backlog.
- `status`: read durable state and live Git status; do not launch work.
- `stop`: request a graceful stop; do not kill active tools or workers.

Default to the current Git repository. One explicit repository path is allowed.
Do not crawl drives or run multiple repositories in one UltraBurn. A separate
explicit invocation may own another repository independently.

## Confirm the highest-compute route

The primary session must be exact `gpt-6.1-sol` with reasoning effort `ultra`.
For Codex CLI, launch a new process with the explicit `ultraburn` profile. The
profile file at `$CODEX_HOME/ultraburn.config.toml` must contain exact
`model_context_window = 1050000`, `model_auto_compact_token_limit = 1000000`,
and `model_auto_compact_token_limit_scope = "total"` settings alongside the exact
model and effort. This preserves one million tokens of active history before
compaction inside the model's 1,050,000-token window. A running session cannot be
expanded retroactively. Never add these settings to the base `config.toml` merely
to activate UltraBurn; normal Codex behavior stays unchanged.

Use this explicit CLI shape:

~~~powershell
codex.cmd exec --profile ultraburn -s workspace-write -C . '$sol-advisor:ultraburn plan|run|status|stop'
~~~

Use public runtime metadata first. If it omits either field, resolve
`../../scripts/inspect-primary-runtime.sh` relative to this skill and pass the
exact `CODEX_THREAD_ID`; that primary-only, allowlisted inspector is the sole
fallback. Do not use the native-agent inspector for a primary session. Missing,
conflicting, unavailable, or unobservable identity stops `plan` and `run`; never
pretend the route exists.
A skill cannot change its primary model. Tell the user to select Sol / Ultra and
restart the invocation when the prerequisite is not satisfied.

The current Codex model catalog, not memory or marketing terminology, is the
authority. `gpt-6.1-sol` plus `model_reasoning_effort = "ultra"` is the expected
route only while the live catalog supports it. There is no separate model named
"Sol Ultra" unless the catalog actually exposes one.

Preflight the existing Luna / Max and Terra / High roles only when selected for
mechanical or delegated implementation. Preflight the dedicated
`sol_advisor_ultraburn_reviewer` role before substantive mutation. It must resolve
to fresh `gpt-6.1-sol` / `ultra` with observed read-only isolation. Never silently
substitute the normal Sol / High reviewer for an UltraBurn review.

Resolve the installed plugin directory and run its companion installer in
non-mutating check mode with `--check --check-role ultraburn`. Then spawn the
reviewer with this exact native contract and no model/effort override:

~~~yaml
agent_type: sol_advisor_ultraburn_reviewer
fork_turns: none
~~~

Public runtime metadata is authoritative. Require observed
`model=gpt-6.1-sol`, `reasoning_effort=ultra`, and read-only isolation; use the
narrow local runtime inspector only for a field omitted by public metadata.
Missing, conflicting, or unobservable identity/isolation fails closed. A fresh
reviewer means a new native spawn after the final candidate diff and tests; any
subsequent edit invalidates its verdict.

## Apply hard controls

Every `plan` or new `run` requires and persists:

- preset: `conservative`, `aggressive`, or `maximum`;
- maximum runtime, capped at 24 hours;
- requested and effective auxiliary capacity, chosen from useful independent work,
  disjoint ownership, cost, and live host/session availability;
- maximum task risk: `low`, `medium`, or `high`;
- optional timezone-qualified deadline/reset time;
- stop buffer, default 15 minutes, before the deadline.

Do not edit global concurrency merely to satisfy a requested number. The parent observes
live runtime availability and records the selected effective capacity; the durable helper
does not claim to observe host capacity. Capacity has no policy headcount ceiling and may
grow or shrink as dependencies, ownership, cost, or live availability change. A reduction
cannot put selected effective capacity below active work; wait for work to drain first.
Do not fabricate quota, reset, token, or percentage data.
When trustworthy usage metadata is unavailable, use only user-supplied time and
intensity limits. Stop launching new work at the earliest runtime/deadline-buffer
boundary and reserve time for tests, review, integration inspection, and report.

Preset policy:

- `conservative`: audits, tests, documentation drift, and low-risk fixes.
- `aggressive`: broad discovery and independent medium-risk workstreams.
- `maximum`: deepest Sol reasoning and broad repository analysis; high risk is still
  bounded and reversible.

No preset overrides repository instructions, risk caps, tool permissions, or
external-side-effect boundaries.

## Plan from evidence

Before proposing work, inspect in order:

1. project/global instructions and existing plans or ledgers;
2. Git root, branch/HEAD, status, worktrees, and existing user changes;
3. README and architecture/operations documentation;
4. TODO/FIXME, open backlog/issues already available, and recent relevant history;
5. failing tests, build/lint/type/compiler warnings, and CI evidence;
6. incomplete code paths, error handling, observability, security, performance,
   accessibility, platform consistency, dependency health, and documentation drift;
7. deeper independent analysis only after repository evidence is exhausted.

Never fetch private issues or external systems unless already authorized and
available. Planning may write only UltraBurn state outside the repository.

For every candidate record task, evidence, expected value, confidence, risk,
likely complexity/cost, dependencies, verification method, mutable file scope,
and whether concurrency is safe. Rank approximately by
`expected value * confidence / (risk * cost)`, with actual defects, reliability,
security, important missing tests, and user-visible failures ahead of cleanup.
Reject speculative, cosmetic, or low-confidence work below a useful-value floor.

## Execute bounded packets

Before each new packet call `check-stop`. Stop discovery and launches on any
nonzero result. Keep the primary Sol / Ultra session as architect, difficult
debugger, integration owner, and final acceptance authority.

Each implementation packet declares:

- objective and concrete value;
- exact repository/worktree and owned files;
- interfaces and dependencies;
- constraints and prohibited areas;
- success criteria and exact tests;
- expected diff/evidence/report;
- done, partial, blocked, and rejected conditions.

Use Luna / Max for fully specified mechanical work and Terra / High for bounded
judgment-heavy implementation when that frees Sol / Ultra for harder reasoning.
The primary Sol / Ultra session handles architecture, subtle defects, complex
debugging, integration, and work that should consume premium reasoning. Parallelize
only disjoint mutable scopes and useful read-only investigations. One writer owns
each mutable packet. Never let worker activity substitute for value.

Before mutation, capture live Git status and protect every user change. Use an
isolated branch/worktree for every delegated mutating writer; long or parallel
runs always isolate writers. The primary may edit the caller checkout only for a
scoped non-delegated packet whose current state is safe to preserve. A dirty
checkout is not a baseline for a detached worker: either derive the packet from
committed state without consuming the dirty edits, or block and ask when the task
depends on those edits. Never reset, clean, checkout over, stash, or discard user
work. Never copy a whole worker worktree into the caller checkout.

Require exact diff, changed-file list, raw command exits, artifact hashes when
applicable, scope proof, and parent inspection. A worker narrative is not evidence.
Substantive mutation then requires a fresh `sol_advisor_ultraburn_reviewer` that
did not implement the change. The reviewer inspects the actual diff, surrounding
code, tests, requirements, regressions, security, and architecture and returns
exactly `ship`, `fix-first`, or `rethink`. Any correction invalidates the verdict
and requires fresh verification and a new reviewer. Reject or safely repair weak
work; preserve evidence from failed attempts.

After accepting a packet, update state, rerank the remaining backlog, and continue.
When the backlog is exhausted, perform at most one additional evidence audit. Stop
when no sufficiently valuable safe work remains.

## Report status and finish cleanly

`status` must show active workstreams, completed, failed/rejected, current
verification, remaining backlog, elapsed runtime, live Git status, stop conditions,
effective concurrency, and the run/report paths. Clearly separate worker claims
from verified outcomes.

`stop` only sets the durable stop request. Active operations may reach their next
safe checkpoint; no new discovery, implementation, repair, or review packet starts.
Inspect every owned worktree and mark the run `stopped`, `partial`, or `blocked`.
Never leave unknown mutation state.

Write a concise `report.md` beside `run.json` containing discovered, attempted,
completed, rejected, tests and exits, bugs found, files changed, checkpoints,
unresolved issues, next work, and safety boundaries. Finish state only after live
Git inspection and report creation.

## Absolute boundaries

UltraBurn authorizes repository-local engineering only. It never authorizes
spending money beyond existing approved Codex capacity, purchases, billing or
account changes, credentials or secret access, production mutation, deployment,
release/publication, protected-branch merge, signing, messages, posts, invitations,
financial transfers, cryptocurrency movement, or live trading. For financial
software it may research, code, backtest, simulate, unit/integration test, paper
trade, or shadow run only when the project already supports that safely. It never
raises risk limits, uses live capital, or changes paper/shadow mode to live.

Stop on identity mismatch, scope collision, missing isolation, user-work risk,
secret exposure, unapproved external effects, failed verification, exhausted
repair bounds, hard runtime/deadline, or a stop request. Preserve evidence and
report the precise blocker; never weaken a gate to keep burning.
