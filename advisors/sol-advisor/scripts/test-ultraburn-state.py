#!/usr/bin/env python3
"""Disposable deterministic checks for the UltraBurn state helper."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


HELPER = Path(__file__).with_name("ultraburn-state.py")


def run(env: dict[str, str], *args: str, expected: int = 0) -> dict:
    result = subprocess.run(
        [sys.executable, str(HELPER), *args],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )
    if result.returncode != expected:
        raise AssertionError(f"command {args} exited {result.returncode}, expected {expected}: {result.stdout} {result.stderr}")
    if not result.stdout.strip():
        return {"ok": False, "error": result.stderr.strip()}
    return json.loads(result.stdout)


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "--no-optional-locks", "-C", str(repo), *args],
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def repo_digest(repo: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in repo.rglob("*") if item.is_file() and ".git" not in item.parts):
        digest.update(path.relative_to(repo).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def state_repo_key(repo: Path) -> str:
    normalized = os.path.normcase(os.path.normpath(str(repo.resolve())))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def parse_process(process: subprocess.Popen[str], expected: int = 0) -> dict:
    stdout, stderr = process.communicate(timeout=10)
    if process.returncode != expected:
        raise AssertionError(
            f"process exited {process.returncode}, expected {expected}: {stdout} {stderr}"
        )
    return json.loads(stdout)


def task_details(**overrides: object) -> dict:
    details = {
        "expectedValue": 5,
        "confidence": 0.8,
        "risk": "low",
        "complexity": "small",
        "cost": 1,
        "dependencies": [],
        "verification": "python -m unittest",
        "concurrent": False,
        "fileScope": ["app.py"],
        "evidence": ["fixture evidence"],
    }
    details.update(overrides)
    return details


def finish(env: dict[str, str], run_id: str, outcome: str, summary: str) -> dict:
    report = Path(env["CODEX_HOME"]) / "ultraburn" / "runs" / run_id / "report.md"
    report.write_text(f"# UltraBurn report\n\n{summary}\n", encoding="utf-8")
    return run(
        env,
        "finish",
        "--run-id",
        run_id,
        "--outcome",
        outcome,
        "--summary",
        summary,
        "--report-path",
        str(report),
    )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="sol-advisor-ultraburn-test-") as temporary:
        base = Path(temporary)
        repo = base / "fixture"
        repo.mkdir()
        git(repo, "init")
        git(repo, "config", "user.name", "UltraBurn Fixture")
        git(repo, "config", "user.email", "fixture@example.invalid")
        (repo / "app.py").write_text("def value():\n    return 1\n", encoding="utf-8")
        git(repo, "add", "app.py")
        git(repo, "commit", "-m", "fixture")
        (repo / "user-notes.txt").write_text("preserve me\n", encoding="utf-8")

        repo_two = base / "fixture-two"
        repo_two.mkdir()
        git(repo_two, "init")
        git(repo_two, "config", "user.name", "UltraBurn Fixture")
        git(repo_two, "config", "user.email", "fixture@example.invalid")
        (repo_two / "other.py").write_text("VALUE = 2\n", encoding="utf-8")
        git(repo_two, "add", "other.py")
        git(repo_two, "commit", "-m", "second fixture")

        before_digest = repo_digest(repo)
        before_status = git(repo, "status", "--short", "--branch", "--untracked-files=all")
        index_path = repo / ".git" / "index"
        index_hash = hashlib.sha256(index_path.read_bytes()).hexdigest()
        index_mtime = index_path.stat().st_mtime_ns
        env = dict(os.environ)
        env["CODEX_HOME"] = str(base / "codex-home")

        nested_home = repo / ".codex-inside-repo"
        nested_env = dict(env)
        nested_env["CODEX_HOME"] = str(nested_home)
        nested_refusal = run(
            nested_env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "plan",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "10",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
            expected=2,
        )
        assert "state root must be outside" in nested_refusal["error"]
        assert not nested_home.exists()

        started = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "plan",
            "--preset",
            "aggressive",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "2",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "medium",
        )
        run_id = started["runId"]
        assert started["state"]["initialGitStatus"] == before_status.splitlines()
        assert started["state"]["controls"]["quotaPercent"] is None
        assert started["state"]["controls"]["effectiveMaxWorkers"] == 1

        conflict = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "10",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
            expected=2,
        )
        assert "active run already exists" in conflict["error"]

        run(
            env,
            "task",
            "--run-id",
            run_id,
            "--task-id",
            "T1",
            "--title",
            "Cover the error path",
            "--status",
            "discovered",
            "--details-json",
            json.dumps(task_details(expectedValue=8)),
        )
        status = run(env, "status", "--repo", str(repo))
        assert status["taskCounts"]["discovered"] == 1
        assert status["git"]["gitStatus"] == before_status.splitlines()

        run(env, "finish", "--run-id", run_id, "--outcome", "planned", "--summary", "one useful task")
        run(env, "activate", "--run-id", run_id)
        assert run(env, "check-stop", "--run-id", run_id)["decision"] == "CONTINUE"

        stopped = run(env, "stop", "--repo", str(repo), "--reason", "fixture-stop")
        assert stopped["graceful"] is True
        decision = run(env, "check-stop", "--run-id", run_id, expected=3)
        assert decision["decision"] == "STOP" and decision["reason"] == "stop-requested"
        run(env, "task", "--run-id", run_id, "--task-id", "T1", "--status", "blocked")
        finish(env, run_id, "stopped", "clean stop")

        final = run(env, "status", "--run-id", run_id)
        assert final["phase"] == "STOPPED"
        terminal_update = run(
            env,
            "task",
            "--run-id",
            run_id,
            "--task-id",
            "T1",
            "--status",
            "completed",
            expected=2,
        )
        assert "terminal run cannot accept task updates" in terminal_update["error"]
        assert repo_digest(repo) == before_digest
        assert git(repo, "status", "--short", "--branch", "--untracked-files=all") == before_status

        effective_overflow = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "plan",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "2",
            "--max-risk",
            "low",
            expected=2,
        )
        assert "effective worker count cannot exceed requested" in effective_overflow["error"]

        uncapped = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "plan",
            "--preset",
            "maximum",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "4",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "high",
        )
        assert uncapped["state"]["controls"]["requestedMaxWorkers"] == 4
        finish(env, uncapped["runId"], "blocked", "dynamic capacity fixture")

        zero_capacity = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "0",
            "--effective-max-workers",
            "0",
            "--max-risk",
            "low",
        )
        assert zero_capacity["state"]["controls"]["effectiveMaxWorkers"] == 0
        zero_id = zero_capacity["runId"]
        run(
            env,
            "task",
            "--run-id",
            zero_id,
            "--task-id",
            "zero-capacity-task",
            "--title",
            "Queue while capacity is unavailable",
            "--status",
            "queued",
            "--details-json",
            json.dumps(task_details()),
        )
        zero_activation = run(
            env,
            "task",
            "--run-id",
            zero_id,
            "--task-id",
            "zero-capacity-task",
            "--status",
            "running",
            expected=2,
        )
        assert "exceeds effectiveMaxWorkers 0" in zero_activation["error"]
        run(
            env,
            "update-capacity",
            "--run-id",
            zero_id,
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
        )
        run(env, "task", "--run-id", zero_id, "--task-id", "zero-capacity-task", "--status", "running")
        run(env, "task", "--run-id", zero_id, "--task-id", "zero-capacity-task", "--status", "verifying")
        run(env, "task", "--run-id", zero_id, "--task-id", "zero-capacity-task", "--status", "completed")
        finish(env, zero_id, "completed", "zero capacity fixture")
        negative_capacity = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "plan",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "-1",
            "--effective-max-workers",
            "0",
            "--max-risk",
            "low",
            expected=2,
        )
        assert "nonnegative integer" in negative_capacity["error"]

        capacity = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "maximum",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "4",
            "--effective-max-workers",
            "2",
            "--max-risk",
            "high",
        )
        capacity_id = capacity["runId"]
        for task_id in ("capacity-one", "capacity-two"):
            run(
                env,
                "task",
                "--run-id",
                capacity_id,
                "--task-id",
                task_id,
                "--title",
                task_id,
                "--status",
                "queued",
                "--details-json",
                json.dumps(task_details(risk="high", concurrent=True, fileScope=[f"{task_id}.py"])),
            )
            run(env, "task", "--run-id", capacity_id, "--task-id", task_id, "--status", "running")
        grown = run(
            env,
            "update-capacity",
            "--run-id",
            capacity_id,
            "--max-workers",
            "9",
            "--effective-max-workers",
            "5",
        )
        assert grown["controls"]["requestedMaxWorkers"] == 9
        assert grown["controls"]["effectiveMaxWorkers"] == 5
        premature_reduction = run(
            env,
            "update-capacity",
            "--run-id",
            capacity_id,
            "--max-workers",
            "0",
            "--effective-max-workers",
            "0",
            expected=2,
        )
        assert "cannot be below active task count" in premature_reduction["error"]
        for task_id in ("capacity-one", "capacity-two"):
            run(env, "task", "--run-id", capacity_id, "--task-id", task_id, "--status", "verifying")
            run(env, "task", "--run-id", capacity_id, "--task-id", task_id, "--status", "completed")
        reduced = run(
            env,
            "update-capacity",
            "--run-id",
            capacity_id,
            "--max-workers",
            "0",
            "--effective-max-workers",
            "0",
        )
        assert reduced["controls"]["effectiveMaxWorkers"] == 0
        finish(env, capacity_id, "completed", "capacity fixture drained")

        enforcement = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "2",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
        )
        enforcement_id = enforcement["runId"]
        pristine_state = run(env, "status", "--run-id", enforcement_id)
        for bad_id, bad_title, expected_error in (
            ("   ", "Bad ID", "--task-id cannot be empty"),
            ("T-blank-title", "   ", "--title cannot be empty"),
        ):
            blank_identity = run(
                env,
                "task",
                "--run-id",
                enforcement_id,
                "--task-id",
                bad_id,
                "--title",
                bad_title,
                "--status",
                "queued",
                "--details-json",
                json.dumps(task_details()),
                expected=2,
            )
            assert expected_error in blank_identity["error"]
        after_blank_identity = run(env, "status", "--run-id", enforcement_id)
        assert after_blank_identity["tasks"] == pristine_state["tasks"] == []
        hostile = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T-hostile",
            "--title",
            "Hostile details",
            "--status",
            "queued",
            "--details-json",
            json.dumps({"taskId": "replacement", "history": "corrupt", "risk": "low"}),
            expected=2,
        )
        assert "reserved or unknown fields" in hostile["error"]
        incomplete_details = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T-incomplete",
            "--title",
            "Missing evidence",
            "--status",
            "queued",
            "--details-json",
            json.dumps({"risk": "low"}),
            expected=2,
        )
        assert "missing required fields" in incomplete_details["error"]
        for bad_details, expected_error in (
            (task_details(evidence=[None]), "meaningful nonempty values"),
            (task_details(verification="   "), "verification cannot be blank"),
            (task_details(fileScope=[""]), "fileScope must contain nonempty strings"),
        ):
            rejected_evidence = run(
                env,
                "task",
                "--run-id",
                enforcement_id,
                "--task-id",
                f"T-bad-{expected_error.split()[0]}",
                "--title",
                "Invalid evidence",
                "--status",
                "queued",
                "--details-json",
                json.dumps(bad_details),
                expected=2,
            )
            assert expected_error in rejected_evidence["error"]
        high_risk = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T-high",
            "--title",
            "Too risky",
            "--status",
            "queued",
            "--details-json",
            json.dumps(task_details(risk="high")),
            expected=2,
        )
        assert "exceeds run maxRisk" in high_risk["error"]
        for task_id in ("T1", "T2"):
            run(
                env,
                "task",
                "--run-id",
                enforcement_id,
                "--task-id",
                task_id,
                "--title",
                task_id,
                "--status",
                "queued",
                "--details-json",
                json.dumps(task_details()),
            )
        blank_title_update = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T1",
            "--title",
            "   ",
            "--status",
            "queued",
            expected=2,
        )
        assert "--title cannot be empty" in blank_title_update["error"]
        assert run(env, "status", "--run-id", enforcement_id)["tasks"][0]["title"] == "T1"
        run(env, "task", "--run-id", enforcement_id, "--task-id", "T1", "--status", "running")
        bypass_review = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T1",
            "--status",
            "completed",
            expected=2,
        )
        assert "illegal task transition" in bypass_review["error"]
        incomplete_run = run(
            env,
            "finish",
            "--run-id",
            enforcement_id,
            "--outcome",
            "completed",
            "--summary",
            "must reject nonterminal tasks",
            expected=2,
        )
        assert "nonterminal tasks" in incomplete_run["error"]
        overflow = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T2",
            "--status",
            "running",
            expected=2,
        )
        assert "exceeds effectiveMaxWorkers" in overflow["error"]
        illegal_phase = run(
            env,
            "finish",
            "--run-id",
            enforcement_id,
            "--outcome",
            "planned",
            "--summary",
            "invalid rewind",
            expected=2,
        )
        assert "illegal run phase transition" in illegal_phase["error"]

        run(env, "stop", "--repo", str(repo), "--reason", "enforcement-stop")
        new_after_stop = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T3",
            "--title",
            "Must not launch",
            "--status",
            "queued",
            "--details-json",
            json.dumps(task_details()),
            expected=2,
        )
        assert "cannot discover or queue a new task" in new_after_stop["error"]
        review_after_stop = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T1",
            "--status",
            "verifying",
            expected=2,
        )
        assert "stopping run cannot transition" in review_after_stop["error"]
        launch_after_stop = run(
            env,
            "task",
            "--run-id",
            enforcement_id,
            "--task-id",
            "T2",
            "--status",
            "running",
            expected=2,
        )
        assert "stopping run cannot transition" in launch_after_stop["error"]
        run(env, "task", "--run-id", enforcement_id, "--task-id", "T1", "--status", "blocked")
        run(env, "task", "--run-id", enforcement_id, "--task-id", "T2", "--status", "blocked")
        completed_after_stop = run(
            env,
            "finish",
            "--run-id",
            enforcement_id,
            "--outcome",
            "completed",
            "--summary",
            "must not complete after stop",
            expected=2,
        )
        assert "illegal run phase transition" in completed_after_stop["error"]
        finish(env, enforcement_id, "stopped", "safe stop")

        completed_run = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
        )
        completed_id = completed_run["runId"]
        run(
            env,
            "task",
            "--run-id",
            completed_id,
            "--task-id",
            "T-complete",
            "--title",
            "Verified task",
            "--status",
            "queued",
            "--details-json",
            json.dumps(task_details()),
        )
        for task_status in ("running", "verifying", "completed"):
            run(env, "task", "--run-id", completed_id, "--task-id", "T-complete", "--status", task_status)
        terminal_rewrite = run(
            env,
            "task",
            "--run-id",
            completed_id,
            "--task-id",
            "T-complete",
            "--status",
            "completed",
            "--details-json",
            json.dumps({"notes": "rewrite evidence after verification"}),
            expected=2,
        )
        assert "terminal task record is immutable" in terminal_rewrite["error"]
        missing_report = run(
            env,
            "finish",
            "--run-id",
            completed_id,
            "--outcome",
            "completed",
            "--summary",
            "report is required",
            expected=2,
        )
        assert "requires --report-path" in missing_report["error"]
        finish(env, completed_id, "completed", "verified completion")
        completed_status = run(env, "status", "--run-id", completed_id)
        assert completed_status["phase"] == "COMPLETED"
        assert completed_status["finalGit"]["gitStatus"] == before_status.splitlines()
        assert completed_status["finalGit"]["head"] == git(repo, "rev-parse", "HEAD")
        assert completed_status["finalGit"]["branch"] == git(repo, "branch", "--show-current")
        assert completed_status["finalGit"]["finishedAt"]
        completed_task = completed_status["tasks"][0]
        assert completed_task["expectedValue"] == 5
        assert completed_task["confidence"] == 0.8
        assert completed_task["risk"] == "low"
        assert completed_task["cost"] == 1

        # Reproduce the stop-by-repository pointer race deterministically. The
        # stop process must resolve the active pointer only after it owns the
        # repository lock, so it stops run B rather than stale run A.
        race_a = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
        )
        state_root = Path(env["CODEX_HOME"]) / "ultraburn"
        key = state_repo_key(repo)
        lock = state_root / "locks" / f"{key}.lock"
        lock.mkdir(parents=True)
        stop_process = subprocess.Popen(
            [sys.executable, str(HELPER), "stop", "--repo", str(repo), "--reason", "race-stop"],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        time.sleep(0.25)
        race_b_id = "ultraburn-race-b"
        race_b = dict(race_a["state"])
        race_b["runId"] = race_b_id
        race_b["phase"] = "RUNNING"
        race_b["tasks"] = []
        race_b_path = state_root / "runs" / race_b_id / "run.json"
        race_b_path.parent.mkdir(parents=True)
        race_b_path.write_text(json.dumps(race_b), encoding="utf-8")
        pointer = state_root / "active" / f"{key}.json"
        pointer.write_text(
            json.dumps(
                {
                    "schema": "sol-advisor-ultraburn-active-v1",
                    "runId": race_b_id,
                    "repository": str(repo.resolve()),
                }
            ),
            encoding="utf-8",
        )
        lock.rmdir()
        raced_stop = parse_process(stop_process)
        assert raced_stop["runId"] == race_b_id
        assert run(env, "status", "--run-id", race_b_id)["phase"] == "STOP_REQUESTED"
        assert run(env, "status", "--run-id", race_a["runId"])["phase"] == "RUNNING"
        finish(env, race_b_id, "stopped", "race stopped")
        finish(env, race_a["runId"], "failed", "synthetic stale run")

        # Status-by-repository must also resolve the pointer only after owning
        # the repository lock.
        status_a = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
        )
        lock.mkdir(parents=True)
        status_process = subprocess.Popen(
            [sys.executable, str(HELPER), "status", "--repo", str(repo)],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
        time.sleep(0.25)
        status_b_id = "ultraburn-status-race-b"
        status_b = json.loads(json.dumps(status_a["state"]))
        status_b["runId"] = status_b_id
        status_b_path = state_root / "runs" / status_b_id / "run.json"
        status_b_path.parent.mkdir(parents=True)
        status_b_path.write_text(json.dumps(status_b), encoding="utf-8")
        pointer.write_text(
            json.dumps(
                {
                    "schema": "sol-advisor-ultraburn-active-v1",
                    "runId": status_b_id,
                    "repository": str(repo.resolve()),
                }
            ),
            encoding="utf-8",
        )
        lock.rmdir()
        raced_status = parse_process(status_process)
        assert raced_status["runId"] == status_b_id
        finish(env, status_b_id, "failed", "status race")
        finish(env, status_a["runId"], "failed", "synthetic stale run")

        pointer.parent.mkdir(parents=True, exist_ok=True)
        pointer.write_text(
            json.dumps(
                {
                    "schema": "wrong-active-schema",
                    "runId": race_a["runId"],
                    "repository": str(repo.resolve()),
                }
            ),
            encoding="utf-8",
        )
        wrong_pointer_schema = run(env, "status", "--repo", str(repo), expected=2)
        assert "pointer is invalid" in wrong_pointer_schema["error"]

        pointer.write_text(
            json.dumps(
                {
                    "schema": "sol-advisor-ultraburn-active-v1",
                    "runId": race_a["runId"],
                    "repository": str(repo.resolve()),
                    "extra": True,
                }
            ),
            encoding="utf-8",
        )
        extra_pointer_field = run(env, "status", "--repo", str(repo), expected=2)
        assert "pointer is invalid" in extra_pointer_field["error"]

        pointer.write_text("{not-json", encoding="utf-8")
        malformed_pointer = run(env, "status", "--repo", str(repo), expected=2)
        assert "pointer is invalid JSON" in malformed_pointer["error"]
        pointer.unlink()

        other_run = run(
            env,
            "start",
            "--repo",
            str(repo_two),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
        )
        pointer.write_text(
            json.dumps(
                {
                    "schema": "sol-advisor-ultraburn-active-v1",
                    "runId": other_run["runId"],
                    "repository": str(repo.resolve()),
                }
            ),
            encoding="utf-8",
        )
        cross_repository = run(env, "status", "--repo", str(repo), expected=2)
        assert "state repository does not match requested repository" in cross_repository["error"]
        pointer.unlink()
        finish(env, other_run["runId"], "failed", "cross-repo fixture")

        corrupt_run = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
        )
        corrupt_path = Path(corrupt_run["runDirectory"]) / "run.json"
        valid_corrupt_state = json.loads(corrupt_path.read_text(encoding="utf-8"))
        invalid_shape = dict(valid_corrupt_state)
        invalid_shape["controls"] = []
        corrupt_path.write_text(json.dumps(invalid_shape), encoding="utf-8")
        corrupted = run(env, "status", "--run-id", corrupt_run["runId"], expected=2)
        assert "state controls are invalid" in corrupted["error"]
        invalid_caps = json.loads(json.dumps(valid_corrupt_state))
        invalid_caps["controls"]["maxRuntimeMinutes"] = 1441
        corrupt_path.write_text(json.dumps(invalid_caps), encoding="utf-8")
        cap_corruption = run(env, "status", "--run-id", corrupt_run["runId"], expected=2)
        assert "maxRuntimeMinutes is outside 1..1440" in cap_corruption["error"]
        extra_control = json.loads(json.dumps(valid_corrupt_state))
        extra_control["controls"]["extra"] = 1
        corrupt_path.write_text(json.dumps(extra_control), encoding="utf-8")
        control_corruption = run(env, "status", "--run-id", corrupt_run["runId"], expected=2)
        assert "controls have missing or unsupported fields" in control_corruption["error"]
        extended_stop = json.loads(json.dumps(valid_corrupt_state))
        extended_stop["controls"]["hardStopAt"] = "2099-01-01T00:00:00Z"
        corrupt_path.write_text(json.dumps(extended_stop), encoding="utf-8")
        extended_corruption = run(env, "status", "--run-id", corrupt_run["runId"], expected=2)
        assert "hardStopAt does not match runtime/deadline controls" in extended_corruption["error"]
        wrong_identity = json.loads(json.dumps(valid_corrupt_state))
        wrong_identity["gitDirInode"] += 1
        corrupt_path.write_text(json.dumps(wrong_identity), encoding="utf-8")
        identity_corruption = run(env, "status", "--run-id", corrupt_run["runId"], expected=2)
        assert "live repository identity does not match run state" in identity_corruption["error"]
        invalid_history = json.loads(json.dumps(valid_corrupt_state))
        invalid_task = task_details()
        invalid_task.update(
            {
                "taskId": "bad-history",
                "title": "Bad history",
                "status": "queued",
                "updatedAt": invalid_history["updatedAt"],
                "history": [{"at": "not-a-date", "status": "bogus"}],
            }
        )
        invalid_history["tasks"] = [invalid_task]
        corrupt_path.write_text(json.dumps(invalid_history), encoding="utf-8")
        history_corruption = run(env, "status", "--run-id", corrupt_run["runId"], expected=2)
        assert "task history entry is invalid" in history_corruption["error"]
        duplicate_state = json.loads(json.dumps(valid_corrupt_state))
        duplicate_task = task_details()
        duplicate_task.update(
            {
                "taskId": "duplicate",
                "title": "Duplicate",
                "status": "queued",
                "updatedAt": duplicate_state["updatedAt"],
                "history": [{"at": duplicate_state["updatedAt"], "status": "queued"}],
            }
        )
        duplicate_state["tasks"] = [duplicate_task, json.loads(json.dumps(duplicate_task))]
        corrupt_path.write_text(json.dumps(duplicate_state), encoding="utf-8")
        duplicate_corruption = run(env, "status", "--run-id", corrupt_run["runId"], expected=2)
        assert "duplicate task IDs" in duplicate_corruption["error"]
        repeated_terminal = json.loads(json.dumps(valid_corrupt_state))
        repeated_task = task_details()
        repeated_task.update(
            {
                "taskId": "repeated-terminal",
                "title": "Repeated terminal",
                "status": "completed",
                "updatedAt": repeated_terminal["updatedAt"],
                "history": [
                    {"at": repeated_terminal["updatedAt"], "status": "queued"},
                    {"at": repeated_terminal["updatedAt"], "status": "running"},
                    {"at": repeated_terminal["updatedAt"], "status": "verifying"},
                    {"at": repeated_terminal["updatedAt"], "status": "completed"},
                    {"at": repeated_terminal["updatedAt"], "status": "completed"},
                ],
            }
        )
        repeated_terminal["tasks"] = [repeated_task]
        corrupt_path.write_text(json.dumps(repeated_terminal), encoding="utf-8")
        repeated_corruption = run(env, "status", "--run-id", corrupt_run["runId"], expected=2)
        assert "history mutates a terminal task" in repeated_corruption["error"]
        corrupt_path.write_text(json.dumps(valid_corrupt_state), encoding="utf-8")
        finish(env, corrupt_run["runId"], "failed", "corrupt-state fixture")

        expired_run = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "run",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "60",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
        )
        expired_id = expired_run["runId"]
        run(
            env,
            "task",
            "--run-id",
            expired_id,
            "--task-id",
            "T-expired",
            "--title",
            "Drain safely",
            "--status",
            "queued",
            "--details-json",
            json.dumps(task_details()),
        )
        run(env, "task", "--run-id", expired_id, "--task-id", "T-expired", "--status", "running")
        expired_path = Path(expired_run["runDirectory"]) / "run.json"
        expired_state = json.loads(expired_path.read_text(encoding="utf-8"))
        expired_state["startedAt"] = "2000-01-01T00:00:00Z"
        expired_state["controls"]["hardStopAt"] = "2000-01-01T01:00:00Z"
        expired_path.write_text(json.dumps(expired_state), encoding="utf-8")
        expired_launch = run(
            env,
            "task",
            "--run-id",
            expired_id,
            "--task-id",
            "T-new",
            "--title",
            "Must not launch",
            "--status",
            "queued",
            "--details-json",
            json.dumps(task_details()),
            expected=2,
        )
        assert "hard-stop-reached" in expired_launch["error"]
        expired_review = run(
            env,
            "task",
            "--run-id",
            expired_id,
            "--task-id",
            "T-expired",
            "--status",
            "verifying",
            expected=2,
        )
        assert "stopping run cannot transition" in expired_review["error"]
        run(env, "task", "--run-id", expired_id, "--task-id", "T-expired", "--status", "blocked")
        assert run(env, "status", "--run-id", expired_id)["phase"] == "STOP_REQUESTED"
        finish(env, expired_id, "stopped", "deadline drain")

        lock.mkdir(parents=True)
        stale_lock = run(
            env,
            "start",
            "--repo",
            str(repo),
            "--operation",
            "plan",
            "--preset",
            "conservative",
            "--max-runtime-minutes",
            "10",
            "--max-workers",
            "1",
            "--effective-max-workers",
            "1",
            "--max-risk",
            "low",
            expected=2,
        )
        assert "timed out waiting for state lock" in stale_lock["error"]
        lock.rmdir()

        assert repo_digest(repo) == before_digest
        assert git(repo, "status", "--short", "--branch", "--untracked-files=all") == before_status
        assert hashlib.sha256(index_path.read_bytes()).hexdigest() == index_hash
        assert index_path.stat().st_mtime_ns == index_mtime

    print("ULTRABURN STATE TEST PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
