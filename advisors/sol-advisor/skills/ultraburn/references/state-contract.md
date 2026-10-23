# UltraBurn durable state contract

UltraBurn keeps recovery metadata outside repositories under
`$CODEX_HOME/ultraburn` when `CODEX_HOME` is set, otherwise under
`~/.codex/ultraburn`. The helper is resolved relative to this skill:

~~~text
<skill directory>/../../scripts/ultraburn-state.py
~~~

Every run has `runs/<run-id>/run.json`. Repository pointers live under
`active/<repository-hash>.json`. Writes use a scoped lock plus atomic replace.
The helper never edits a repository, launches an agent, contacts a service, or
changes Git. It records the canonical repository, base HEAD, initial and current
Git status, controls, tasks, events, stop request, outcome, and report path.
It refuses a state root located inside the target repository and invokes Git
reads with optional locks disabled. Terminal finish also persists final HEAD,
branch, Git status, and finish time before clearing the active pointer.

## Commands

Use the active Python executable and pass the helper path exactly.

~~~text
python ultraburn-state.py start --repo <path> --operation plan|run --preset conservative|aggressive|maximum --max-runtime-minutes <1..1440> --max-workers <nonnegative> --effective-max-workers <nonnegative> --max-risk low|medium|high [--deadline <ISO-8601-with-zone>] [--stop-buffer-minutes <5..120>]
python ultraburn-state.py task --run-id <id> --task-id <id> --title <text> --status discovered|queued|running|verifying|completed|failed|rejected|blocked|skipped [--details-json <object>]
python ultraburn-state.py update-capacity --run-id <id> --max-workers <nonnegative> --effective-max-workers <nonnegative>
python ultraburn-state.py finish --run-id <id> --outcome planned|completed|partial|blocked|stopped|failed --summary <text> [--report-path <path>]
python ultraburn-state.py activate --run-id <planned-id>
python ultraburn-state.py status [--run-id <id> | --repo <path>]
python ultraburn-state.py check-stop --run-id <id>
python ultraburn-state.py stop [--run-id <id> | --repo <path>] [--reason <text>]
~~~

`check-stop` prints `CONTINUE` and exits 0 only while new work may launch. It
prints `STOP` and exits 3 after a stop request, deadline buffer, runtime limit,
or terminal state. Call it before every new discovery, implementation, repair,
or review packet. A stop never kills a process; active work drains to the next
safe checkpoint, then the coordinator records `stopped`.

`planned` retains the active pointer so `activate` can run that exact backlog.
Terminal outcomes clear the pointer only when it still names the same run.
Status is evidence, not authority: inspect the live repository before acting.

Requested and effective capacity are nonnegative task-scoped controls, without a policy
maximum. The parent chooses effective capacity only after observing live runtime
availability; the helper persists that coordinator decision but does not claim to
observe or reserve host capacity. `update-capacity` can raise or lower both controls
while planning or running. It refuses an effective capacity below active tasks, so a
lower target takes effect only after active work drains.

New task records fail closed unless they include meaningful nonblank evidence, expected value,
confidence, risk, complexity, cost, dependencies, verification, concurrency
safety, and a nonempty mutable file scope. Null evidence and blank paths or
verification steps are rejected. Persisted controls are range-checked and
cross-validated against the computed hard stop. Every read or mutation is bound
to the same live repository identity under its repository lock. A completed run
requires terminal task state and at least one task that passed through
`verifying` to `completed`.
