# Native operations

This is the maintainer and operator reference for Sol Advisor's native custom-agent
workflow. Keep the README user-facing; use this page when installing, delegating,
inspecting routing, or validating a release.

## Role pins and spawn contract

The installed TOMLs are the source of truth:

| Role type | Model | Effort | Use |
|---|---|---|---|
| sol_advisor_luna_implementer | gpt-6-luna | max | Delegate/full bounded routine implementation |
| sol_advisor_terra_implementer | gpt-5.6-terra | high | Delegate/full judgment-heavy or high-risk implementation |
| sol_advisor_sol_reviewer | gpt-6.1-sol | high | Audit/full fresh review; requests read-only sandbox |
| sol_advisor_ultraburn_reviewer | gpt-6.1-sol | ultra | Explicit UltraBurn fresh review; requests read-only sandbox |

Native spawn requests name the role and use a fresh context:

~~~text
agent_type: sol_advisor_luna_implementer
fork_turns: none
~~~

Use the Terra type only when the selected delegate or full route needs it:

~~~text
agent_type: sol_advisor_terra_implementer
fork_turns: none
~~~

Use a fresh Sol reviewer only for audit or full after parent verification:

~~~text
agent_type: sol_advisor_sol_reviewer
fork_turns: none
~~~

UltraBurn uses its own explicit-only skill and may spawn the dedicated reviewer only
after that skill has verified a Sol / Ultra primary session. Normal selective routes
never use it.

Its fresh review uses this exact native contract after a non-mutating
`--check --check-role ultraburn` preflight:

~~~yaml
agent_type: sol_advisor_ultraburn_reviewer
fork_turns: none
~~~

Do not attach model or reasoning overrides. Require public runtime evidence for
exact Sol / Ultra and observed read-only isolation, using the narrow runtime
inspector only for a field missing from public metadata. Missing, conflicting,
unavailable, or unobservable evidence fails closed. Any correction requires a
new spawn and verdict.

Do not attach model or reasoning overrides. A missing, conflicting, unavailable, or
unobservable role/model/effort is a hard stop; never substitute another role.

## Selective route declaration, preflight, and caching

The primary session must be Sol / High. Companion installation is separate from task
routing because plugin installation does not register user-owned TOMLs.

At installation or update time, run the repository-relative installer and its exactness
check:

~~~sh
sh plugins/sol-advisor/scripts/install-agents.sh
sh plugins/sol-advisor/scripts/install-agents.sh --check
~~~

When operating from an installed skill, resolve the same script relative to this
reference's parent skill:

~~~sh
skill_dir=<directory-containing-this-SKILL.md>
installer="$skill_dir/../../scripts/install-agents.sh"
sh "$installer" --check
~~~

The installer is fail-closed and performs its own post-install exactness check. It
recognizes only byte-exact historical templates, including the shipped v0.2.0 profiles
and the v0.5.0 Luna/Terra profiles during a v0.5.1 update. Modified/unsafe/nonregular/
symlinked/conflicting destinations remain refusals, and all mutations are preflighted.

The root emits one machine-auditable declaration before its first task tool call:

~~~text
SELECTIVE ROUTE
mode: solo | delegate | audit | full
risk: <concise, task-specific rationale>
~~~

Solo is the default. Select a dynamic task-scoped set of auxiliaries only where the
dependency graph, specialization, disjoint ownership, cost, and observed runtime
availability make it useful; no policy headcount ceiling applies. Use full for
substantial delegated implementation and optionally for breadth or risk. The root may
emit a later declaration only to escalate when newly observed risk justifies it. It
records that evidence and never silently downgrades.

Changing selected capacity as independent work starts or drains is scheduling, not a
risk-route downgrade. Substantial root implementation uses `audit`; substantial
delegated implementation uses `full`. Both require fresh Sol / High review after parent
inspection of the complete diff and test evidence.

The existing --check flag verifies all four roles. For task-scoped preflight, check
only the auxiliaries selected by the declaration; every check is non-mutating and
fail-closed:

| Route | Required companion checks |
|---|---|
| solo | None |
| delegate (Luna) | `--check --check-role luna` |
| delegate (Terra) | `--check --check-role terra` |
| delegate (Luna + Terra) | `--check --check-role luna --check-role terra` |
| audit | `--check --check-role sol` |
| full (Luna) | `--check --check-role luna --check-role sol` |
| full (Terra) | `--check --check-role terra --check-role sol` |
| full (Luna + Terra) | `--check --check-role luna --check-role terra --check-role sol` |
| explicit UltraBurn review | `--check --check-role ultraburn` |

For example:

~~~sh
sh plugins/sol-advisor/scripts/install-agents.sh --check --check-role luna
sh plugins/sol-advisor/scripts/install-agents.sh --check --check-role sol
~~~

Unknown or missing role arguments fail before any destination mutation. A selective
check ignores unselected role destinations, while the all-role --check behavior
remains unchanged. Cache successful checks only for the task; never carry them across
later tasks, installation/update, or routing/configuration changes.

Luna / Max is for bounded, fully specified work. Terra / High is selected for
judgment-heavy, high-risk, context-heavy, or wide-blast-radius work. A Luna result
may justify a declared Terra escalation only when it shows newly observed risk. One
corrected Luna attempt is reserved for a specification error and is not a prerequisite
for Terra.

If public metadata omits model or effort, use the local inspector below as a fallback
for those omitted fields only. Do not use it to replace available public evidence.

## Runtime routing evidence

The public spawn/details record is authoritative for the selected role and any exposed
model/effort. When model or effort is omitted, resolve the helper relative to the
installed skill and inspect the exact native thread ID:

~~~sh
skill_dir=<directory-containing-this-SKILL.md>
runtime_inspector="$skill_dir/../../scripts/inspect-agent-runtime.sh"
sh "$runtime_inspector" <native-subagent-thread-id>
~~~

For a disposable fixture or non-default session root:

~~~sh
sh "$runtime_inspector" --sessions-dir /absolute/path/to/sessions <native-subagent-thread-id>
~~~

The helper searches one exact rollout filename suffix and emits only allowlisted
routing fields. It refuses invalid IDs, zero/multiple matches, missing fields, or
conflicting model/effort/sandbox/permission/working-directory values. It never prints
prompts, messages, environment variables, tokens, configuration, or arbitrary rollout
payloads.

Accepted routing is Luna / max for bounded delegate/full implementation, Terra / high
for higher-risk delegate/full implementation, and Sol / high for audit/full review.
If public and local evidence both exist, they must agree. The local inspector is not a
model-selection fallback.

## Read-only reviewer interpretation

The reviewer TOML requests sandbox_mode = read-only. Capture the observed sandbox
policy type and permission profile type from public metadata or the inspector:

- Observed read-only sandbox: isolation is enforced.
- Broader host policy: continue only when hard isolation is not required, the prompt
  forbids edits, and the parent captures exact before/after repository and artifact
  state. Report the broader policy and profile as residual risk.
- Unobservable isolation, required hard isolation, or any mutation: stop the review and
  do not claim read-only isolation.

A reviewer returns exactly ship, fix-first, or rethink. A fix invalidates the prior
verdict; parent verification and a new fresh review are required.

## Worker packet and parent acceptance

Every Luna or Terra prompt uses the five-part packet in role-contracts.md:

- OBJECTIVE
- FILES AND OWNERSHIP
- INTERFACES
- CONSTRAINTS
- VERIFICATION

It must also request the structured implementation report. The parent owns architecture,
complete diff inspection, verification reruns, correction/escalation decisions, and
acceptance. Worker claims never replace direct inspection.

In solo, the root plans, implements, tests, and self-reviews with no auxiliary. In
delegate, selected Luna and/or Terra implementers complete independent non-substantial
packets with disjoint ownership and the root verifies with no fresh reviewer. In audit,
the root implements and verifies, then a fresh Sol reviewer reviews. In full, selected
implementers complete substantial or otherwise justified independent packets, the root
verifies the accumulated diff and tests, and a fresh Sol reviewer reviews. Auxiliary
work substitutes for root work; it does not duplicate it. A reviewer never fixes its
own findings.

## Maintainer verification

From the repository root, run:

~~~sh
sh plugins/sol-advisor/scripts/verify.sh
git diff --check
git status --short
git diff --stat
~~~

The verifier covers the v0.8.1+renna.2 manifest, exact four-role TOMLs, dynamic
selective-routing contracts, explicit UltraBurn policy/state fixtures, concise README
journey, absence of retired workflow references, installer safety fixtures, Luna
runtime evidence, JSON/TOML validity, Python checks, and shell syntax.
