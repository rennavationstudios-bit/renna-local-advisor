#!/bin/sh
# Emit allowlisted routing metadata from one exact primary Codex rollout.

set -eu

usage() {
  cat <<'EOF'
Usage: inspect-primary-runtime.sh [--sessions-dir DIR] THREAD_ID

Read the one primary rollout whose filename ends with THREAD_ID and emit only
allowlisted routing metadata. Without --sessions-dir, use "$CODEX_HOME/sessions"
when CODEX_HOME is set, otherwise "$HOME/.codex/sessions".
EOF
}

fail() {
  printf '%s\n' "ERROR: $*" >&2
  exit 1
}

sessions_dir=''
case "$#" in
  1) thread_id=$1 ;;
  3)
    [ "$1" = "--sessions-dir" ] || { usage >&2; exit 2; }
    [ -n "$2" ] || fail "--sessions-dir requires a non-empty directory."
    sessions_dir=$2
    thread_id=$3
    ;;
  *) usage >&2; exit 2 ;;
esac

if ! printf '%s\n' "$thread_id" | LC_ALL=C grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  fail "THREAD_ID must be a lowercase UUID."
fi

if [ -z "$sessions_dir" ]; then
  if [ -n "${CODEX_HOME-}" ]; then
    sessions_dir=$CODEX_HOME/sessions
  else
    [ -n "${HOME-}" ] || fail "HOME is unset and CODEX_HOME was not supplied; pass --sessions-dir explicitly."
    sessions_dir=$HOME/.codex/sessions
  fi
fi
[ -d "$sessions_dir" ] || fail "sessions directory is unavailable."

tmp_base=${TMPDIR:-/tmp}
case "$tmp_base" in /*) ;; *) tmp_base=/tmp ;; esac
matches_file=''

cleanup() {
  if [ -n "$matches_file" ] && [ -f "$matches_file" ]; then
    case "$matches_file" in
      "$tmp_base"/sol-advisor-primary-runtime.*) rm -f "$matches_file" ;;
      *) printf '%s\n' "ERROR: refusing cleanup of unexpected temporary file." >&2 ;;
    esac
  fi
}
trap cleanup 0 HUP INT TERM

matches_file=$(mktemp "$tmp_base/sol-advisor-primary-runtime.XXXXXX") ||
  fail "could not create a temporary match list."
if ! find "$sessions_dir" -type f -name "rollout-*-$thread_id.jsonl" -print > "$matches_file"; then
  fail "could not enumerate rollout filenames under the sessions directory."
fi

match_count=$(awk 'END { print NR + 0 }' "$matches_file")
case "$match_count" in 0) fail "no rollout filename matched the requested thread id." ;; 1) ;; *) fail "multiple rollout filenames matched the requested thread id." ;; esac
IFS= read -r rollout_file < "$matches_file" || fail "could not read the matched rollout filename."
[ -f "$rollout_file" ] || fail "matched rollout is unavailable."

if ! jq -ce -s --arg expected_thread_id "$thread_id" '
  def nonblank_string_or_null:
    if type == "string" and test("\\S") then . else null end;
  [ .[] | select(.type == "session_meta") | .payload ] as $sessions |
  [ .[] | select(.type == "turn_context") | .payload ] as $turns |
  if ($sessions | length) != 1 then
    error("missing or ambiguous session metadata")
  elif ($turns | length) == 0 then
    error("missing turn context")
  elif ($sessions[0] | type) != "object" or any($turns[]; type != "object") then
    error("routing metadata payloads must be objects")
  else
    $sessions[0] as $session |
    ($session.id? | nonblank_string_or_null) as $session_thread_id |
    ($session.model_provider? | nonblank_string_or_null) as $model_provider |
    [ $turns[] | (.model? | nonblank_string_or_null) ] as $models |
    [ $turns[] | (.effort? | nonblank_string_or_null) ] as $efforts |
    [ $turns[] |
      if has("sandbox_policy") and (.sandbox_policy | type) == "object"
         and (.sandbox_policy | has("type"))
      then (.sandbox_policy.type | nonblank_string_or_null)
      else null
      end
    ] as $sandbox_types |
    [ $turns[] |
      if has("permission_profile") and (.permission_profile | type) == "object"
         and (.permission_profile | has("type"))
      then (.permission_profile.type | nonblank_string_or_null)
      else null
      end
    ] as $permission_types |
    [ $turns[] | (.cwd? | nonblank_string_or_null) ] as $cwds |
    if $session_thread_id == null or $session_thread_id != $expected_thread_id then
      error("session metadata does not identify the requested thread")
    elif ([($session | has("parent_thread_id")),
           ($session | has("agent_role")),
           ($session | has("agent_path"))] | unique | length) != 1
         or $session.parent_thread_id? != null
         or $session.agent_role? != null
         or $session.agent_path? != null then
      error("rollout is not a primary session")
    elif $model_provider == null then
      error("missing model provider")
    elif any($models[]; . == null) or any($efforts[]; . == null) then
      error("missing model or effort")
    elif ($models | unique | length) != 1 or ($efforts | unique | length) != 1 then
      error("conflicting model or effort")
    elif any($sandbox_types[]; . == null) or any($permission_types[]; . == null)
         or ($sandbox_types | unique | length) != 1
         or ($permission_types | unique | length) != 1 then
      error("conflicting isolation metadata")
    elif any($cwds[]; . == null) or ($cwds | unique | length) != 1 then
      error("conflicting working directories")
    else
      {
        thread_id: $session_thread_id,
        session_kind: "primary",
        model_provider: $model_provider,
        model: $models[0],
        effort: $efforts[0],
        sandbox_policy_type: $sandbox_types[0],
        permission_profile_type: $permission_types[0],
        cwd: $cwds[0]
      }
    end
  end
' "$rollout_file" 2>/dev/null; then
  fail "rollout is missing, ambiguous, invalid, or inconsistent required primary routing metadata."
fi
