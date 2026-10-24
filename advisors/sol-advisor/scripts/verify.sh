#!/bin/sh
# Repository-local verification for Sol Advisor selective routing and UltraBurn.

set -eu

pass() { printf '%s\n' "PASS: $*"; }
fail() { printf '%s\n' "FAIL: $*" >&2; exit 1; }

resolve_python() {
  if [ -n "${PYTHON-}" ]; then
    if command -v "$PYTHON" >/dev/null 2>&1 && "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$PYTHON"
      return 0
    fi
    fail "PYTHON must name an executable Python 3.11 or newer."
  fi
  for candidate in python3.14 python3.13 python3.12 python3.11 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  fail "Python 3.11 or newer is required; set PYTHON to an explicit interpreter."
}

python_bin=$(resolve_python)

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
plugin_dir=$(CDPATH= cd "$script_dir/.." && pwd) || exit 1
repo_dir=$(CDPATH= cd "$plugin_dir/../.." && pwd) || exit 1
installer=$script_dir/install-agents.sh
runtime_inspector=$script_dir/inspect-agent-runtime.sh
primary_runtime_inspector=$script_dir/inspect-primary-runtime.sh
templates=$plugin_dir/agents
manifest=$plugin_dir/.codex-plugin/plugin.json
skill=$plugin_dir/skills/orchestration/SKILL.md
contracts=$plugin_dir/skills/orchestration/references/role-contracts.md
operations=$plugin_dir/skills/orchestration/references/operations.md
readme=$repo_dir/README.md
ui=$plugin_dir/skills/orchestration/agents/openai.yaml
ultraburn_skill=$plugin_dir/skills/ultraburn/SKILL.md
ultraburn_state_contract=$plugin_dir/skills/ultraburn/references/state-contract.md
ultraburn_ui=$plugin_dir/skills/ultraburn/agents/openai.yaml
ultraburn_state=$script_dir/ultraburn-state.py
ultraburn_test=$script_dir/test-ultraburn-state.py
ultraburn_profile=$plugin_dir/profiles/ultraburn.config.toml
retired_contract=$plugin_dir/skills/orchestration/references/luna-task-lane.md

tmp_base=/tmp
tmp_env=$(printenv TMPDIR 2>/dev/null || true)
if [ -n "$tmp_env" ]; then tmp_base=$tmp_env; fi
case "$tmp_base" in /*) ;; *) tmp_base=/tmp ;; esac
tmp_dir=''
cleanup() {
  if [ -n "$tmp_dir" ] && [ -d "$tmp_dir" ]; then
    case "$tmp_dir" in
      "$tmp_base"/sol-advisor-verify.*) rm -rf "$tmp_dir" ;;
      *) printf '%s\n' "REFUSING cleanup of unexpected directory: $tmp_dir" >&2 ;;
    esac
  fi
}
trap cleanup 0 HUP INT TERM
tmp_dir=$(mktemp -d "$tmp_base/sol-advisor-verify.XXXXXX") || fail "could not create disposable verification directory"

luna_file=sol-advisor-luna-implementer.toml
terra_file=sol-advisor-terra-implementer.toml
sol_file=sol-advisor-sol-reviewer.toml
ultraburn_file=sol-advisor-ultraburn-reviewer.toml
legacy_luna_sha256=fba1b42849d93737e83b094a2ab0b1611f87ac37db7438c8bbdf581f0813f8eb
legacy_terra_sha256=4425a8c1f21ce8c6af93f96adc253bbc33ea301f1389b3fa8ce350be08584eca
legacy_luna_v050_sha256=5cfaf77f14757074ca5d3cfecd0b8204c91dc14eff8d6119985c64416ddf4853
legacy_terra_v050_sha256=dc329fe87f6f6610c13157ec16432f91c79cf5a541ee3e7448f6afb165dd18ce

snapshot_files() {
  target=$1
  if [ ! -d "$target" ]; then
    printf '%s\n' MISSING
    return
  fi
  find "$target" -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort | while IFS= read -r path; do
    if [ -L "$path" ]; then
      printf 'L %s -> %s\n' "$(basename "$path")" "$(readlink "$path")"
    elif [ -f "$path" ]; then
      shasum -a 256 "$path"
    else
      printf 'O %s\n' "$(basename "$path")"
    fi
  done
}

write_legacy_roles() {
  target=$1
  mkdir -p "$target"
  cat > "$target/$luna_file" <<'LEGACY_LUNA'
name = "sol_advisor_luna_implementer"
description = "Sol Advisor's routine implementation lane for bounded, fully specified work."
model = "gpt-5.6-luna"
model_reasoning_effort = "max"

developer_instructions = """
You are Sol Advisor's routine implementation worker. Execute the supplied five-part
implementation specification exactly when it is bounded and largely determined by
the contract. Preserve stated interfaces and constraints, make only the files you
own, and adapt to concurrent edits instead of reverting work you do not own.

Surface material ambiguity, missing acceptance criteria, scope conflicts, or failed
verification rather than redesigning the architecture. Run the requested checks and
report actual evidence. Do not silently substitute a different role, model, or
reasoning level; this installed custom-agent profile is the required routine lane.
"""
LEGACY_LUNA
  cat > "$target/$terra_file" <<'LEGACY_TERRA'
name = "sol_advisor_terra_implementer"
description = "Sol Advisor's complex implementation lane for context-heavy or higher-risk work."
model = "gpt-5.6-terra"
model_reasoning_effort = "max"

developer_instructions = """
You are Sol Advisor's complex implementation worker. Resolve difficult implementation
details within the settled architecture, including context-heavy, higher-risk, or
wider-blast-radius work. Preserve every stated interface and constraint, stay within
the owned file set, and document material judgment calls.

You are not alone in the codebase: preserve concurrent edits and do not revert
unrelated work. Surface ambiguity, scope conflicts, or verification failures rather
than changing the architecture without direction. Run the requested checks and report
actual evidence. Do not silently substitute a different role, model, or reasoning
level; this installed custom-agent profile is the required complex lane.
"""
LEGACY_TERRA
  cp "$templates/$sol_file" "$target/$sol_file"
  [ "$(shasum -a 256 "$target/$luna_file" | awk '{print $1}')" = "$legacy_luna_sha256" ] || fail "legacy Luna fixture digest drifted"
  [ "$(shasum -a 256 "$target/$terra_file" | awk '{print $1}')" = "$legacy_terra_sha256" ] || fail "legacy Terra fixture digest drifted"
}

write_v050_roles() {
  target=$1
  mkdir -p "$target"
  cat > "$target/$luna_file" <<'V050_LUNA'
name = "sol_advisor_luna_implementer"
description = "Sol Advisor's default routine implementation lane for bounded, fully specified work."
model = "gpt-5.6-luna"
model_reasoning_effort = "max"

developer_instructions = """
You are Sol Advisor's default routine implementation worker. Execute the supplied
five-part implementation specification when the work is bounded and largely
determined by the contract. Preserve every stated interface and constraint, stay
within the owned file set, and document material judgment calls.

You are not alone in the codebase: preserve concurrent edits and do not revert
unrelated work. Surface material ambiguity, scope conflicts, or verification failures
rather than redesigning the architecture. Run the requested checks and report actual
evidence. If one corrected attempt shows that the work is judgment-heavy, high-risk,
or misclassified as routine, stop and return that signal so the parent can escalate
it to Terra / High. Do not silently substitute a different role, model, or reasoning
level; this installed custom-agent profile is the required routine lane.
"""
V050_LUNA
  cat > "$target/$terra_file" <<'V050_TERRA'
name = "sol_advisor_terra_implementer"
description = "Sol Advisor's explicit high-complexity escalation lane for judgment-heavy or high-risk work."
model = "gpt-5.6-terra"
model_reasoning_effort = "high"

developer_instructions = """
You are Sol Advisor's explicit high-complexity escalation worker. Execute the
supplied five-part implementation specification within the settled architecture when
the parent identifies judgment-heavy, high-risk, or wider-blast-radius work, or when
one corrected Luna attempt shows that routine routing was a misclassification.
Preserve every stated interface and constraint, stay within the owned file set, and
document material judgment calls.

You are not alone in the codebase: preserve concurrent edits and do not revert
unrelated work. Surface ambiguity, scope conflicts, or verification failures rather
than redesigning the architecture without direction. Run the requested checks and
report actual evidence. Do not silently substitute a different role, model, or
reasoning level; this installed custom-agent profile is the required escalation lane.
"""
V050_TERRA
  cp "$templates/$sol_file" "$target/$sol_file"
  [ "$(shasum -a 256 "$target/$luna_file" | awk '{print $1}')" = "$legacy_luna_v050_sha256" ] || fail "v0.5.0 Luna fixture digest drifted"
  [ "$(shasum -a 256 "$target/$terra_file" | awk '{print $1}')" = "$legacy_terra_v050_sha256" ] || fail "v0.5.0 Terra fixture digest drifted"
}

for required in "$installer" "$runtime_inspector" "$primary_runtime_inspector" "$manifest" "$skill" "$contracts" "$operations" "$readme" "$ui" "$ultraburn_skill" "$ultraburn_state_contract" "$ultraburn_ui" "$ultraburn_state" "$ultraburn_test" "$ultraburn_profile"; do
  test -f "$required" || fail "required file missing: $required"
done
test ! -e "$retired_contract" || fail "retired separate workflow contract remains: $retired_contract"
pass "required files present and retired contract absent"

jq empty "$manifest"
[ "$(jq -r '.version' "$manifest")" = 0.8.1+renna.5 ] || fail "manifest version is not 0.8.1+renna.5"
grep -Fq 'SELECTIVE ROUTE' "$manifest" || fail "manifest omits route declaration"
grep -Fq 'solo is the default' "$manifest" || fail "manifest omits solo default"
grep -Fq 'delegate may select role-pinned GPT-6 Luna / Max and Terra / High' "$manifest" || fail "manifest omits delegate role contract"
grep -Fq 'audit uses a fresh read-only GPT-6.1 Sol / High review' "$manifest" || fail "manifest omits audit contract"
grep -Fq 'full uses the useful set of selected implementers' "$manifest" || fail "manifest omits dynamic full contract"
grep -Fq 'fails closed' "$manifest" || fail "manifest omits fail-closed evidence rule"
grep -Fq 'explicit-only UltraBurn' "$manifest" || fail "manifest omits explicit UltraBurn boundary"
pass "manifest JSON, v0.8.1+renna.5 local build, dynamic routing, and explicit UltraBurn"

"$python_bin" - "$templates" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
expected = {
    "sol-advisor-luna-implementer.toml": {
        "name": "sol_advisor_luna_implementer",
        "model": "gpt-6-luna",
        "model_reasoning_effort": "max",
    },
    "sol-advisor-terra-implementer.toml": {
        "name": "sol_advisor_terra_implementer",
        "model": "gpt-5.6-terra",
        "model_reasoning_effort": "high",
    },
    "sol-advisor-sol-reviewer.toml": {
        "name": "sol_advisor_sol_reviewer",
        "model": "gpt-6.1-sol",
        "model_reasoning_effort": "high",
        "sandbox_mode": "read-only",
    },
    "sol-advisor-ultraburn-reviewer.toml": {
        "name": "sol_advisor_ultraburn_reviewer",
        "model": "gpt-6.1-sol",
        "model_reasoning_effort": "ultra",
        "sandbox_mode": "read-only",
    },
}
actual = {path.name for path in root.glob("*.toml")}
if actual != set(expected):
    raise SystemExit(f"expected exactly {sorted(expected)}, found {sorted(actual)}")
for filename, pins in expected.items():
    data = tomllib.loads((root / filename).read_text(encoding="utf-8"))
    for field in ("name", "description", "developer_instructions"):
        if not isinstance(data.get(field), str) or not data[field].strip():
            raise SystemExit(f"{filename}: missing {field}")
    for field, value in pins.items():
        if data.get(field) != value:
            raise SystemExit(f"{filename}: {field}={data.get(field)!r}, expected {value!r}")
print("four exact role pins are valid")
PY
pass "exact four-role TOML inventory"

grep -Fq "legacy_luna_sha256=$legacy_luna_sha256" "$installer" || fail "installer legacy Luna digest mismatch"
grep -Fq "legacy_terra_sha256=$legacy_terra_sha256" "$installer" || fail "installer legacy Terra digest mismatch"
grep -Fq "legacy_luna_v050_sha256=$legacy_luna_v050_sha256" "$installer" || fail "installer v0.5.0 Luna digest mismatch"
grep -Fq "legacy_terra_v050_sha256=$legacy_terra_v050_sha256" "$installer" || fail "installer v0.5.0 Terra digest mismatch"
pass "immutable historical migration fingerprints"

clean_target=$tmp_dir/clean
sh "$installer" --target-dir "$clean_target"
for role in "$luna_file" "$terra_file" "$sol_file" "$ultraburn_file"; do
  cmp -s "$templates/$role" "$clean_target/$role" || fail "clean install mismatch: $role"
done
sh "$installer" --target-dir "$clean_target" --check
before=$(snapshot_files "$clean_target")
sh "$installer" --target-dir "$clean_target"
after=$(snapshot_files "$clean_target")
[ "$before" = "$after" ] || fail "idempotent install changed current roles"
pass "clean install, exact check, and idempotence"

selective_target=$tmp_dir/selective
sh "$installer" --target-dir "$selective_target"
printf '%s\n' modified >> "$selective_target/$terra_file"
before=$(snapshot_files "$selective_target")
sh "$installer" --target-dir "$selective_target" --check --check-role luna --check-role sol
sh "$installer" --target-dir "$selective_target" --check --check-role ultraburn
after=$(snapshot_files "$selective_target")
[ "$before" = "$after" ] || fail "selective Luna/Sol check mutated conflicting Terra target"
if sh "$installer" --target-dir "$selective_target" --check --check-role terra >/dev/null 2>&1; then
  fail "selective Terra check accepted conflicting Terra target"
fi
after=$(snapshot_files "$selective_target")
[ "$before" = "$after" ] || fail "selective Terra refusal mutated target"
if sh "$installer" --target-dir "$selective_target" --check >/dev/null 2>&1; then
  fail "all-role --check accepted conflicting Terra target"
fi
if sh "$installer" --target-dir "$selective_target" --check-role >/dev/null 2>&1; then
  fail "missing --check-role argument was accepted"
fi
if sh "$installer" --target-dir "$selective_target" --check-role unknown >/dev/null 2>&1; then
  fail "unknown --check-role argument was accepted"
fi
after=$(snapshot_files "$selective_target")
[ "$before" = "$after" ] || fail "invalid selective check mutated target"
pass "selective Luna/Sol check, Terra refusal, all-role compatibility, and invalid-role refusal"

upfront_terra_target=$tmp_dir/upfront-terra
sh "$installer" --target-dir "$upfront_terra_target"
printf '%s\n' modified >> "$upfront_terra_target/$luna_file"
before=$(snapshot_files "$upfront_terra_target")
sh "$installer" --target-dir "$upfront_terra_target" --check --check-role terra --check-role sol
after=$(snapshot_files "$upfront_terra_target")
[ "$before" = "$after" ] || fail "selective Terra/Sol check mutated conflicting Luna target"
if sh "$installer" --target-dir "$upfront_terra_target" --check --check-role luna >/dev/null 2>&1; then
  fail "selective Luna check accepted conflicting Luna target"
fi
after=$(snapshot_files "$upfront_terra_target")
[ "$before" = "$after" ] || fail "selective Luna refusal mutated target"
if sh "$installer" --target-dir "$upfront_terra_target" --check >/dev/null 2>&1; then
  fail "all-role --check accepted conflicting Luna target"
fi
after=$(snapshot_files "$upfront_terra_target")
[ "$before" = "$after" ] || fail "all-role Luna refusal mutated target"
pass "selective Terra/Sol up-front path, Luna refusal, and all-role compatibility"

missing_target=$tmp_dir/missing
if sh "$installer" --target-dir "$missing_target" --check; then fail "--check accepted missing target"; fi
test ! -e "$missing_target" || fail "--check mutated missing target"
pass "missing-target check refusal is non-mutating"

codex_home=$tmp_dir/codex-home
CODEX_HOME="$codex_home" sh "$installer"
for role in "$luna_file" "$terra_file" "$sol_file" "$ultraburn_file"; do
  cmp -s "$templates/$role" "$codex_home/agents/$role" || fail "CODEX_HOME install mismatch: $role"
done
test ! -e "$codex_home/config.toml" || fail "installer created config.toml"
case "$(uname -s 2>/dev/null || true)" in
  MSYS*|MINGW*|CYGWIN*)
    native_windows_target=$tmp_dir/native-windows-target
    native_windows_backslash=$(cygpath -w "$native_windows_target") || fail "could not derive native Windows fixture path"
    native_windows_forward=$(cygpath -m "$native_windows_target") || fail "could not derive forward-slash Windows fixture path"
    sh "$installer" --target-dir "$native_windows_backslash"
    sh "$installer" --target-dir "$native_windows_forward" --check
    cmp -s "$templates/$luna_file" "$native_windows_target/$luna_file" || fail "native Windows target normalization mismatch"
    native_windows_home=$tmp_dir/native-windows-home
    native_windows_home_backslash=$(cygpath -w "$native_windows_home") || fail "could not derive native Windows CODEX_HOME fixture"
    CODEX_HOME="$native_windows_home_backslash" sh "$installer"
    cmp -s "$templates/$sol_file" "$native_windows_home/agents/$sol_file" || fail "native Windows CODEX_HOME normalization mismatch"
    pass "native Windows CODEX_HOME/target path normalization"
    ;;
esac
relative_parent=$tmp_dir/relative-parent
mkdir "$relative_parent"
(cd "$relative_parent" && sh "$installer" --target-dir relative-agents)
cmp -s "$templates/$luna_file" "$relative_parent/relative-agents/$luna_file" || fail "relative target Luna mismatch"
pass "CODEX_HOME and relative target behavior"

migration_target=$tmp_dir/migration
write_legacy_roles "$migration_target"
sh "$installer" --target-dir "$migration_target"
for role in "$luna_file" "$terra_file" "$sol_file" "$ultraburn_file"; do
  cmp -s "$templates/$role" "$migration_target/$role" || fail "historical migration mismatch: $role"
done
sh "$installer" --target-dir "$migration_target" --check
pass "exact historical Luna/Terra migration"

v050_migration_target=$tmp_dir/v050-migration
write_v050_roles "$v050_migration_target"
sh "$installer" --target-dir "$v050_migration_target"
for role in "$luna_file" "$terra_file" "$sol_file" "$ultraburn_file"; do
  cmp -s "$templates/$role" "$v050_migration_target/$role" || fail "v0.5.0 migration mismatch: $role"
done
sh "$installer" --target-dir "$v050_migration_target" --check
pass "exact v0.5.0 Luna/Terra migration"

modified_v050_luna=$tmp_dir/modified-v050-luna
write_v050_roles "$modified_v050_luna"
printf 'X' >> "$modified_v050_luna/$luna_file"
before=$(snapshot_files "$modified_v050_luna")
if sh "$installer" --target-dir "$modified_v050_luna"; then fail "installer replaced modified v0.5.0 Luna"; fi
after=$(snapshot_files "$modified_v050_luna")
[ "$before" = "$after" ] || fail "modified v0.5.0 Luna refusal partially mutated target"
pass "modified v0.5.0 Luna refusal with zero partial mutation"

modified_v050_terra=$tmp_dir/modified-v050-terra
write_v050_roles "$modified_v050_terra"
printf 'X' >> "$modified_v050_terra/$terra_file"
before=$(snapshot_files "$modified_v050_terra")
if sh "$installer" --target-dir "$modified_v050_terra"; then fail "installer replaced modified v0.5.0 Terra"; fi
after=$(snapshot_files "$modified_v050_terra")
[ "$before" = "$after" ] || fail "modified v0.5.0 Terra refusal partially mutated target"
pass "modified v0.5.0 Terra refusal with zero partial mutation"

modified_luna=$tmp_dir/modified-luna
write_legacy_roles "$modified_luna"
printf '%s\n' modified >> "$modified_luna/$luna_file"
before=$(snapshot_files "$modified_luna")
if sh "$installer" --target-dir "$modified_luna"; then fail "installer replaced modified Luna"; fi
after=$(snapshot_files "$modified_luna")
[ "$before" = "$after" ] || fail "modified-Luna refusal partially mutated target"
pass "modified Luna refusal with zero partial mutation"

modified_terra=$tmp_dir/modified-terra
write_legacy_roles "$modified_terra"
printf '%s\n' modified >> "$modified_terra/$terra_file"
before=$(snapshot_files "$modified_terra")
if sh "$installer" --target-dir "$modified_terra"; then fail "installer replaced modified Terra"; fi
after=$(snapshot_files "$modified_terra")
[ "$before" = "$after" ] || fail "modified-Terra refusal partially mutated target"
pass "differing legacy Terra refusal with zero partial mutation"

modified_current=$tmp_dir/modified-current
sh "$installer" --target-dir "$modified_current"
printf '%s\n' modified >> "$modified_current/$luna_file"
before=$(snapshot_files "$modified_current")
if sh "$installer" --target-dir "$modified_current"; then fail "installer replaced modified current Luna"; fi
after=$(snapshot_files "$modified_current")
[ "$before" = "$after" ] || fail "modified current Luna refusal partially mutated target"
pass "modified current-role refusal with zero partial mutation"

unsafe=$tmp_dir/unsafe
mkdir "$unsafe"
case "$(uname -s 2>/dev/null || true)" in
  MSYS*|MINGW*|CYGWIN*) MSYS=winsymlinks:nativestrict ln -s "$templates/$luna_file" "$unsafe/$luna_file" || fail "native Windows symlink prerequisite is unavailable" ;;
  *) ln -s "$templates/$luna_file" "$unsafe/$luna_file" || fail "native symlink prerequisite is unavailable" ;;
esac
test -L "$unsafe/$luna_file" || fail "symlink fixture is not a real symlink"
before=$(snapshot_files "$unsafe")
if sh "$installer" --target-dir "$unsafe"; then fail "installer accepted symlinked Luna"; fi
after=$(snapshot_files "$unsafe")
[ "$before" = "$after" ] || fail "symlink refusal partially mutated target"
test ! -e "$unsafe/$terra_file" || fail "symlink refusal partially installed Terra"
test ! -e "$unsafe/$sol_file" || fail "symlink refusal partially installed Sol"
test ! -e "$unsafe/$ultraburn_file" || fail "symlink refusal partially installed UltraBurn"
pass "unsafe destination refusal with zero partial mutation"

runtime_sessions=$tmp_dir/runtime-sessions
runtime_day=$runtime_sessions/2026/08/15
mkdir -p "$runtime_day"
runtime_id=11111111-1111-7111-8111-111111111111
runtime_rollout=$runtime_day/rollout-2026-08-15T00-00-00-$runtime_id.jsonl
printf '%s\n' \
  '{"type":"response_item","payload":{"prompt":"DO_NOT_LEAK_PROMPT"}}' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$runtime_id\",\"parent_thread_id\":\"00000000-0000-7000-8000-000000000000\",\"agent_role\":\"sol_advisor_luna_implementer\",\"agent_path\":\"/root/fixture\",\"model_provider\":\"openai\",\"cwd\":\"/fixture\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6-luna","effort":"max","sandbox_policy":{"type":"danger-full-access"},"permission_profile":{"type":"disabled"},"cwd":"/fixture"}}' \
  > "$runtime_rollout"
runtime_output=$(sh "$runtime_inspector" --sessions-dir "$runtime_sessions" "$runtime_id")
printf '%s\n' "$runtime_output" | jq -e --arg id "$runtime_id" '
  .thread_id == $id and .agent_role == "sol_advisor_luna_implementer"
  and .model == "gpt-6-luna" and .effort == "max"
  and .sandbox_policy_type == "danger-full-access"
  and .permission_profile_type == "disabled"
' >/dev/null || fail "runtime inspector returned wrong Luna/Max evidence"
if printf '%s\n' "$runtime_output" | grep -Fq DO_NOT_LEAK; then fail "runtime inspector leaked payload"; fi
if sh "$runtime_inspector" --sessions-dir "$runtime_sessions" invalid >/dev/null 2>&1; then fail "runtime inspector accepted invalid id"; fi
zero_id=22222222-2222-7222-8222-222222222222
if sh "$runtime_inspector" --sessions-dir "$runtime_sessions" "$zero_id" >/dev/null 2>&1; then fail "runtime inspector accepted zero matches"; fi
pass "runtime inspector Luna/Max routing and safe refusal"

primary_runtime_id=33333333-3333-7333-8333-333333333333
primary_runtime_rollout=$runtime_day/rollout-2026-08-15T00-00-01-$primary_runtime_id.jsonl
printf '%s\n' \
  '{"type":"response_item","payload":{"prompt":"DO_NOT_LEAK_PRIMARY_PROMPT"}}' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$primary_runtime_id\",\"parent_thread_id\":null,\"agent_role\":null,\"agent_path\":null,\"model_provider\":\"openai\",\"cwd\":\"/fixture\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  > "$primary_runtime_rollout"
primary_runtime_output=$(sh "$primary_runtime_inspector" --sessions-dir "$runtime_sessions" "$primary_runtime_id")
printf '%s\n' "$primary_runtime_output" | jq -e --arg id "$primary_runtime_id" '
  .thread_id == $id and .session_kind == "primary"
  and .model_provider == "openai" and .model == "gpt-6.1-sol" and .effort == "ultra"
  and .sandbox_policy_type == "workspace-write"
  and .permission_profile_type == "managed"
' >/dev/null || fail "primary runtime inspector returned wrong Sol/Ultra evidence"
if printf '%s\n' "$primary_runtime_output" | grep -Fq DO_NOT_LEAK; then fail "primary runtime inspector leaked payload"; fi
if sh "$primary_runtime_inspector" --sessions-dir "$runtime_sessions" "$runtime_id" >/dev/null 2>&1; then
  fail "primary runtime inspector accepted a native-agent rollout"
fi

expect_primary_refusal() {
  fixture_id=$1
  reason=$2
  if sh "$primary_runtime_inspector" --sessions-dir "$runtime_sessions" "$fixture_id" >/dev/null 2>&1; then
    fail "primary runtime inspector accepted $reason"
  fi
}

missing_isolation_id=44444444-4444-7444-8444-444444444444
printf '%s\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$missing_isolation_id\",\"parent_thread_id\":null,\"agent_role\":null,\"agent_path\":null,\"model_provider\":\"openai\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"cwd":"/fixture"}}' \
  > "$runtime_day/rollout-2026-08-15T00-00-02-$missing_isolation_id.jsonl"
expect_primary_refusal "$missing_isolation_id" "missing isolation metadata"

missing_marker_id=55555555-5555-7555-8555-555555555555
printf '%s\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$missing_marker_id\",\"agent_role\":null,\"agent_path\":null,\"model_provider\":\"openai\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  > "$runtime_day/rollout-2026-08-15T00-00-03-$missing_marker_id.jsonl"
expect_primary_refusal "$missing_marker_id" "partially omitted primary markers"

malformed_marker_id=66666666-6666-7666-8666-666666666666
printf '%s\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$malformed_marker_id\",\"parent_thread_id\":false,\"agent_role\":{},\"agent_path\":0,\"model_provider\":\"openai\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  > "$runtime_day/rollout-2026-08-15T00-00-04-$malformed_marker_id.jsonl"
expect_primary_refusal "$malformed_marker_id" "malformed primary markers"

duplicate_session_id=77777777-7777-7777-8777-777777777777
printf '%s\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$duplicate_session_id\",\"parent_thread_id\":null,\"agent_role\":null,\"agent_path\":null,\"model_provider\":\"openai\"}}" \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$duplicate_session_id\",\"parent_thread_id\":null,\"agent_role\":null,\"agent_path\":null,\"model_provider\":\"openai\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  > "$runtime_day/rollout-2026-08-15T00-00-05-$duplicate_session_id.jsonl"
expect_primary_refusal "$duplicate_session_id" "duplicate session metadata"

conflicting_turn_id=88888888-8888-7888-8888-888888888888
printf '%s\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$conflicting_turn_id\",\"parent_thread_id\":null,\"agent_role\":null,\"agent_path\":null,\"model_provider\":\"openai\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  '{"type":"turn_context","payload":{"model":"gpt-6-luna","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  > "$runtime_day/rollout-2026-08-15T00-00-06-$conflicting_turn_id.jsonl"
expect_primary_refusal "$conflicting_turn_id" "conflicting turn metadata"

mismatched_id=99999999-9999-7999-8999-999999999999
printf '%s\n' \
  '{"type":"session_meta","payload":{"id":"00000000-0000-7000-8000-000000000000","parent_thread_id":null,"agent_role":null,"agent_path":null,"model_provider":"openai"}}' \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  > "$runtime_day/rollout-2026-08-15T00-00-07-$mismatched_id.jsonl"
expect_primary_refusal "$mismatched_id" "mismatched session id"

malformed_json_id=aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa
printf '%s\n' '{not-json' > "$runtime_day/rollout-2026-08-15T00-00-08-$malformed_json_id.jsonl"
expect_primary_refusal "$malformed_json_id" "malformed JSON"

ambiguous_filename_id=bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb
mkdir -p "$runtime_sessions/2026/08/16" "$runtime_sessions/2026/08/17"
printf '%s\n' '{}' > "$runtime_sessions/2026/08/16/rollout-a-$ambiguous_filename_id.jsonl"
printf '%s\n' '{}' > "$runtime_sessions/2026/08/17/rollout-b-$ambiguous_filename_id.jsonl"
expect_primary_refusal "$ambiguous_filename_id" "ambiguous rollout filenames"

consistent_turn_id=cccccccc-cccc-7ccc-8ccc-cccccccccccc
consistent_turn_rollout=$runtime_day/rollout-2026-08-15T00-00-09-$consistent_turn_id.jsonl
printf '%s\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$consistent_turn_id\",\"parent_thread_id\":null,\"agent_role\":null,\"agent_path\":null,\"model_provider\":\"openai\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  > "$consistent_turn_rollout"
consistent_turn_output=$(sh "$primary_runtime_inspector" --sessions-dir "$runtime_sessions" "$consistent_turn_id")
printf '%s\n' "$consistent_turn_output" | jq -e --arg id "$consistent_turn_id" '
  .thread_id == $id and .model == "gpt-6.1-sol" and .effort == "ultra"
  and .sandbox_policy_type == "workspace-write"
  and .permission_profile_type == "managed" and .cwd == "/fixture"
' >/dev/null || fail "primary runtime inspector rejected consistent multi-turn evidence"

omitted_markers_id=dddddddd-dddd-7ddd-8ddd-dddddddddddd
printf '%s\n' \
  "{\"type\":\"session_meta\",\"payload\":{\"id\":\"$omitted_markers_id\",\"model_provider\":\"openai\"}}" \
  '{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"ultra","sandbox_policy":{"type":"workspace-write"},"permission_profile":{"type":"managed"},"cwd":"/fixture"}}' \
  > "$runtime_day/rollout-2026-08-15T00-00-10-$omitted_markers_id.jsonl"
omitted_markers_output=$(sh "$primary_runtime_inspector" --sessions-dir "$runtime_sessions" "$omitted_markers_id")
printf '%s\n' "$omitted_markers_output" | jq -e --arg id "$omitted_markers_id" '
  .thread_id == $id and .session_kind == "primary"
  and .model == "gpt-6.1-sol" and .effort == "ultra"
' >/dev/null || fail "primary runtime inspector rejected an observed primary schema with all native markers omitted"

pass "primary runtime inspector exact Sol/Ultra primary routing, observed omitted-marker schema, ambiguity refusal, and multi-turn consistency"

for document in "$contracts" "$operations"; do
  grep -Fq 'agent_type: sol_advisor_luna_implementer' "$document" || fail "missing Luna spawn in $document"
  grep -Fq 'agent_type: sol_advisor_terra_implementer' "$document" || fail "missing Terra spawn in $document"
  grep -Fq 'agent_type: sol_advisor_sol_reviewer' "$document" || fail "missing Sol spawn in $document"
  grep -Fq 'fork_turns: none' "$document" || fail "missing fresh context in $document"
  if grep -Eq 'agent_type:.*terra_max' "$document"; then fail "retired Terra-Max spawn remains in $document"; fi
  if grep -Eq '^[[:space:]]*(model|reasoning_effort):' "$document"; then fail "per-spawn override remains in $document"; fi
done
grep -Fq 'references/operations.md' "$skill" || fail "skill does not link operations reference"
grep -Fq '../../scripts/install-agents.sh' "$operations" || fail "operations does not resolve installer relatively"
grep -Fq '../../scripts/inspect-agent-runtime.sh' "$operations" || fail "operations does not resolve inspector relatively"
grep -Fq 'SELECTIVE ROUTE' "$skill" || fail "skill omits route declaration"
grep -Fq 'mode: solo | delegate | audit | full' "$skill" || fail "skill omits exact route modes"
grep -Fq 'No task tool call may precede this declaration' "$skill" || fail "skill permits tool-before-route"
grep -Fq 'Solo is the default' "$skill" || fail "skill omits solo default"
grep -Fq 'no policy headcount ceiling' "$skill" || fail "skill omits dynamic capacity rule"
grep -Fq 'substantial delegated implementation' "$skill" || fail "skill omits substantial-work review rule"
grep -Fq 'A later declaration may escalate for newly observed work or risk;' "$skill" || fail "skill omits escalation gate"
grep -Fq 'never silently downgrade' "$skill" || fail "skill permits silent downgrade"
grep -Fqi 'public metadata' "$skill" || fail "skill lacks public-metadata evidence rule"
grep -Fqi 'local inspector' "$skill" || fail "skill lacks runtime fallback rule"
grep -Fqi 'parent captures and verifies exact before-and-after' "$contracts" || fail "contracts lack behavioral read-only state check"
for mode in solo delegate audit full; do
  grep -Fq "\`$mode\`" "$skill" || fail "skill omits $mode mode"
  grep -Fq "\`$mode\`" "$contracts" || fail "contracts omit $mode mode"
done
grep -Fqi 'auxiliary work must substitute for root work' "$skill" || fail "skill permits duplicate auxiliary work"
grep -Fqi 'auxiliary work substitutes for root work' "$contracts" || fail "contracts permit duplicate auxiliary work"
grep -Fqi 'first Luna result' "$contracts" || fail "contracts omit Luna-to-Terra escalation"
grep -Fqi 'not a prerequisite' "$contracts" || fail "contracts make corrected Luna mandatory"
grep -Fq 'fresh review for non-substantial work' "$skill" || fail "skill makes delegate review mandatory"
grep -Fq '`solo` and `delegate` do not receive a fresh reviewer' "$skill" || fail "skill makes solo/delegate review mandatory"
grep -Fq 'audit: the root implements the required correction, re-verifies, and obtains a new' "$skill" || fail "skill does not assign audit corrections to root"
grep -Fq 'full: the implementer that owns the required correction handles it, the root' "$skill" || fail "skill does not assign full corrections to the owning implementer"
if grep -Fq 'fix-first: delegate the required correction' "$skill"; then fail "skill retains unconditional fix-first delegation"; fi
grep -Fq 'On `fix-first`, the root implements the' "$contracts" || fail "contracts do not assign audit corrections to root"
grep -Fq 'On `fix-first`, the implementer that' "$contracts" || fail "contracts do not assign full corrections to the owning implementer"
if grep -Fqi 'commitment-boundary sol consult' "$contracts"; then fail "contracts retain an ungated commitment-boundary consult"; fi
pass "native role contracts, selective route declaration, escalation, and correction checks"

for phrase in \
  'agent_type: sol_advisor_luna_implementer' \
  'agent_type: sol_advisor_terra_implementer' \
  'agent_type: sol_advisor_sol_reviewer' \
  'fork_turns: none' \
  'SELECTIVE ROUTE' \
  'solo | delegate | audit | full' \
  'Solo is the default' \
  'no policy headcount ceiling' \
  'emit a later declaration to escalate' \
  'local inspector' \
  'sandbox_mode = read-only' \
  'install-agents.sh --check'; do
  grep -Fqi "$phrase" "$operations" || fail "operations reference omits: $phrase"
done
pass "operations reference preserves selective native operational detail"

readme_lines=$(wc -l < "$readme" | tr -d ' ')
[ "$readme_lines" -le 120 ] || fail "README remains maintainer-sized ($readme_lines lines)"
grep -Fq 'codex plugin marketplace add' "$readme" || fail "README omits marketplace quick start"
grep -Fq 'codex plugin add' "$readme" || fail "README omits plugin quick start"
grep -Fq 'scripts/install-agents.sh' "$readme" || fail "README omits companion install"
if grep -Eq 'agent_type:|fork_turns:|inspect-agent-runtime|sandbox_policy|sandbox_mode' "$readme"; then
  fail "README exposes maintainer routing/runtime machinery"
fi
if grep -Fq -- '--check' "$readme"; then
  fail "README quick start repeats the post-install --check"
fi
grep -Fq 'advanced native operations' "$readme" || fail "README omits operations link"
grep -Fq '| `solo` |' "$readme" || fail "README route table omits solo"
grep -Fq '| `delegate` |' "$readme" || fail "README route table omits delegate"
grep -Fq '| `audit` |' "$readme" || fail "README route table omits audit"
grep -Fq '| `full` |' "$readme" || fail "README route table omits full"
grep -Fq 'Solo is the default.' "$readme" || fail "README omits solo default"
grep -Fq 'there is no policy headcount ceiling' "$readme" || fail "README omits dynamic capacity rule"
grep -Fq 'Substantial delegated implementation uses' "$readme" || fail "README omits substantial-work review rule"
grep -Fq 'before the first task tool call' "$readme" || fail "README omits route-before-tools rule"
grep -Fq 'newly observed' "$readme" || fail "README omits escalation gate"
grep -Fq 'never silently downgrades' "$readme" || fail "README permits silent downgrade"
grep -Fq 'need to select or manage a lane' "$readme" || fail "README asks users to manage lanes"
grep -Fq 'Luna / Max or GPT-5.6 Terra / High access is needed only when' "$readme" || fail "README omits conditional delegate access"
"$python_bin" - "$readme" <<'PY'
from pathlib import Path
import sys

lines = [line.strip() for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()]
install_lines = [line for line in lines if line.startswith("plugin_dir=\"") and "scripts/install-agents.sh" in line]
if len(install_lines) != 2:
    raise SystemExit(f"expected two guarded companion install examples, found {len(install_lines)}")
for line in install_lines:
    required = [
        'test -n "$plugin_dir"',
        'test "$plugin_dir" != null',
        'test -d "$plugin_dir"',
        'test -f "$plugin_dir/scripts/install-agents.sh"',
    ]
    if any(check not in line for check in required):
        raise SystemExit(f"unguarded companion install example: {line}")
    if line.index("sh \"") < line.index(required[-1]):
        raise SystemExit(f"installer executes before directory/file guards: {line}")
print("two companion install examples are fail-closed and guarded")
PY
pass "README is concise, user-first, route-tabled, and keeps maintainer machinery out"

"$python_bin" - "$readme" "$manifest" "$skill" "$contracts" "$operations" "$ui" "$templates" "$ultraburn_skill" "$ultraburn_state_contract" "$ultraburn_ui" <<'PY'
from pathlib import Path
import sys

roots = [Path(value) for value in sys.argv[1:]]
terms = [
    "list_" + "projects",
    "list_" + "threads",
    "create_" + "thread",
    "wait_" + "threads",
    "read_" + "thread",
    "send_" + "message_to_thread",
    "client" + "ThreadId",
    "app-" + "task",
    "app " + "task",
    "Luna " + "task",
    "task-" + "lane",
]
paths = []
for root in roots:
    if root.is_file():
        paths.append(root)
    elif root.is_dir():
        paths.extend(path for path in root.rglob("*") if path.is_file())
for path in paths:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    for term in terms:
        if term in text:
            raise SystemExit(f"obsolete workflow reference {term!r} remains in {path}")
print("obsolete workflow references are absent")
PY

grep -Fq 'Sol / High runs the show' "$readme" || fail "README omits primary ownership"
grep -Fq 'Luna / Max' "$readme" || fail "README omits Luna / Max delegate path"
grep -Fq 'Terra / High' "$readme" || fail "README omits Terra delegate path"
grep -Fq 'Auxiliary work substitutes' "$readme" || fail "README omits substitution rule"
grep -Fq 'Attention Heads' "$readme" || fail "README lost Attention Heads section"
grep -Fq 'https://attentionheads.substack.com/?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor' "$readme" || fail "README changed Attention Heads link"
grep -Fq 'https://attentionheads.substack.com/subscribe?utm_source=github&utm_medium=readme&utm_campaign=sol-advisor' "$readme" || fail "README changed Subscribe link"
pass "README selective routing and preserved Go deeper links"

for document in "$readme" "$manifest" "$skill" "$contracts" "$ui"; do
  if grep -Eqi 'Terra / High is the sole implementation producer|one role-pinned .*handles all implementation|route all implementation through.*Terra|delegate all implementation to (the )?(native )?Terra' "$document"; then
    fail "stale single-mode implementation claim remains in $document"
  fi
done
for forbidden in sol_advisor_terra_max sol-advisor-terra-max; do
  if rg -n "$forbidden" "$readme" "$manifest" "$skill" "$contracts" "$ui" "$templates"; then fail "forbidden second Terra role remains"; fi
done
pass "obsolete single-lane claims and second Terra role absent"

grep -Fq 'allow_implicit_invocation: false' "$ultraburn_ui" || fail "UltraBurn permits implicit invocation"
grep -Fq 'The primary session must be exact `gpt-6.1-sol` with reasoning effort `ultra`' "$ultraburn_skill" || fail "UltraBurn omits exact primary route"
grep -Fq 'model_context_window = 1050000' "$ultraburn_skill" || fail "UltraBurn omits the one-million-token CLI window"
grep -Fq 'model_auto_compact_token_limit = 1000000' "$ultraburn_skill" || fail "UltraBurn omits the one-million-token compaction threshold"
grep -Fq -- '--profile ultraburn -s workspace-write' "$ultraburn_skill" || fail "UltraBurn omits the explicit safe CLI profile"
grep -Fq 'Normal Sol Advisor continues to use the exact `solo`, `delegate`, `audit`,' "$ultraburn_skill" || fail "UltraBurn does not preserve normal routes"
grep -Fq 'Capacity has no policy headcount ceiling' "$ultraburn_skill" || fail "UltraBurn retains a concurrency cap"
grep -Fq 'runtime availability and records the selected effective capacity' "$ultraburn_skill" || fail "UltraBurn claims helper runtime observation"
grep -Fq 'Do not fabricate quota' "$ultraburn_skill" || fail "UltraBurn permits fabricated quota"
grep -Fq 'Before each new packet call `check-stop`' "$ultraburn_skill" || fail "UltraBurn omits stop gate"
grep -Fq 'A worker narrative is not evidence' "$ultraburn_skill" || fail "UltraBurn trusts worker narrative"
grep -Fq 'agent_type: sol_advisor_ultraburn_reviewer' "$ultraburn_skill" || fail "UltraBurn omits exact reviewer role spawn"
grep -Fq 'fork_turns: none' "$ultraburn_skill" || fail "UltraBurn reviewer is not fresh-context"
grep -Fq -- '--check --check-role ultraburn' "$ultraburn_skill" || fail "UltraBurn omits reviewer preflight"
grep -Fq 'observed read-only isolation' "$ultraburn_skill" || fail "UltraBurn omits reviewer isolation evidence"
grep -Fq '../../scripts/inspect-primary-runtime.sh' "$ultraburn_skill" || fail "UltraBurn omits primary runtime inspector"
grep -Fq 'agent_type: sol_advisor_ultraburn_reviewer' "$operations" || fail "operations omit exact UltraBurn reviewer role"
grep -Fq 'It never authorizes' "$ultraburn_skill" || fail "UltraBurn omits authority boundary"
grep -Fq 'atomic replace' "$ultraburn_state_contract" || fail "UltraBurn state contract omits atomic writes"
grep -Fq 'optional locks disabled' "$ultraburn_state_contract" || fail "UltraBurn state contract omits non-mutating Git reads"
grep -Fq 'final HEAD' "$ultraburn_state_contract" || fail "UltraBurn state contract omits final Git evidence"
grep -Fq 'A stop never kills a process' "$ultraburn_state_contract" || fail "UltraBurn stop is not graceful"
grep -Fq 'UltraBurn is a separate explicit-only skill' "$skill" || fail "normal orchestration omits UltraBurn separation"
grep -Fq '$sol-advisor:ultraburn plan|run|status|stop' "$readme" || fail "README omits UltraBurn invocation"
grep -Fq -- '--profile ultraburn -s workspace-write' "$readme" || fail "README omits the explicit safe UltraBurn CLI profile"
"$python_bin" - "$ultraburn_profile" <<'PY'
from pathlib import Path
import sys
import tomllib

with Path(sys.argv[1]).open("rb") as stream:
    profile = tomllib.load(stream)
expected = {
    "model": "gpt-6.1-sol",
    "model_reasoning_effort": "ultra",
    "model_context_window": 1_050_000,
    "model_auto_compact_token_limit": 1_000_000,
    "model_auto_compact_token_limit_scope": "total",
}
if profile != expected:
    raise SystemExit(f"UltraBurn CLI profile mismatch: {profile!r}")
print("exact UltraBurn one-million-token CLI profile is valid")
PY
pass "UltraBurn is explicit, one-million-context, dynamically capacity-planned, durable, graceful, and authority-preserving"

"$python_bin" - "$ultraburn_state" "$ultraburn_test" "$tmp_dir" <<'PY'
from pathlib import Path
import py_compile
import sys

target = Path(sys.argv[3]) / "pycache"
target.mkdir()
for index, source in enumerate(sys.argv[1:3]):
    py_compile.compile(source, cfile=str(target / f"candidate-{index}.pyc"), doraise=True)
PY
"$python_bin" "$ultraburn_test"
pass "UltraBurn state helper syntax and disposable lifecycle"

"$python_bin" "$script_dir/test-gpt6-migration.py"
pass "exact GPT-5.6 to GPT-6 migration, LF/CRLF, idempotence, and conflict refusal"

sh -n "$installer"
sh -n "$runtime_inspector"
sh -n "$primary_runtime_inspector"
sh -n "$script_dir/verify.sh"
pass "shell syntax"

printf '%s\n' "VERIFY PASSED: Sol Advisor v0.8.1+renna.5 dynamic routing and UltraBurn checks completed in $tmp_dir"
