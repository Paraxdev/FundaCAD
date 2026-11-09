#!/bin/sh
# Starts a command in cage on a headless wlroots output with no X server and checks
# that it maps a native Wayland window and stays up with no GDK, WebKit or protocol errors.
#   wayland-smoke.sh <log dir> <command...>     SMOKE_SECONDS (default 20) is the wait
# FundaCAD moves its stdout and stderr into its own log once it starts, so the protocol
# lines after that land there. SMOKE_APP_LOG names that file, and the checks read what
# this run added to it beside the command's output.
set -eu
out=$1; shift
secs=${SMOKE_SECONDS:-20}
applog=${SMOKE_APP_LOG:-}
mkdir -p "$out"
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR=$(mktemp -d); export XDG_RUNTIME_DIR
fi
size() { wc -c < "$1" | tr -d ' '; }
from=0
if [ -n "$applog" ] && [ -f "$applog" ]; then from=$(size "$applog"); fi
app=
trap '[ -z "$app" ] || kill -- -"$app" 2>/dev/null || true' EXIT

# Headless Weston offers no seat, which GTK 3 answers with criticals; wlroots always has one.
# cage hands the app its own WAYLAND_DISPLAY and exits with it. setsid lets the trap end the group.
env -u DISPLAY -u WAYLAND_DISPLAY WLR_BACKENDS=headless WLR_RENDERER=pixman WAYLAND_DEBUG=client \
  setsid cage -- "$@" > "$out/app.log" 2>&1 &
app=$!
sleep "$secs"

fail=0
err() { echo "::error::$1"; fail=1; }
log=$out/app.log
if [ -n "$applog" ]; then
  if [ -f "$applog" ]; then
    # The app starts a fresh log once the old one is full.
    [ "$(size "$applog")" -ge "$from" ] || from=0
    tail -c +"$((from + 1))" "$applog" > "$out/fundacad.log"
  else
    echo "no app log at $applog, checking the command's output alone"
    : > "$out/fundacad.log"
  fi
  log=$out/all.log
  cat "$out/app.log" "$out/fundacad.log" > "$log"
fi
kill -0 "$app" 2>/dev/null || err "the app exited within $secs s"
# libwayland logs objects as name@id before 1.22 and name#id since.
grep -Eq 'xdg_surface[@#][0-9]+\.get_toplevel\(' "$log" || err "the app created no xdg_toplevel"
grep -Eq 'wl_surface[@#][0-9]+\.attach\(wl_buffer[@#][0-9]+' "$log" || err "the app attached no buffer to a surface"
bad='(Gdk|WebKit[A-Za-z]*)-(ERROR|CRITICAL|WARNING)|dispatching to Wayland display|wl_display[@#]1\.error\('
if grep -Eq "$bad" "$log"; then
  err "GDK, WebKit or Wayland errors in the output:"; grep -E "$bad" "$log" | head -n 20
fi
grep -Ev '^\[ *[0-9.]+\] ' "$log" | tail -n 30 || true
[ "$fail" = 0 ] && echo "Wayland smoke passed: the window mapped and the app ran $secs s"
exit "$fail"
