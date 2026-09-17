#!/usr/bin/env bash
# Runs the sidecar's and the plugins' test scripts from sidecar/, JOBS at a time.
# Files that bind the sidecar's websocket port run one at a time afterwards, or
# two of them would fight over 8765. Each file's output is printed whole in its
# own group, in file order, once everything has finished.
#
#   SKIP="a.py b.py" JOBS=4 scripts/run-sidecar-tests.sh [test files...]
#
# With no files named, every test the globs below find runs: a new test is
# covered the moment it exists, and SKIP is the only way out.
set -uo pipefail
cd "$(dirname "$0")/../sidecar"
JOBS=${JOBS:-4}
SKIP=${SKIP:-}

if [ $# -eq 0 ]; then
  set -- tests/test_*.py ../plugins/*/tests/test_*.py ../plugins/*/geometry/tests/test_*.py
fi

parallel=()
serial=()
for t in "$@"; do
  [ -e "$t" ] || continue   # a glob that matched nothing stays literal
  case " $SKIP " in *" $(basename "$t") "*) echo "skip $t"; continue;; esac
  if grep -qE '\bPORT\b|websockets\.serve' "$t"; then serial+=("$t"); else parallel+=("$t"); fi
done

out=$(mktemp -d)
run() {
  local log="$2/$(printf '%s' "$1" | tr '/.' '__').log" start=$SECONDS st=ok
  uv run --no-sync python "$1" > "$log" 2>&1 || st=FAIL
  echo "$st $((SECONDS - start)) $1" >> "$2/results"
}
export -f run

echo "${#parallel[@]} files $JOBS at a time, then ${#serial[@]} that bind the port one at a time"
if [ ${#parallel[@]} -gt 0 ]; then
  printf '%s\0' "${parallel[@]}" | xargs -0 -P "$JOBS" -I{} bash -c 'run "$1" "$2"' _ {} "$out"
fi
for t in "${serial[@]}"; do run "$t" "$out"; done

fail=0
failed=()
while read -r st secs t; do
  echo "::group::$st ${secs}s $t"
  cat "$out/$(printf '%s' "$t" | tr '/.' '__').log"
  echo "::endgroup::"
  if [ "$st" != ok ]; then fail=1; failed+=("$t"); fi
done < <(sort -k3 "$out/results")

if [ $fail -ne 0 ]; then
  printf 'FAILED: %s\n' "${failed[@]}"
fi
exit $fail
