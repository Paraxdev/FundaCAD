#!/usr/bin/env sh
# Keeps the self hosted runner's warm target dirs (target, src-tauri/target) from filling its disk.
#   toolchain        empties them when rustc or cargo changed since they were built
#   prune <days>     drops units, test binaries and incremental files not used for <days>
#   floor <GB> [n]   frees up to tier n (default 4) until <GB> are free on their disk
# Every step keeps target/OCCT, the kernel build that does not depend on rustc (.cargo/config.toml).
set -eu

ROOTS="target src-tauri/target"

free_gb() {
  where=target
  [ -d "$where" ] || where=.
  df -Pk "$where" | awk 'NR == 2 { print int($4 / 1048576) }'
}

empty() {
  find "$1" -mindepth 1 -maxdepth 1 ! -name OCCT ! -name .toolchain -exec rm -rf {} +
}

prune() {
  mins=$(($1 * 1440))
  for root in $ROOTS; do
    [ -d "$root" ] || continue
    # A cache restore gives target/OCCT its old mtimes, so prune never walks it. (-delete implies -depth,
    # which turns -prune off, hence the loop.)
    for dir in "$root"/*/; do
      case "$dir" in "$root/OCCT/") continue ;; esac
      find "$dir" -path '*/deps/*' -type f -mmin +"$mins" -delete 2>/dev/null || true
      # From cargo 1.100 each unit builds in build/<pkg>/<hash>, its out/ holding build script output that a
      # fresh fingerprint still vouches for, so only a whole unit neither written nor read in that time goes. A
      # fresh unit is never written again, so read times keep a dependency every run links.
      for unit in "$dir"build/*/*/; do
        if [ -d "$unit/fingerprint" ] && [ -z "$(find "$unit" -type f \( -mmin -"$mins" -o -amin -"$mins" \) -print -quit)" ]; then
          rm -rf "$unit"
        fi
      done
      find "$dir" -path '*/incremental/*' -mmin +"$mins" -delete 2>/dev/null || true
    done
  done
}

toolchain() {
  now="$(rustc -vV; cargo -V)"
  for root in $ROOTS; do
    if [ -d "$root" ] && [ "$(cat "$root/.toolchain" 2>/dev/null)" != "$now" ]; then
      echo "$root was built by another toolchain, so it starts over"
      empty "$root"
    fi
    mkdir -p "$root"
    printf '%s\n' "$now" > "$root/.toolchain"
  done
}

tier() {
  case "$1" in
    1) echo "unused for a day" && prune 1 ;;
    2) echo "incremental files" && for root in $ROOTS; do rm -rf "$root"/*/incremental; done ;;
    3) echo "release builds" && for root in $ROOTS; do rm -rf "$root"/release; done ;;
    4) echo "everything but the kernel" && for root in $ROOTS; do if [ -d "$root" ]; then empty "$root"; fi; done ;;
  esac
}

floor() {
  want=$1
  last=${2:-4}
  n=1
  while [ "$(free_gb)" -lt "$want" ] && [ "$n" -le "$last" ]; do
    printf '%sG free, under %sG, dropping ' "$(free_gb)" "$want"
    tier "$n"
    n=$((n + 1))
  done
  if [ "$(free_gb)" -lt "$want" ]; then
    echo "::warning::Only $(free_gb)G free on the warm target dir's disk after freeing what it can, under the ${want}G floor"
    du -sh $ROOTS 2>/dev/null || true
  fi
  df -h "$(pwd)" | tail -n 1
}

case "${1:-}" in
  toolchain) toolchain ;;
  prune) prune "${2:?days}" && df -h "$(pwd)" | tail -n 1 ;;
  floor) floor "${2:?GB}" "${3:-4}" ;;
  *) echo "usage: $0 toolchain | prune <days> | floor <GB> [tier]" >&2 && exit 2 ;;
esac
