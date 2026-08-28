#!/usr/bin/env bash
# Build a self-contained, RELOCATABLE Python runtime for the Neocad geometry
# sidecar, for bundling into the app (Tauri bundle.resources). Used by local bundle
# builds and CI. Bash covers Linux + macOS; the CI Windows leg runs the equivalent uv
# commands in PowerShell.
#
# Output layout (default: src-tauri/sidecar-runtime/):
#   sidecar-runtime/
#     python/              a python-build-standalone interpreter, copied in whole
#                          (relocatable by design) with the locked deps installed
#     app/                 the sidecar *.py sources (server.py, builder.py, ...)
# Launch:  <runtime>/python/bin/python3.12 <runtime>/app/server.py   (cwd=<runtime>/app)
#
# Two things this gets right that a naive `uv pip install build123d` does not:
#   1. LOCKED versions. The sidecar is a uv project (sidecar/pyproject.toml + uv.lock);
#      the code is written against those exact pins (build123d 0.10.0, cadquery-ocp
#      7.8.1.1.post1, ...). Installing latest breaks it. We install the exported lock.
#   2. COPIED interpreter, not a symlink to uv's managed python, so the tree ships.
#
# VTK is removed (novtk): the sidecar's used surface never imports it (proven by the
# smoke suite with vtk blocked), and it is ~341 MB.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$REPO/src-tauri/sidecar-runtime}"
PYVER="3.12"
SIDE="$REPO/sidecar"

echo "[runtime] building into $OUT (python $PYVER, novtk, locked)"
rm -rf "$OUT"; mkdir -p "$OUT"

# 1. python-build-standalone interpreter, copied in whole (relocatable by design).
#    Kept pristine: packages go in a sibling site-packages/ loaded via PYTHONPATH, so
#    we never modify the interpreter (uv marks its managed pythons externally-managed).
uv python install "$PYVER"
PYBIN="$(uv python find "$PYVER")"
PYROOT="$(cd "$(dirname "$PYBIN")/.." && pwd)"   # standalone root (parent of bin/)
cp -a "$PYROOT/." "$OUT/python/"
PY="$OUT/python/bin/python3.12"

# 2. install the EXACT locked deps (matches the tested dev venv) into a plain target
#    dir. build123d 0.10.0 / cadquery-ocp 7.8.1.1.post1 / numpy / scipy / websockets.
uv export --project "$SIDE" --frozen --no-dev --no-emit-project \
  --format requirements-txt -o "$OUT/requirements.txt"
uv pip install --python "$PY" --target "$OUT/site-packages" -r "$OUT/requirements.txt"

# 3. drop VTK (novtk): unused by the sidecar, ~341 MB. --target installs have no uv
#    uninstall, so remove the package files directly.
rm -rf "$OUT"/site-packages/vtkmodules "$OUT"/site-packages/vtk.py \
  "$OUT"/site-packages/vtk-*.dist-info 2>/dev/null || true

# 3b. jedi's editor stub tree. jedi is in the lock because build123d imports
#     ipython, and nothing in a headless sidecar ever completes an identifier, so
#     third_party/ — typeshed stubs for django, tensorflow, braintree and the
#     rest — is data no import ever reads. It is also why the Windows portable
#     zip trips the 260-character path limit: it holds 5536 of the payload's
#     files and every one of the longest paths. Dropping it takes the longest
#     internal path from 153 characters to 130, and the whole sidecar suite runs
#     against the pruned bundle unchanged.
rm -rf "$OUT"/site-packages/jedi/third_party 2>/dev/null || true

# 4. sidecar sources + precompile (read-only bundle: no .pyc writes at import time).
#    Non-recursive, so sidecar/tests/ never ships. A denylist, not an allowlist —
#    a new sidecar module must ship by default, or the app breaks in the packaged
#    build only, which is the worst place to find out.
mkdir -p "$OUT/app"
for _src in "$SIDE"/*.py; do
  case "${_src##*/}" in
    spike_*.py) continue ;;
  esac
  cp "$_src" "$OUT/app/"
done
PYTHONPATH="$OUT/site-packages" "$PY" -m compileall -q "$OUT/app" "$OUT/site-packages" || true

echo "[runtime] done: $OUT ($(du -sh "$OUT" 2>/dev/null | cut -f1))"
echo "[runtime] launch: PYTHONPATH=$OUT/site-packages $PY $OUT/app/server.py (cwd=$OUT/app)"
