#!/usr/bin/env python3
"""Small, repository-nonmutating state helper for Sol Advisor UltraBurn."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator


SCHEMA = "sol-advisor-ultraburn-run-v1"
POINTER_SCHEMA = "sol-advisor-ultraburn-active-v1"
TASK_STATES = {
    "discovered",
    "queued",
    "running",
    "verifying",
    "completed",
    "failed",
    "rejected",
    "blocked",
    "skipped",
}
TERMINAL_PHASES = {"COMPLETED", "PARTIAL", "BLOCKED", "STOPPED", "FAILED"}
OUTCOME_PHASES = {
    "planned": "PLANNED",
    "completed": "COMPLETED",
    "partial": "PARTIAL",
    "blocked": "BLOCKED",
    "stopped": "STOPPED",
    "failed": "FAILED",
}
RISK_LEVELS = {"low": 1, "medium": 2, "high": 3}
ACTIVE_TASK_STATES = {"running", "verifying"}
TASK_TRANSITIONS = {
    "discovered": {"queued", "blocked", "rejected", "skipped"},
    "queued": {"running", "blocked", "rejected", "skipped"},
    "running": {"verifying", "failed", "blocked", "skipped"},
    "verifying": {"completed", "failed", "rejected", "blocked"},
    "completed": set(),
    "failed": set(),
    "rejected": set(),
    "blocked": set(),
    "skipped": set(),
}
DETAIL_TYPES = {
    "expectedValue": (int, float),
    "confidence": (int, float),
    "risk": str,
    "complexity": str,
    "cost": (int, float),
    "dependencies": list,
    "verification": (str, list),
    "concurrent": bool,
    "fileScope": list,
    "worktree": (str, type(None)),
    "owner": (str, type(None)),
    "verificationStatus": str,
    "evidence": (list, dict),
    "notes": str,
}
REQUIRED_TASK_DETAILS = {
    "expectedValue",
    "confidence",
    "risk",
    "complexity",
    "cost",
    "dependencies",
    "verification",
    "concurrent",
    "fileScope",
    "evidence",
}
TERMINAL_TASK_STATES = {"completed", "failed", "rejected", "blocked", "skipped"}
LEGAL_FINISH_PHASES = {
    "PLANNING": {"PLANNED", "BLOCKED", "FAILED"},
    "PLANNED": {"BLOCKED", "FAILED"},
    "RUNNING": {"COMPLETED", "PARTIAL", "BLOCKED", "FAILED"},
    "STOP_REQUESTED": {"STOPPED", "PARTIAL", "BLOCKED", "FAILED"},
}


class UltraBurnError(RuntimeError):
    pass


def nonnegative_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a nonnegative integer") from exc
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a nonnegative integer")
    return parsed


def validate_capacity(requested: int, effective: int, active: int = 0) -> None:
    for label, value in (("requested", requested), ("effective", effective), ("active", active)):
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise UltraBurnError(f"{label} worker count is invalid")
    if effective > requested:
        raise UltraBurnError("effective worker count cannot exceed requested worker count")
    if effective < active:
        raise UltraBurnError("effective worker count cannot be below active task count")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise UltraBurnError(f"invalid ISO-8601 deadline: {value}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise UltraBurnError("deadline must include a timezone offset or Z")
    return parsed.astimezone(timezone.utc)


def run_git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "--no-optional-locks", "-C", str(repo), *args],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise UltraBurnError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout.rstrip("\r\n")


def repo_snapshot(value: str) -> dict[str, Any]:
    supplied = Path(value).expanduser().resolve(strict=True)
    top = Path(run_git(supplied, "rev-parse", "--show-toplevel")).resolve(strict=True)
    git_dir_text = run_git(top, "rev-parse", "--absolute-git-dir")
    git_dir = Path(git_dir_text).resolve(strict=True)
    git_dir_stat = git_dir.stat()
    head = run_git(top, "rev-parse", "--verify", "HEAD", check=False).strip() or None
    branch = run_git(top, "branch", "--show-current", check=False).strip() or None
    status = run_git(top, "status", "--short", "--branch", "--untracked-files=all")
    return {
        "repository": str(top),
        "gitDir": str(git_dir),
        "gitDirDevice": git_dir_stat.st_dev,
        "gitDirInode": git_dir_stat.st_ino,
        "head": head,
        "branch": branch,
        "gitStatus": status.splitlines(),
    }


def state_root() -> Path:
    configured = os.environ.get("CODEX_HOME")
    base = Path(configured).expanduser() if configured else Path.home() / ".codex"
    return base.resolve() / "ultraburn"


def ensure_state_root_outside_repository(root: Path, repository: str) -> None:
    resolved_root = root.resolve(strict=False)
    resolved_repository = Path(repository).resolve(strict=True)
    try:
        common = Path(os.path.commonpath((str(resolved_root), str(resolved_repository))))
    except ValueError:
        return
    if same_repository(str(common), str(resolved_repository)):
        raise UltraBurnError("UltraBurn state root must be outside the target repository")


def repo_key(repository: str) -> str:
    normalized = os.path.normcase(os.path.normpath(repository))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def same_repository(left: str, right: str) -> bool:
    return os.path.normcase(os.path.normpath(left)) == os.path.normcase(os.path.normpath(right))


def same_snapshot_identity(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return (
        same_repository(left["repository"], right["repository"])
        and same_repository(left["gitDir"], right["gitDir"])
        and left["gitDirDevice"] == right["gitDirDevice"]
        and left["gitDirInode"] == right["gitDirInode"]
    )


def meaningful_evidence(value: Any) -> bool:
    if value is None or isinstance(value, bool):
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (int, float)):
        return math.isfinite(value)
    if isinstance(value, list):
        return bool(value) and all(meaningful_evidence(item) for item in value)
    if isinstance(value, dict):
        return bool(value) and all(
            isinstance(key, str) and key.strip() and meaningful_evidence(item)
            for key, item in value.items()
        )
    return False


def run_path(root: Path, run_id: str) -> Path:
    if not run_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in run_id):
        raise UltraBurnError("run id contains unsupported characters")
    return root / "runs" / run_id / "run.json"


def pointer_path(root: Path, repository: str) -> Path:
    return root / "active" / f"{repo_key(repository)}.json"


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    handle, temporary = tempfile.mkstemp(prefix=".ultraburn-", suffix=".json", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class StateLock:
    def __init__(self, root: Path, key: str) -> None:
        self.path = root / "locks" / f"{key}.lock"

    def __enter__(self) -> "StateLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + 5.0
        while True:
            try:
                self.path.mkdir()
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise UltraBurnError(f"timed out waiting for state lock: {self.path}")
                time.sleep(0.05)
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.path.rmdir()


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise UltraBurnError(f"state file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise UltraBurnError(f"state file is invalid JSON: {path}") from exc
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise UltraBurnError(f"state file has unsupported schema: {path}")
    expected_run_fields = {
        "schema", "runId", "repository", "gitDir", "gitDirDevice", "gitDirInode",
        "baseHead", "baseBranch", "initialGitStatus", "operation", "preset", "phase",
        "startedAt", "updatedAt", "stopRequestedAt", "stopReason", "outcomeSummary",
        "reportPath", "finalHead", "finalBranch", "finalGitStatus", "finishedAt",
        "controls", "tasks", "events",
    }
    if set(value) != expected_run_fields:
        raise UltraBurnError(f"state has missing or unsupported top-level fields: {path}")
    required_strings = ("runId", "repository", "gitDir", "operation", "preset", "phase", "startedAt", "updatedAt")
    for field in required_strings:
        if not isinstance(value.get(field), str) or not value[field]:
            raise UltraBurnError(f"state field {field} is invalid: {path}")
    if value["runId"] != path.parent.name:
        raise UltraBurnError(f"state runId does not match its run directory: {path}")
    if value["operation"] not in {"plan", "run"}:
        raise UltraBurnError(f"state operation is invalid: {path}")
    if value["preset"] not in {"conservative", "aggressive", "maximum"}:
        raise UltraBurnError(f"state preset is invalid: {path}")
    valid_phases = {"PLANNING", "PLANNED", "RUNNING", "STOP_REQUESTED"} | TERMINAL_PHASES
    if value["phase"] not in valid_phases:
        raise UltraBurnError(f"state phase is invalid: {path}")
    if not Path(value["repository"]).is_absolute() or not Path(value["gitDir"]).is_absolute():
        raise UltraBurnError(f"state repository paths must be absolute: {path}")
    for field in ("gitDirDevice", "gitDirInode"):
        if not isinstance(value.get(field), int) or isinstance(value[field], bool) or value[field] < 0:
            raise UltraBurnError(f"state field {field} is invalid: {path}")
    for field in (
        "baseHead", "baseBranch", "stopRequestedAt", "stopReason", "outcomeSummary",
        "reportPath", "finalHead", "finalBranch", "finishedAt",
    ):
        if value.get(field) is not None and not isinstance(value.get(field), str):
            raise UltraBurnError(f"state field {field} is invalid: {path}")
    initial_status = value.get("initialGitStatus")
    if not isinstance(initial_status, list) or any(not isinstance(item, str) for item in initial_status):
        raise UltraBurnError(f"state initialGitStatus is invalid: {path}")
    final_status = value.get("finalGitStatus")
    if final_status is not None and (
        not isinstance(final_status, list) or any(not isinstance(item, str) for item in final_status)
    ):
        raise UltraBurnError(f"state finalGitStatus is invalid: {path}")
    controls = value.get("controls")
    if not isinstance(controls, dict):
        raise UltraBurnError(f"state controls are invalid: {path}")
    expected_control_fields = {
        "maxRuntimeMinutes", "requestedMaxWorkers", "effectiveMaxWorkers", "maxRisk",
        "deadline", "stopBufferMinutes", "hardStopAt", "quotaPercent",
    }
    if set(controls) != expected_control_fields:
        raise UltraBurnError(f"state controls have missing or unsupported fields: {path}")
    bounded_controls = {
        "maxRuntimeMinutes": (1, 1440),
        "stopBufferMinutes": (5, 120),
    }
    for field, (minimum, maximum) in bounded_controls.items():
        current = controls.get(field)
        if (
            not isinstance(current, int)
            or isinstance(current, bool)
            or current < minimum
            or current > maximum
        ):
            raise UltraBurnError(f"state control {field} is outside {minimum}..{maximum}: {path}")
    try:
        validate_capacity(controls["requestedMaxWorkers"], controls["effectiveMaxWorkers"])
    except UltraBurnError as exc:
        raise UltraBurnError(f"state capacity controls are invalid: {path}: {exc}") from exc
    if controls.get("maxRisk") not in RISK_LEVELS:
        raise UltraBurnError(f"state control maxRisk is invalid: {path}")
    if not isinstance(controls.get("hardStopAt"), str):
        raise UltraBurnError(f"state control hardStopAt is invalid: {path}")
    if controls.get("deadline") is not None and not isinstance(controls.get("deadline"), str):
        raise UltraBurnError(f"state control deadline is invalid: {path}")
    if controls.get("quotaPercent") is not None:
        raise UltraBurnError(f"state quotaPercent must remain null without trustworthy usage metadata: {path}")
    started_at = parse_iso(value["startedAt"])
    updated_at = parse_iso(value["updatedAt"])
    hard_stop_at = parse_iso(controls["hardStopAt"])
    if updated_at < started_at:
        raise UltraBurnError(f"state updatedAt precedes startedAt: {path}")
    runtime_stop = started_at + timedelta(minutes=controls["maxRuntimeMinutes"])
    if controls.get("deadline"):
        deadline = parse_iso(controls["deadline"])
        deadline_stop = deadline - timedelta(minutes=controls["stopBufferMinutes"])
        if deadline <= started_at or deadline_stop <= started_at:
            raise UltraBurnError(f"state deadline and stop buffer leave no execution time: {path}")
        expected_hard_stop = min(runtime_stop, deadline_stop)
    else:
        expected_hard_stop = runtime_stop
    if hard_stop_at != expected_hard_stop:
        raise UltraBurnError(f"state hardStopAt does not match runtime/deadline controls: {path}")

    tasks = value.get("tasks")
    if not isinstance(tasks, list) or any(not isinstance(item, dict) for item in tasks):
        raise UltraBurnError(f"state tasks are invalid: {path}")
    allowed_task_fields = {"taskId", "title", "status", "updatedAt", "history"} | set(DETAIL_TYPES)
    active_count = 0
    task_ids: set[str] = set()
    for task in tasks:
        if set(task) - allowed_task_fields:
            raise UltraBurnError(f"state task contains unsupported fields: {path}")
        if (
            not isinstance(task.get("taskId"), str)
            or not task["taskId"]
            or not isinstance(task.get("title"), str)
            or not task["title"].strip()
        ):
            raise UltraBurnError(f"state task identity is invalid: {path}")
        if task["taskId"] in task_ids:
            raise UltraBurnError(f"state contains duplicate task IDs: {path}")
        task_ids.add(task["taskId"])
        if not REQUIRED_TASK_DETAILS.issubset(task):
            raise UltraBurnError(f"state task is missing required evidence/value fields: {path}")
        if task.get("status") not in TASK_STATES:
            raise UltraBurnError(f"state task status is invalid: {path}")
        if task["status"] in ACTIVE_TASK_STATES:
            active_count += 1
        if task.get("risk") not in RISK_LEVELS or RISK_LEVELS[task["risk"]] > RISK_LEVELS[controls["maxRisk"]]:
            raise UltraBurnError(f"state task risk is invalid or above maxRisk: {path}")
        if not isinstance(task.get("updatedAt"), str):
            raise UltraBurnError(f"state task updatedAt is invalid: {path}")
        parse_iso(task["updatedAt"])
        history = task.get("history")
        if not isinstance(history, list) or not history:
            raise UltraBurnError(f"state task history is invalid: {path}")
        previous_status: str | None = None
        previous_at: datetime | None = None
        for item in history:
            if (
                not isinstance(item, dict)
                or set(item) != {"at", "status"}
                or not isinstance(item.get("at"), str)
                or item.get("status") not in TASK_STATES
            ):
                raise UltraBurnError(f"state task history entry is invalid: {path}")
            item_at = parse_iso(item["at"])
            if previous_at is not None and item_at < previous_at:
                raise UltraBurnError(f"state task history timestamps are out of order: {path}")
            if previous_status is None:
                if item["status"] not in {"discovered", "queued"}:
                    raise UltraBurnError(f"state task history has an invalid initial status: {path}")
            elif item["status"] != previous_status and item["status"] not in TASK_TRANSITIONS[previous_status]:
                raise UltraBurnError(f"state task history contains an illegal transition: {path}")
            elif previous_status in TERMINAL_TASK_STATES:
                raise UltraBurnError(f"state task history mutates a terminal task: {path}")
            previous_status = item["status"]
            previous_at = item_at
        if history[-1]["status"] != task["status"]:
            raise UltraBurnError(f"state task status does not match its history: {path}")
        for field, expected in DETAIL_TYPES.items():
            if field in task and not isinstance(task[field], expected):
                raise UltraBurnError(f"state task field {field} has an invalid type: {path}")
        for field in ("dependencies", "fileScope"):
            if field in task and any(not isinstance(item, str) or not item.strip() for item in task[field]):
                raise UltraBurnError(f"state task field {field} must contain nonempty strings: {path}")
        if not task["fileScope"]:
            raise UltraBurnError(f"state task fileScope cannot be empty: {path}")
        verification = task.get("verification")
        if isinstance(verification, str):
            if not verification.strip():
                raise UltraBurnError(f"state task verification cannot be blank: {path}")
        elif not verification or any(not isinstance(item, str) or not item.strip() for item in verification):
            raise UltraBurnError(f"state task verification must contain nonempty strings: {path}")
        for field in ("expectedValue", "confidence", "cost"):
            if field in task and isinstance(task[field], bool):
                raise UltraBurnError(f"state task field {field} must be numeric: {path}")
        if (
            not all(math.isfinite(task[field]) for field in ("expectedValue", "confidence", "cost"))
            or task["expectedValue"] <= 0
            or task["cost"] <= 0
            or not 0 <= task["confidence"] <= 1
        ):
            raise UltraBurnError(f"state task value/confidence/cost is outside its valid range: {path}")
        if not task["complexity"].strip() or not meaningful_evidence(task["evidence"]):
            raise UltraBurnError(f"state task evidence/complexity/verification is empty: {path}")
    try:
        validate_capacity(controls["requestedMaxWorkers"], controls["effectiveMaxWorkers"], active_count)
    except UltraBurnError as exc:
        raise UltraBurnError(f"state capacity controls are invalid: {path}: {exc}") from exc

    events = value.get("events")
    if not isinstance(events, list) or not events:
        raise UltraBurnError(f"state events are invalid: {path}")
    for event in events:
        if (
            not isinstance(event, dict)
            or set(event) - {"at", "type", "details"}
            or not isinstance(event.get("at"), str)
            or not isinstance(event.get("type"), str)
            or not event["type"].strip()
            or ("details" in event and not isinstance(event["details"], dict))
        ):
            raise UltraBurnError(f"state event entry is invalid: {path}")
        parse_iso(event["at"])
    if value["phase"] in TERMINAL_PHASES:
        if not value.get("finishedAt") or value.get("finalGitStatus") is None:
            raise UltraBurnError(f"terminal state is missing final Git evidence: {path}")
        parse_iso(value["finishedAt"])
        report_value = value.get("reportPath")
        if not report_value:
            raise UltraBurnError(f"terminal state is missing reportPath: {path}")
        report = Path(report_value)
        expected_report = path.parent / "report.md"
        if report.is_symlink() or not report.is_file() or report.stat().st_size == 0:
            raise UltraBurnError(f"terminal report is missing, empty, or unsafe: {report}")
        if not same_repository(str(report.resolve(strict=True)), str(expected_report.resolve(strict=True))):
            raise UltraBurnError(f"terminal report must be beside run.json: {report}")
    elif any(value.get(field) is not None for field in ("finalHead", "finalBranch", "finalGitStatus", "finishedAt")):
        raise UltraBurnError(f"nonterminal state contains terminal Git evidence: {path}")
    return value


def load_pointer(path: Path, expected_repository: str | None = None) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise UltraBurnError(f"no active UltraBurn run for repository: {path}") from exc
    except json.JSONDecodeError as exc:
        raise UltraBurnError(f"active-run pointer is invalid JSON: {path}") from exc
    if (
        not isinstance(value, dict)
        or set(value) != {"schema", "runId", "repository"}
        or value.get("schema") != POINTER_SCHEMA
        or not isinstance(value.get("runId"), str)
        or not isinstance(value.get("repository"), str)
    ):
        raise UltraBurnError(f"active-run pointer is invalid: {path}")
    run_path(path.parents[1], value["runId"])
    if not Path(value["repository"]).is_absolute():
        raise UltraBurnError(f"active-run pointer repository is not absolute: {path}")
    if expected_repository is not None and not same_repository(value["repository"], expected_repository):
        raise UltraBurnError(f"active-run pointer repository does not match requested repository: {path}")
    return value


@contextmanager
def locked_run(root: Path, run_id: str) -> Iterator[tuple[Path, dict[str, Any], dict[str, Any]]]:
    path = run_path(root, run_id)
    initial = load_json(path)
    initial_repository = initial["repository"]
    ensure_state_root_outside_repository(root, initial_repository)
    with StateLock(root, repo_key(initial_repository)):
        state = load_json(path)
        if not same_repository(state["repository"], initial_repository):
            raise UltraBurnError("run repository changed while acquiring its state lock")
        snapshot = repo_snapshot(state["repository"])
        validate_repository_identity(state, snapshot)
        yield path, state, snapshot


@contextmanager
def locked_repository_run(
    root: Path, repo: str
) -> Iterator[tuple[Path, dict[str, Any], dict[str, Any]]]:
    snapshot = repo_snapshot(repo)
    ensure_state_root_outside_repository(root, snapshot["repository"])
    with StateLock(root, repo_key(snapshot["repository"])):
        locked_snapshot = repo_snapshot(repo)
        if not same_snapshot_identity(snapshot, locked_snapshot):
            raise UltraBurnError("repository identity changed while acquiring its state lock")
        pointer = load_pointer(pointer_path(root, locked_snapshot["repository"]), locked_snapshot["repository"])
        path = run_path(root, pointer["runId"])
        state = load_json(path)
        if not same_repository(state["repository"], locked_snapshot["repository"]):
            raise UltraBurnError("active-run state repository does not match requested repository")
        validate_repository_identity(state, locked_snapshot)
        yield path, state, locked_snapshot


def validate_repository_identity(state: dict[str, Any], snapshot: dict[str, Any]) -> None:
    if (
        not same_repository(state["repository"], snapshot["repository"])
        or not same_repository(state["gitDir"], snapshot["gitDir"])
        or state["gitDirDevice"] != snapshot["gitDirDevice"]
        or state["gitDirInode"] != snapshot["gitDirInode"]
    ):
        raise UltraBurnError("live repository identity does not match run state")
    if state.get("baseHead"):
        run_git(Path(snapshot["repository"]), "cat-file", "-e", f"{state['baseHead']}^{{commit}}")


def parse_task_details(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        details = json.loads(value)
    except json.JSONDecodeError as exc:
        raise UltraBurnError("--details-json must be valid JSON") from exc
    if not isinstance(details, dict):
        raise UltraBurnError("--details-json must be a JSON object")
    unknown = sorted(set(details) - set(DETAIL_TYPES))
    if unknown:
        raise UltraBurnError(f"--details-json contains reserved or unknown fields: {', '.join(unknown)}")
    for key, expected in DETAIL_TYPES.items():
        if key in details and not isinstance(details[key], expected):
            raise UltraBurnError(f"--details-json field {key} has an invalid type")
    for key in ("dependencies", "fileScope"):
        if key in details and any(not isinstance(item, str) or not item.strip() for item in details[key]):
            raise UltraBurnError(f"--details-json field {key} must contain nonempty strings")
    if "fileScope" in details and not details["fileScope"]:
        raise UltraBurnError("--details-json fileScope cannot be empty")
    verification = details.get("verification")
    if isinstance(verification, str) and not verification.strip():
        raise UltraBurnError("--details-json verification cannot be blank")
    if isinstance(verification, list) and (
        not verification or any(not isinstance(item, str) or not item.strip() for item in verification)
    ):
        raise UltraBurnError("--details-json verification must contain nonempty strings")
    for key in ("expectedValue", "confidence", "cost"):
        if key in details and isinstance(details[key], bool):
            raise UltraBurnError(f"--details-json field {key} must be numeric, not boolean")
    if "risk" in details and details["risk"] not in RISK_LEVELS:
        raise UltraBurnError("--details-json risk must be low, medium, or high")
    for field in ("expectedValue", "confidence", "cost"):
        if field in details and not math.isfinite(details[field]):
            raise UltraBurnError(f"--details-json {field} must be finite")
    if "expectedValue" in details and details["expectedValue"] <= 0:
        raise UltraBurnError("--details-json expectedValue must be greater than zero")
    if "cost" in details and details["cost"] <= 0:
        raise UltraBurnError("--details-json cost must be greater than zero")
    if "confidence" in details and not 0 <= details["confidence"] <= 1:
        raise UltraBurnError("--details-json confidence must be between zero and one")
    if "complexity" in details and not details["complexity"].strip():
        raise UltraBurnError("--details-json complexity cannot be empty")
    if "evidence" in details and not meaningful_evidence(details["evidence"]):
        raise UltraBurnError("--details-json evidence must contain meaningful nonempty values")
    if "verification" in details and not details["verification"]:
        raise UltraBurnError("--details-json verification cannot be empty")
    return details


def write_run(path: Path, state: dict[str, Any], event_type: str, details: dict[str, Any] | None = None) -> None:
    now = iso(utc_now())
    state["updatedAt"] = now
    event: dict[str, Any] = {"at": now, "type": event_type}
    if details:
        event["details"] = details
    state.setdefault("events", []).append(event)
    atomic_json(path, state)


def stop_reason(state: dict[str, Any]) -> str | None:
    if state.get("phase") in TERMINAL_PHASES:
        return f"terminal:{state['phase'].lower()}"
    if state.get("stopRequestedAt"):
        return "stop-requested"
    hard_stop = parse_iso(state["controls"]["hardStopAt"])
    if utc_now() >= hard_stop:
        return "hard-stop-reached"
    return None


def new_run_id(now: datetime) -> str:
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    entropy = hashlib.sha256(f"{time.time_ns()}:{os.getpid()}".encode()).hexdigest()[:8]
    return f"ultraburn-{stamp}-{entropy}"


def command_start(args: argparse.Namespace) -> dict[str, Any]:
    root = state_root()
    snapshot = repo_snapshot(args.repo)
    ensure_state_root_outside_repository(root, snapshot["repository"])
    key = repo_key(snapshot["repository"])
    with StateLock(root, key):
        locked_snapshot = repo_snapshot(args.repo)
        if not same_snapshot_identity(snapshot, locked_snapshot):
            raise UltraBurnError("repository identity changed while acquiring its state lock")
        snapshot = locked_snapshot
        pointer = pointer_path(root, snapshot["repository"])
        if pointer.exists():
            active = load_pointer(pointer, snapshot["repository"])
            active_path = run_path(root, active["runId"])
            if active_path.exists() and load_json(active_path).get("phase") not in TERMINAL_PHASES:
                raise UltraBurnError(f"active run already exists: {active['runId']}")

        validate_capacity(args.max_workers, args.effective_max_workers)
        now = utc_now()
        runtime_stop = now + timedelta(minutes=args.max_runtime_minutes)
        deadline = parse_iso(args.deadline) if args.deadline else None
        if deadline and deadline <= now:
            raise UltraBurnError("deadline must be in the future")
        deadline_stop = deadline - timedelta(minutes=args.stop_buffer_minutes) if deadline else None
        if deadline_stop and deadline_stop <= now:
            raise UltraBurnError("deadline stop buffer leaves no execution time")
        hard_stop = min(runtime_stop, deadline_stop) if deadline_stop else runtime_stop
        run_id = new_run_id(now)
        phase = "PLANNING" if args.operation == "plan" else "RUNNING"
        state = {
            "schema": SCHEMA,
            "runId": run_id,
            "repository": snapshot["repository"],
            "gitDir": snapshot["gitDir"],
            "gitDirDevice": snapshot["gitDirDevice"],
            "gitDirInode": snapshot["gitDirInode"],
            "baseHead": snapshot["head"],
            "baseBranch": snapshot["branch"],
            "initialGitStatus": snapshot["gitStatus"],
            "operation": args.operation,
            "preset": args.preset,
            "phase": phase,
            "startedAt": iso(now),
            "updatedAt": iso(now),
            "stopRequestedAt": None,
            "stopReason": None,
            "outcomeSummary": None,
            "reportPath": None,
            "finalHead": None,
            "finalBranch": None,
            "finalGitStatus": None,
            "finishedAt": None,
            "controls": {
                "maxRuntimeMinutes": args.max_runtime_minutes,
                "requestedMaxWorkers": args.max_workers,
                "effectiveMaxWorkers": args.effective_max_workers,
                "maxRisk": args.max_risk,
                "deadline": iso(deadline) if deadline else None,
                "stopBufferMinutes": args.stop_buffer_minutes,
                "hardStopAt": iso(hard_stop),
                "quotaPercent": None,
            },
            "tasks": [],
            "events": [{"at": iso(now), "type": "run-started", "details": {"phase": phase}}],
        }
        path = run_path(root, run_id)
        atomic_json(path, state)
        atomic_json(pointer, {"schema": POINTER_SCHEMA, "runId": run_id, "repository": snapshot["repository"]})
        return {"ok": True, "runId": run_id, "runDirectory": str(path.parent), "state": state}


def command_task(args: argparse.Namespace) -> dict[str, Any]:
    root = state_root()
    if not args.task_id.strip():
        raise UltraBurnError("--task-id cannot be empty or whitespace")
    if args.title is not None and not args.title.strip():
        raise UltraBurnError("--title cannot be empty or whitespace")
    details = parse_task_details(args.details_json)
    with locked_run(root, args.run_id) as (path, state, _snapshot):
        phase = state.get("phase")
        if phase in TERMINAL_PHASES:
            raise UltraBurnError("terminal run cannot accept task updates")
        limit_reason = stop_reason(state)
        draining = phase == "STOP_REQUESTED" or limit_reason is not None
        tasks = state.get("tasks")
        if not isinstance(tasks, list) or any(not isinstance(item, dict) for item in tasks):
            raise UltraBurnError("run task state is invalid")
        match = next((item for item in tasks if item.get("taskId") == args.task_id), None)
        if match is None:
            if draining:
                raise UltraBurnError(f"stopping run cannot discover or queue a new task: {limit_reason or 'stop-requested'}")
            if not args.title:
                raise UltraBurnError("--title is required when creating a task")
            if args.status not in {"discovered", "queued"}:
                raise UltraBurnError("new task status must be discovered or queued")
            missing = sorted(REQUIRED_TASK_DETAILS - set(details))
            if missing:
                raise UltraBurnError(f"new task details are missing required fields: {', '.join(missing)}")
            match = {"taskId": args.task_id, "title": args.title, "history": []}
            tasks.append(match)
        elif args.title:
            match["title"] = args.title

        current_status = match.get("status")
        if current_status is not None and current_status not in TASK_STATES:
            raise UltraBurnError(f"task has unsupported current status: {current_status}")
        if current_status in TERMINAL_TASK_STATES:
            raise UltraBurnError(f"terminal task record is immutable: {args.task_id}")
        if current_status in TASK_TRANSITIONS:
            if args.status != current_status and args.status not in TASK_TRANSITIONS[current_status]:
                raise UltraBurnError(f"illegal task transition: {current_status} -> {args.status}")
        if draining:
            safe_stop_targets = {
                "discovered": {"blocked", "rejected", "skipped"},
                "queued": {"blocked", "rejected", "skipped"},
                "running": {"failed", "blocked", "skipped"},
                "verifying": {"completed", "failed", "rejected", "blocked"},
            }
            if args.status != current_status and args.status not in safe_stop_targets.get(current_status, set()):
                raise UltraBurnError(f"stopping run cannot transition task: {current_status} -> {args.status}")
        elif args.status in ACTIVE_TASK_STATES and phase != "RUNNING":
            raise UltraBurnError(f"task cannot enter {args.status} while run phase is {phase}")

        existing_risk = match.get("risk")
        if "risk" in details and existing_risk is not None and details["risk"] != existing_risk:
            raise UltraBurnError("task risk cannot change after creation")
        proposed_risk = details.get("risk", existing_risk)
        if proposed_risk is not None:
            max_risk = state.get("controls", {}).get("maxRisk")
            if max_risk not in RISK_LEVELS:
                raise UltraBurnError("run maxRisk control is invalid")
            if proposed_risk not in RISK_LEVELS or RISK_LEVELS[proposed_risk] > RISK_LEVELS[max_risk]:
                raise UltraBurnError(f"task risk {proposed_risk} exceeds run maxRisk {max_risk}")

        effective_max = state.get("controls", {}).get("effectiveMaxWorkers")
        if not isinstance(effective_max, int) or isinstance(effective_max, bool) or effective_max < 0:
            raise UltraBurnError("run effectiveMaxWorkers control is invalid")
        active_count = sum(
            1 for item in tasks if item is not match and item.get("status") in ACTIVE_TASK_STATES
        )
        if args.status in ACTIVE_TASK_STATES:
            active_count += 1
        if active_count > effective_max:
            raise UltraBurnError(
                f"active task count {active_count} exceeds effectiveMaxWorkers {effective_max}"
            )

        history = match.get("history")
        if not isinstance(history, list):
            raise UltraBurnError("task history is invalid")
        match.update(details)
        match["status"] = args.status
        changed_at = iso(utc_now())
        if limit_reason and phase != "STOP_REQUESTED":
            state["phase"] = "STOP_REQUESTED"
            state["stopRequestedAt"] = state.get("stopRequestedAt") or changed_at
            state["stopReason"] = state.get("stopReason") or limit_reason
        match["updatedAt"] = changed_at
        history.append({"at": changed_at, "status": args.status})
        write_run(path, state, "task-updated", {"taskId": args.task_id, "status": args.status})
        return {"ok": True, "runId": state["runId"], "task": match}


def command_update_capacity(args: argparse.Namespace) -> dict[str, Any]:
    root = state_root()
    with locked_run(root, args.run_id) as (path, state, _snapshot):
        if state.get("phase") not in {"PLANNING", "PLANNED", "RUNNING"}:
            raise UltraBurnError("terminal or stopping run cannot update capacity")
        tasks = state.get("tasks")
        if not isinstance(tasks, list) or any(not isinstance(item, dict) for item in tasks):
            raise UltraBurnError("run task state is invalid")
        active_count = sum(1 for task in tasks if task.get("status") in ACTIVE_TASK_STATES)
        validate_capacity(args.max_workers, args.effective_max_workers, active_count)
        controls = state.get("controls")
        if not isinstance(controls, dict):
            raise UltraBurnError("run controls are invalid")
        previous = {
            "requestedMaxWorkers": controls.get("requestedMaxWorkers"),
            "effectiveMaxWorkers": controls.get("effectiveMaxWorkers"),
        }
        controls["requestedMaxWorkers"] = args.max_workers
        controls["effectiveMaxWorkers"] = args.effective_max_workers
        write_run(
            path,
            state,
            "capacity-updated",
            {
                "previous": previous,
                "requestedMaxWorkers": args.max_workers,
                "effectiveMaxWorkers": args.effective_max_workers,
                "activeTaskCount": active_count,
            },
        )
        return {
            "ok": True,
            "runId": state["runId"],
            "controls": controls,
            "activeTaskCount": active_count,
        }


def command_activate(args: argparse.Namespace) -> dict[str, Any]:
    root = state_root()
    with locked_run(root, args.run_id) as (path, state, _snapshot):
        if state.get("phase") != "PLANNED":
            raise UltraBurnError("only a PLANNED run can be activated")
        if stop_reason(state):
            raise UltraBurnError(f"planned run cannot activate: {stop_reason(state)}")
        state["phase"] = "RUNNING"
        state["operation"] = "run"
        write_run(path, state, "run-activated")
        return {"ok": True, "runId": state["runId"], "phase": state["phase"]}


def command_stop(args: argparse.Namespace) -> dict[str, Any]:
    root = state_root()

    def stop_locked(path: Path) -> dict[str, Any]:
        state = load_json(path)
        if state.get("phase") in TERMINAL_PHASES:
            return {"ok": True, "runId": state["runId"], "phase": state["phase"], "alreadyTerminal": True}
        now = iso(utc_now())
        state["stopRequestedAt"] = state.get("stopRequestedAt") or now
        state["stopReason"] = args.reason or state.get("stopReason") or "user-requested"
        state["phase"] = "STOP_REQUESTED"
        write_run(path, state, "stop-requested", {"reason": state["stopReason"]})
        return {"ok": True, "runId": state["runId"], "phase": state["phase"], "graceful": True}

    if args.repo:
        with locked_repository_run(root, args.repo) as (path, _state, _snapshot):
            return stop_locked(path)

    with locked_run(root, args.run_id) as (path, _state, _snapshot):
        return stop_locked(path)


def command_check_stop(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    root = state_root()
    with locked_run(root, args.run_id) as (_path, state, _snapshot):
        reason = stop_reason(state)
        if reason:
            return {"ok": True, "decision": "STOP", "reason": reason, "runId": state["runId"]}, 3
        return {"ok": True, "decision": "CONTINUE", "runId": state["runId"]}, 0


def command_finish(args: argparse.Namespace) -> dict[str, Any]:
    root = state_root()
    with locked_run(root, args.run_id) as (path, state, snapshot):
        phase = OUTCOME_PHASES[args.outcome]
        current_phase = state.get("phase")
        if current_phase in TERMINAL_PHASES:
            if current_phase != phase:
                raise UltraBurnError(f"terminal run cannot change outcome from {current_phase} to {phase}")
            return {
                "ok": True,
                "runId": state["runId"],
                "phase": phase,
                "statePath": str(path),
                "alreadyTerminal": True,
            }
        if phase not in LEGAL_FINISH_PHASES.get(current_phase, set()):
            raise UltraBurnError(f"illegal run phase transition: {current_phase} -> {phase}")
        if phase in TERMINAL_PHASES:
            tasks = state["tasks"]
            nonterminal = [task["taskId"] for task in tasks if task["status"] not in TERMINAL_TASK_STATES]
            if nonterminal:
                raise UltraBurnError(f"terminal run outcome has nonterminal tasks: {', '.join(nonterminal)}")
        if phase == "COMPLETED":
            statuses = {task["status"] for task in state["tasks"]}
            if "completed" not in statuses or statuses - {"completed", "rejected", "skipped"}:
                raise UltraBurnError("COMPLETED run requires verified completed work and no failed or blocked tasks")
        report_path = state.get("reportPath")
        if phase in TERMINAL_PHASES:
            if not args.report_path:
                raise UltraBurnError("terminal run outcome requires --report-path")
            supplied_report = Path(args.report_path).expanduser()
            expected_report = path.parent / "report.md"
            if supplied_report.is_symlink() or not supplied_report.is_file() or supplied_report.stat().st_size == 0:
                raise UltraBurnError("terminal report must be an existing nonempty regular file")
            resolved_report = supplied_report.resolve(strict=True)
            if not same_repository(str(resolved_report), str(expected_report.resolve(strict=True))):
                raise UltraBurnError("terminal report must be report.md beside run.json")
            report_path = str(resolved_report)
        state["phase"] = phase
        state["outcomeSummary"] = args.summary
        state["reportPath"] = report_path
        if phase in TERMINAL_PHASES:
            state["finalHead"] = snapshot["head"]
            state["finalBranch"] = snapshot["branch"]
            state["finalGitStatus"] = snapshot["gitStatus"]
            state["finishedAt"] = iso(utc_now())
        write_run(path, state, "run-finished", {"outcome": args.outcome})
        if phase in TERMINAL_PHASES:
            pointer = pointer_path(root, state["repository"])
            if pointer.exists() and load_pointer(pointer, state["repository"]).get("runId") == state["runId"]:
                pointer.unlink()
        return {"ok": True, "runId": state["runId"], "phase": phase, "statePath": str(path)}


def command_status(args: argparse.Namespace) -> dict[str, Any]:
    root = state_root()
    if args.repo:
        locked = locked_repository_run(root, args.repo)
    else:
        locked = locked_run(root, args.run_id)
    with locked as locked_value:
        path, state, snapshot = locked_value
        return status_payload(path, state, snapshot)


def status_payload(path: Path, state: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    counts = {name: 0 for name in TASK_STATES}
    for task in state.get("tasks", []):
        current = task.get("status")
        if current in counts:
            counts[current] += 1
    started = parse_iso(state["startedAt"])
    elapsed = max(0, int((utc_now() - started).total_seconds()))
    reason = stop_reason(state)
    return {
        "ok": True,
        "runId": state["runId"],
        "phase": state["phase"],
        "preset": state["preset"],
        "elapsedSeconds": elapsed,
        "stopDecision": "STOP" if reason else "CONTINUE",
        "stopReason": reason,
        "controls": state["controls"],
        "taskCounts": counts,
        "tasks": state.get("tasks", []),
        "git": snapshot,
        "statePath": str(path),
        "reportPath": state.get("reportPath"),
        "finalGit": {
            "head": state.get("finalHead"),
            "branch": state.get("finalBranch"),
            "gitStatus": state.get("finalGitStatus"),
            "finishedAt": state.get("finishedAt"),
        },
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)

    start = commands.add_parser("start")
    start.add_argument("--repo", required=True)
    start.add_argument("--operation", choices=("plan", "run"), required=True)
    start.add_argument("--preset", choices=("conservative", "aggressive", "maximum"), required=True)
    start.add_argument("--max-runtime-minutes", type=int, choices=range(1, 1441), required=True)
    start.add_argument("--max-workers", type=nonnegative_int, required=True)
    start.add_argument("--effective-max-workers", type=nonnegative_int, required=True)
    start.add_argument("--max-risk", choices=("low", "medium", "high"), required=True)
    start.add_argument("--deadline")
    start.add_argument("--stop-buffer-minutes", type=int, choices=range(5, 121), default=15)

    task = commands.add_parser("task")
    task.add_argument("--run-id", required=True)
    task.add_argument("--task-id", required=True)
    task.add_argument("--title")
    task.add_argument("--status", choices=sorted(TASK_STATES), required=True)
    task.add_argument("--details-json")

    update_capacity = commands.add_parser("update-capacity")
    update_capacity.add_argument("--run-id", required=True)
    update_capacity.add_argument("--max-workers", type=nonnegative_int, required=True)
    update_capacity.add_argument("--effective-max-workers", type=nonnegative_int, required=True)

    activate = commands.add_parser("activate")
    activate.add_argument("--run-id", required=True)

    status = commands.add_parser("status")
    status_target = status.add_mutually_exclusive_group(required=True)
    status_target.add_argument("--run-id")
    status_target.add_argument("--repo")

    stop = commands.add_parser("stop")
    stop_target = stop.add_mutually_exclusive_group(required=True)
    stop_target.add_argument("--run-id")
    stop_target.add_argument("--repo")
    stop.add_argument("--reason")

    check_stop = commands.add_parser("check-stop")
    check_stop.add_argument("--run-id", required=True)

    finish = commands.add_parser("finish")
    finish.add_argument("--run-id", required=True)
    finish.add_argument("--outcome", choices=tuple(OUTCOME_PHASES), required=True)
    finish.add_argument("--summary", required=True)
    finish.add_argument("--report-path")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "start":
            value, code = command_start(args), 0
        elif args.command == "task":
            value, code = command_task(args), 0
        elif args.command == "update-capacity":
            value, code = command_update_capacity(args), 0
        elif args.command == "activate":
            value, code = command_activate(args), 0
        elif args.command == "status":
            value, code = command_status(args), 0
        elif args.command == "stop":
            value, code = command_stop(args), 0
        elif args.command == "check-stop":
            value, code = command_check_stop(args)
        elif args.command == "finish":
            value, code = command_finish(args), 0
        else:
            raise UltraBurnError(f"unsupported command: {args.command}")
    except (UltraBurnError, OSError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True))
        return 2
    print(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main())
