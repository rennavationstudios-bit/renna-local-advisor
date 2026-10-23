#!/bin/sh
# Install Sol Advisor's shipped custom-agent templates without changing Codex config.

set -eu

usage() {
  cat <<'EOF'
Usage: install-agents.sh [--target-dir PATH] [--check] [--check-role ROLE ...]

Install Sol Advisor's four current custom-agent templates into the target directory.
Normal mode also migrates only exact byte-matching historical templates where the
role remains the same. It never overwrites a modified, nonregular, or symlinked
destination.

Without --target-dir, the target is "$CODEX_HOME/agents" when CODEX_HOME is already
set, otherwise "$HOME/.codex/agents".

Options:
  --target-dir PATH  Explicit destination directory (absolute or relative).
  --check            Verify that Luna, Terra, Sol, and UltraBurn match exactly; do not create,
                     replace, or remove anything.
  --check-role ROLE  Verify only ROLE (luna, terra, sol, or ultraburn); repeatable and implies
                     --check. Unknown or missing roles fail without mutation.
  --help             Show this help text.
EOF
}

fail() {
  printf '%s\n' "ERROR: $*" >&2
  exit 1
}

report_preflight_error() {
  printf '%s\n' "ERROR: $*" >&2
  preflight_failed=1
}

role_selected() {
  role=$1
  if [ -z "$check_roles" ]; then
    return 0
  fi
  case ",$check_roles," in
    *,"$role",*) return 0 ;;
    *) return 1 ;;
  esac
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

sha256_file() {
  shasum -a 256 "$1" 2>/dev/null | awk 'NF >= 1 && length($1) == 64 { print $1; exit }'
}

# Exact GPT-5.6 templates shipped in the local 0.7.0+renna.1 release.
# Accept both LF and CRLF copies; customized files still fail closed.
is_gpt56_template() {
  case "$(basename "$1"):$2" in
    sol-advisor-luna-implementer.toml:12fa9180a292876e6731bc325779123bcd931c3caa902fbf90d676a31833be84|sol-advisor-luna-implementer.toml:000ff8bed7f94f77a460fb81424d51233eb6146db5b21a346068aceb6a9abe27) return 0 ;;
    sol-advisor-sol-reviewer.toml:0333acf0ef562bcfebd06009ac09bd1dd8cbc04c4cf28e08e9e049bd8bf202d2|sol-advisor-sol-reviewer.toml:6ac63677bcc8677a9a743522cf06696c8edb1b005a61430e0fc8fa62e18dc355) return 0 ;;
    sol-advisor-ultraburn-reviewer.toml:c5bc0eb66e9ac84ccf1a8b6a75a25fc1b12a9bb37ef4f3807edb5c1a9f4b7b1e|sol-advisor-ultraburn-reviewer.toml:aca06ea4e2198da62a18c4332beed2638d1bf7c20c0fb00c554db324d346c81e) return 0 ;;
    *) return 1 ;;
  esac
}

# Exact GPT-6 Sol templates shipped in local 0.8.0+renna.1, LF and CRLF.
# Only these role-bound historical bytes authorize migration to GPT-6.1 Sol.
is_gpt6_template() {
  case "$(basename "$1"):$2" in
    sol-advisor-sol-reviewer.toml:18cb3a5c08eb3f103f07626c944b9ba8978b20c5a706cf4579e07a5fded18e0a|sol-advisor-sol-reviewer.toml:4238b91b1e1dde1d93282a0bb4586361e8c3f0690c48397f98df04eccf42b384) return 0 ;;
    sol-advisor-ultraburn-reviewer.toml:d64f7bc25e379650a6945e32debebeed52c291bb9fae6a191bf786672f25e535|sol-advisor-ultraburn-reviewer.toml:1ea8ef0674e6fb0d458686b30112969c044644e815355acb7ea09d9e2280d0d0) return 0 ;;
    *) return 1 ;;
  esac
}

classify_current_or_legacy() {
  destination=$1
  template=$2
  legacy_digest=$3
  legacy_digest_alt=${4-}

  if ! path_exists "$destination"; then
    printf '%s\n' missing
  elif [ -L "$destination" ] || [ ! -f "$destination" ]; then
    printf '%s\n' unsafe
  elif cmp -s "$template" "$destination"; then
    printf '%s\n' current
  else
    digest=$(sha256_file "$destination")
    if [ -n "$digest" ] && {
      [ "$digest" = "$legacy_digest" ] || [ "$digest" = "$legacy_digest_alt" ]
    }; then
      printf '%s\n' legacy
    elif is_gpt56_template "$destination" "$digest" || is_gpt6_template "$destination" "$digest"; then
      printf '%s\n' legacy
    elif [ -z "$digest" ]; then
      printf '%s\n' unreadable
    else
      printf '%s\n' conflict
    fi
  fi
}

same_state() {
  label=$1
  expected=$2
  actual=$3
  [ "$expected" = "$actual" ] || fail "$label changed after preflight; no further destination files were changed."
}

install_missing() {
  template=$1
  destination=$2
  staged=''

  if path_exists "$destination"; then
    fail "destination changed after preflight and will not be overwritten: $destination"
  fi

  staged=$(mktemp "$target_dir/.sol-advisor-agent.XXXXXX") || fail "could not stage template for installation: $destination"
  if ! cp "$template" "$staged"; then
    rm -f "$staged"
    fail "could not stage template for installation: $destination"
  fi

  if ! ln "$staged" "$destination"; then
    rm -f "$staged"
    fail "destination changed after preflight and will not be overwritten: $destination"
  fi

  rm -f "$staged" || fail "could not remove staged template after installation: $staged"
  printf '%s\n' "INSTALLED: $destination"
}

replace_legacy_role() {
  label=$1
  template=$2
  destination=$3
  legacy_digest=$4
  legacy_digest_alt=${5-}
  staged=''

  [ "$(classify_current_or_legacy "$destination" "$template" "$legacy_digest" "$legacy_digest_alt")" = legacy ] ||
    fail "legacy $label destination changed after preflight and will not be replaced: $destination"

  staged=$(mktemp "$target_dir/.sol-advisor-agent.XXXXXX") || fail "could not stage migrated $label template: $destination"
  if ! cp "$template" "$staged"; then
    rm -f "$staged"
    fail "could not stage migrated $label template: $destination"
  fi

  [ "$(classify_current_or_legacy "$destination" "$template" "$legacy_digest" "$legacy_digest_alt")" = legacy ] || {
    rm -f "$staged"
    fail "legacy $label destination changed after preflight and will not be replaced: $destination"
  }

  if ! mv -f "$staged" "$destination"; then
    rm -f "$staged"
    fail "could not replace exact legacy $label template: $destination"
  fi

  printf '%s\n' "MIGRATED: $destination"
}

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd) || exit 1
template_dir=$script_dir/../agents

normalize_target_dir() {
  case "$target_dir" in
    [A-Za-z]:[\\/]* )
      case "$(uname -s 2>/dev/null || true)" in
        MSYS*|MINGW*|CYGWIN*) ;;
        *) fail "Windows drive paths require an MSYS, MINGW, or Cygwin shell; pass a POSIX target path." ;;
      esac
      command -v cygpath >/dev/null 2>&1 || fail "Windows drive path normalization requires cygpath."
      target_dir=$(cygpath -u "$target_dir") || fail "could not normalize Windows drive path: $target_dir"
      case "$target_dir" in
        /*) ;;
        *) fail "normalized Windows drive path is not absolute: $target_dir" ;;
      esac
      ;;
    [A-Za-z]:*) fail "Windows drive path must be absolute: $target_dir" ;;
  esac
}

if [ -n "${CODEX_HOME-}" ]; then
  target_dir=$CODEX_HOME/agents
else
  [ -n "${HOME-}" ] || fail "HOME is unset and CODEX_HOME was not supplied; pass --target-dir explicitly."
  target_dir=$HOME/.codex/agents
fi

check_only=0
check_roles=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir)
      [ "$#" -ge 2 ] || fail "--target-dir requires a path."
      [ -n "$2" ] || fail "--target-dir requires a non-empty path."
      case "$2" in
        --*) fail "--target-dir path must be explicit; prefix an option-like relative name with ./ or use an absolute path." ;;
      esac
      target_dir=$2
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    --check-role)
      [ "$#" -ge 2 ] || fail "--check-role requires a role: luna, terra, sol, or ultraburn."
      case "$2" in
        luna|terra|sol|ultraburn) ;;
        *) fail "unknown --check-role '$2'; expected luna, terra, sol, or ultraburn." ;;
      esac
      check_only=1
      check_roles=$check_roles$2,
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1 (run with --help for usage)."
      ;;
  esac
done

normalize_target_dir

case "$target_dir" in
  /*) ;;
  *) target_dir=$(pwd -P)/$target_dir ;;
esac

case "$target_dir" in
  /|//) fail "refusing to use the filesystem root as an agent target directory." ;;
esac

terra_file=sol-advisor-terra-implementer.toml
luna_file=sol-advisor-luna-implementer.toml
sol_file=sol-advisor-sol-reviewer.toml
ultraburn_file=sol-advisor-ultraburn-reviewer.toml
terra_template=$template_dir/$terra_file
luna_template=$template_dir/$luna_file
sol_template=$template_dir/$sol_file
ultraburn_template=$template_dir/$ultraburn_file
terra_destination=$target_dir/$terra_file
luna_destination=$target_dir/$luna_file
sol_destination=$target_dir/$sol_file
ultraburn_destination=$target_dir/$ultraburn_file

# Immutable historical byte digests, calculated from the shipped v0.2.0 role files:
# git show bbc3dc1:plugins/sol-advisor/agents/sol-advisor-luna-implementer.toml | shasum -a 256
# git show bbc3dc1:plugins/sol-advisor/agents/sol-advisor-terra-implementer.toml | shasum -a 256
legacy_luna_sha256=fba1b42849d93737e83b094a2ab0b1611f87ac37db7438c8bbdf581f0813f8eb
legacy_terra_sha256=4425a8c1f21ce8c6af93f96adc253bbc33ea301f1389b3fa8ce350be08584eca
# Immutable v0.5.0 role digests, calculated from the shipped base profiles.
legacy_luna_v050_sha256=5cfaf77f14757074ca5d3cfecd0b8204c91dc14eff8d6119985c64416ddf4853
legacy_terra_v050_sha256=dc329fe87f6f6610c13157ec16432f91c79cf5a541ee3e7448f6afb165dd18ce

for template in "$luna_template" "$terra_template" "$sol_template" "$ultraburn_template"; do
  [ -f "$template" ] && [ ! -L "$template" ] ||
    fail "shipped template is missing or not a regular file: $template"
done

preflight_failed=0
if path_exists "$target_dir"; then
  if [ -L "$target_dir" ] || [ ! -d "$target_dir" ]; then
    report_preflight_error "target directory is not a real directory: $target_dir"
  fi
fi

luna_state=$(classify_current_or_legacy "$luna_destination" "$luna_template" "$legacy_luna_sha256" "$legacy_luna_v050_sha256")
terra_state=$(classify_current_or_legacy "$terra_destination" "$terra_template" "$legacy_terra_sha256" "$legacy_terra_v050_sha256")
sol_state=$(classify_current_or_legacy "$sol_destination" "$sol_template" '' '')
ultraburn_state=$(classify_current_or_legacy "$ultraburn_destination" "$ultraburn_template" '' '')

if [ "$check_only" -eq 1 ]; then
  if role_selected luna; then
    [ "$luna_state" = current ] ||
      report_preflight_error "Luna template is $luna_state, not the current exact file: $luna_destination"
  fi
  if role_selected terra; then
    [ "$terra_state" = current ] ||
      report_preflight_error "Terra template is $terra_state, not the current exact file: $terra_destination"
  fi
  if role_selected sol; then
    [ "$sol_state" = current ] ||
      report_preflight_error "Sol template is $sol_state, not the current exact file: $sol_destination"
  fi
  if role_selected ultraburn; then
    [ "$ultraburn_state" = current ] ||
      report_preflight_error "UltraBurn template is $ultraburn_state, not the current exact file: $ultraburn_destination"
  fi
else
  case "$luna_state" in
    current|legacy|missing) ;;
    *) report_preflight_error "Luna destination is $luna_state and will not be replaced: $luna_destination" ;;
  esac
  case "$terra_state" in
    current|legacy|missing) ;;
    *) report_preflight_error "Terra destination is $terra_state and will not be replaced: $terra_destination" ;;
  esac
  case "$sol_state" in
    current|legacy|missing) ;;
    *) report_preflight_error "Sol destination is $sol_state and will not be replaced: $sol_destination" ;;
  esac
  case "$ultraburn_state" in
    current|legacy|missing) ;;
    *) report_preflight_error "UltraBurn destination is $ultraburn_state and will not be replaced: $ultraburn_destination" ;;
  esac
fi

[ "$preflight_failed" -eq 0 ] || exit 1

if [ "$check_only" -eq 1 ]; then
  if [ -n "$check_roles" ]; then
    printf '%s\n' "CHECK PASSED: selected role templates exactly match $template_dir."
  else
    printf '%s\n' "CHECK PASSED: Luna, Terra, Sol, and UltraBurn exactly match $template_dir."
  fi
  exit 0
fi

if [ ! -d "$target_dir" ]; then
  mkdir -p "$target_dir" || fail "could not create target directory: $target_dir"
fi
[ -d "$target_dir" ] && [ ! -L "$target_dir" ] ||
  fail "target directory changed after preflight: $target_dir"

same_state Luna "$luna_state" "$(classify_current_or_legacy "$luna_destination" "$luna_template" "$legacy_luna_sha256" "$legacy_luna_v050_sha256")"
same_state Terra "$terra_state" "$(classify_current_or_legacy "$terra_destination" "$terra_template" "$legacy_terra_sha256" "$legacy_terra_v050_sha256")"
same_state Sol "$sol_state" "$(classify_current_or_legacy "$sol_destination" "$sol_template" '' '')"
same_state UltraBurn "$ultraburn_state" "$(classify_current_or_legacy "$ultraburn_destination" "$ultraburn_template" '' '')"

case "$luna_state" in
  missing) install_missing "$luna_template" "$luna_destination" ;;
  legacy) replace_legacy_role Luna "$luna_template" "$luna_destination" "$legacy_luna_sha256" "$legacy_luna_v050_sha256" ;;
  current) printf '%s\n' "ALREADY CURRENT: $luna_destination" ;;
esac

case "$terra_state" in
  missing) install_missing "$terra_template" "$terra_destination" ;;
  legacy) replace_legacy_role Terra "$terra_template" "$terra_destination" "$legacy_terra_sha256" "$legacy_terra_v050_sha256" ;;
  current) printf '%s\n' "ALREADY CURRENT: $terra_destination" ;;
esac

case "$sol_state" in
  missing) install_missing "$sol_template" "$sol_destination" ;;
  legacy) replace_legacy_role Sol "$sol_template" "$sol_destination" '' '' ;;
  current) printf '%s\n' "ALREADY CURRENT: $sol_destination" ;;
esac

case "$ultraburn_state" in
  missing) install_missing "$ultraburn_template" "$ultraburn_destination" ;;
  legacy) replace_legacy_role UltraBurn "$ultraburn_template" "$ultraburn_destination" '' '' ;;
  current) printf '%s\n' "ALREADY CURRENT: $ultraburn_destination" ;;
esac

[ "$(classify_current_or_legacy "$luna_destination" "$luna_template" "$legacy_luna_sha256" "$legacy_luna_v050_sha256")" = current ] ||
  fail "post-install exactness check failed: $luna_destination"
[ "$(classify_current_or_legacy "$terra_destination" "$terra_template" "$legacy_terra_sha256" "$legacy_terra_v050_sha256")" = current ] ||
  fail "post-install exactness check failed: $terra_destination"
[ "$(classify_current_or_legacy "$sol_destination" "$sol_template" '' '')" = current ] ||
  fail "post-install exactness check failed: $sol_destination"
[ "$(classify_current_or_legacy "$ultraburn_destination" "$ultraburn_template" '' '')" = current ] ||
  fail "post-install exactness check failed: $ultraburn_destination"

printf '%s\n' "INSTALL PASSED: Luna, Terra, Sol, and UltraBurn exactly match $template_dir."
