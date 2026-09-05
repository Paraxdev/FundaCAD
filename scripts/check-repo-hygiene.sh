#!/bin/sh
# Repo hygiene: fail if files that belong to a developer's machine or to an AI
# agent's session have been committed. This is a PUBLIC repo, so "it's only
# clutter" still means publishing a username, a home-directory layout, or tooling
# config that has nothing to do with FundaCAD.
#
# .gitignore alone is not enough: it only stops NEW untracked matches, and says
# nothing about a path that is already tracked (which is how .claude/settings.json
# got in) or one added with `git add -f`. This checks what git ACTUALLY tracks.
#
# Runs in CI and locally:  sh scripts/check-repo-hygiene.sh
set -eu

fail=0
note() { printf '  %s\n' "$1"; fail=1; }

# --- paths that must never be tracked ---------------------------------------
# Agent/session artifacts and editor state. Add to this list rather than relying
# on people noticing in review.
forbidden='
.claude/
.fable/
.cursor/
.emergent/
.aider*
handoff.md
CLAUDE.md
AGENTS.md
memory/
.vscode/
.idea/
.DS_Store
evals/
norn/
test_reports/
'

echo "checking tracked paths…"
for pat in $forbidden; do
  hits=$(git ls-files -- "$pat" "**/$pat" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    note "tracked but should not be ($pat):"
    printf '%s\n' "$hits" | sed 's/^/    /'
  fi
done

# --- CAD models: the developer's own parts must never be published ------------
# A document/.3mf/.stl/.step is a real part — geometry, dimensions, sometimes a
# customer's job. .gitignore covers new files in the paths it names, but says
# nothing about `git add -f` or a model that predates the rule, which is exactly
# why this checks what git ACTUALLY tracks.
#
# Allowed: the synthetic bench fixture the perf harness needs, the generated
# assembly-tree fixtures (boxes emitted by tools/gen_asm_fixtures.py — no real
# geometry, reproducible from source), and third_party sample models that ship
# with vendored code. Add to this list only for files that are genuinely
# synthetic or already public.
echo "checking for tracked CAD models…"
models=$(git ls-files -- '*.funda' '*.neocad' '*.sindri' '*.3mf' '*.stl' '*.step' '*.stp' 2>/dev/null \
  | grep -vE '^(sidecar/tools/bench/textured_box\.funda$|sidecar/fixtures/asm_[a-z_]+\.step$|third_party/)' || true)
if [ -n "$models" ]; then
  note "tracked CAD model — is this a real part in a public repo?:"
  printf '%s\n' "$models" | sed 's/^/    /'
fi

# --- developer-machine paths inside tracked files ----------------------------
# A hardcoded /home/<user>/... is either a privacy leak or a script that only
# works on one machine — packaging/setup-spacemouse.sh was both.
#
# Allowed: synthetic users in test fixtures (the path-redaction tests need a
# realistic-looking path to redact). Anything else must be made relative.
echo "checking for hardcoded home directories…"
homes=$(git grep -InE '/(home|Users)/[a-z][a-z0-9_-]+/' -- . \
  ':(exclude)third_party/**' ':(exclude)package-lock.json' 2>/dev/null \
  | grep -vE '/(home|Users)/(alice|bob|user|username|youruser|me|test)/' || true)
if [ -n "$homes" ]; then
  note "hardcoded developer home directory:"
  printf '%s\n' "$homes" | cut -c1-160 | sed 's/^/    /'
fi

# --- former product names -----------------------------------------------------
# Product NAMES only, not the lowercase identifiers. Several of those are kept on
# purpose and are not drift: the `.sindri` and `.neocad` extensions are still
# opened (src/io/documentExt.ts), the pre-rename localStorage keys are still read
# (src/ui/storedSetting.ts), the retired `SINDRI_*` / `SINDRICAD_*` environment
# variables still answer alongside the `FUNDACAD_*` ones (sidecar/appenv.py,
# src-tauri/src/webkit.rs), and an existing on-disk cache directory under the old
# name is kept rather than orphaned (appenv.dir_under). Those are compatibility
# with things outside this repository — a user's shell profile, their saved
# settings, their cache — not leftovers.
#
# `Neocad` joins the list with the second rename. It is a real brand held by
# someone else, which is why the app is not called it any more, so a stray one
# in a shipped string or a doc is the thing this check exists to catch.
#
# This script is excluded from its own scan: it necessarily contains the strings
# it looks for. CHANGELOG.md is excluded because it is inherited release history,
# and those entries describe builds that really were called that. README.md is
# excluded because it names the upstream project as attribution.
echo "checking for former product names…"
old=$(git grep -In -e 'Verxa' -e 'SindriCAD' -e 'Neocad' -- . \
  ':(exclude)third_party/**' ':(exclude)scripts/check-repo-hygiene.sh' \
  ':(exclude)CHANGELOG.md' ':(exclude)README.md' 2>/dev/null || true)
if [ -n "$old" ]; then
  note "a former product name is still present:"
  printf '%s\n' "$old" | sed 's/^/    /'
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Repo hygiene FAILED. Untrack with:  git rm --cached <path>"
  echo "and add it to .gitignore. If a path is legitimate, allow it in this script."
  exit 1
fi
echo "repo hygiene OK"
