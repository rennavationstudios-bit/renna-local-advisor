---
name: orchestration
description: "Codex-native risk-gated selective routing: default solo delivery, targeted native delegation or audit, and full review for substantial delegated work."
---

# Sol Advisor Orchestration

Act as the architect. Own the user's intent, architecture, route choice, decomposition,
implementation or delegation, parent verification, escalation decisions, and final
acceptance. Selective routing has four exact modes: `solo`, `delegate`, `audit`, and
`full`. Solo is the default. Select a dynamic, task-scoped set of auxiliaries only
when the dependency graph, specialization, disjoint ownership, cost, and observed
runtime availability make their work useful. There is no policy headcount ceiling.
Changing the selected capacity as independent work starts or drains is scheduling, not
a risk-route downgrade.

UltraBurn is a separate explicit-only skill in this same plugin. Its presence does
not add a fifth selective route, change the primary Sol / High prerequisite, alter
normal selective routing, or activate high-compute work implicitly.

Read [references/role-contracts.md](references/role-contracts.md) before the first
delegation. Use [references/operations.md](references/operations.md) for exact spawn,
preflight, runtime-evidence, isolation, and maintainer procedures.

Before selecting a cloud auxiliary or beginning substantial solo implementation,
read the early decision gate in [the public local routing policy](references/local-first.md).
Consider a useful bounded local contribution at this point, not only after deciding
to delegate. Record the route or a concrete skip reason in the existing checkpoint.
This does not require dispatch for trivial, sequential or already-covered work.
If an auxiliary is selected, choose an existing delegation mode and preserve its
primary prerequisites; never dispatch in a no-auxiliary solo mode.
The installer must adapt the reference runtime to its own hardware before dispatch.

Select the local execution contract deliberately. When the worker can answer from the
exact supplied source capsule, require `execution:"inference"` and omit commands,
tool services, writable files, and the tool loop. Use `execution:"tools"` only when
the assignment materially needs repository discovery, edits, tests, browser, docs,
web, or retrieval; name that need in the packet. Credential-shaped source content
uses only the shared reference's explicit `local-only-transient`, inference-only,
read-only contract. It must never enter a cloud-capable route or native/cloud
delegate prompt, and it requires the bridge's fixed encrypted or host-local
transport plus metadata-only persistence.

## Confirm the primary session

Run the primary Codex session on gpt-6.1-sol with high reasoning. Verify the current
model and effort when runtime metadata exposes them. If either differs, tell the user
to select Sol / High and stop before delegation. If runtime metadata does not expose
them, ask the user to confirm Sol / High and stop until confirmed. A skill cannot
change the primary model itself; never assume or claim this prerequisite is satisfied.

## Declare the route before task tools

Before the first task tool call, emit one machine-auditable declaration:

~~~text
SELECTIVE ROUTE
mode: solo | delegate | audit | full
risk: <concise, task-specific rationale>
~~~

No task tool call may precede this declaration. Choose `solo` unless a stated risk
justifies another mode. A later declaration may only escalate the route when newly
observed risk justifies it; never silently downgrade. Record the evidence for an
escalation. Details and the task-scoped preflight matrix are in operations.md.

## Preflight selected auxiliaries only

Confirm Sol / High in the primary session. Preflight only auxiliaries selected by the
declared route: none for solo; each selected Luna / Max or Terra / High implementer for
delegate; fresh Sol / High for audit; and every selected implementer plus fresh Sol
reviewer for full. Public metadata
for role, model, and effort is authoritative. If it omits a model or effort, use the
local inspector only for that omitted field. Missing, conflicting, unavailable, or
unobservable evidence stops the affected lane; never silently substitute a role,
model, effort, or reviewer.

## Route delivery without duplication

- `solo`: root plans, implements, tests, and self-reviews; spawn no auxiliary.
- `delegate`: select Luna / Max for bounded, fully specified work, or Terra / High for
  judgment-heavy, high-risk, context-heavy, or wide-blast-radius work. Select multiple
  implementers only for independent packets with disjoint ownership. Root verifies; do
  not request a fresh review for non-substantial work.
- `audit`: root implements and verifies; a fresh read-only Sol / High reviewer reviews
  the accumulated diff; spawn no implementer.
- `full`: use for substantial delegated implementation, or when breadth or risk warrants
  it. Select the useful set of disjoint implementers, root verifies the accumulated diff
  and tests, then a fresh read-only Sol / High reviewer reviews. It is not numerically
  constrained and is not reserved solely for high-risk work.

Substantial root implementation uses `audit`; substantial delegated implementation uses
`full`. Both require a fresh Sol / High review after parent inspection of the complete
diff and test evidence.

Auxiliary work must substitute for root work, not duplicate it. A Luna result may
justify escalation to Terra / High only when it reveals newly observed complexity,
risk, wide blast radius, or misclassification. A corrected Luna attempt is reserved
for a specification error and is not a prerequisite for Terra. Any route change must
be declared and evidenced; do not silently downgrade.

## Keep architect work in the primary session

Keep these responsibilities in the primary session:

- Resolve requirements and material ambiguity.
- Choose architecture, interfaces, decomposition, and selective route.
- Write the complete five-part worker specification for any selected implementer.
- Inspect the actual diff and rerun verification.
- Decide whether newly observed risk warrants escalation.
- Judge the reviewer verdict when the route includes review and accept the deliverable.

Every worker prompt must contain OBJECTIVE, FILES AND OWNERSHIP, INTERFACES,
CONSTRAINTS, VERIFICATION, and the structured implementation return in
[the role contracts](references/role-contracts.md). State the exact owned files,
preserve concurrent edits, and never silently widen scope.

Treat worker reports as claims. Confirm the complete diff, changed-file scope, requested
checks, and artifact/runtime evidence in the parent session. Do not duplicate the
selected implementer's work in the primary session.

## Review only when the route includes it

For `audit` and `full`, after parent verification, spawn a new native Sol / High
reviewer. The reviewer must remain behaviorally read-only, inspect the actual
accumulated diff, and return exactly ship, fix-first, or rethink. A reviewer never
implements its own fixes. `solo` and `delegate` do not receive a fresh reviewer.

- ship: report completion with the verification evidence.
- fix-first applies only to `audit` and `full`:
  - audit: the root implements the required correction, re-verifies, and obtains a new
    fresh reviewer.
  - full: the implementer that owns the required correction handles it, the root
    re-verifies, and a new fresh reviewer reviews.
  - solo and delegate: no fresh reviewer is added unless a newly observed,
    risk-evidenced route escalation is declared; never silently add one.
- rethink: revise the architecture and do not report completion.

Any implementation correction invalidates the prior verdict. Apply the observed sandbox
and permission profile rules in the operations reference; never claim enforced
read-only isolation when it was not observed.
