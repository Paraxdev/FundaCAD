#!/bin/sh
# Starts a command in cage on a headless wlroots output with no X server and checks
# that it maps a native Wayland window, paints its page and stays up with no GTK, GDK,
# WebKit or protocol errors.
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
bus=
trap '[ -z "$app" ] || kill -- -"$app" 2>/dev/null || true; [ -z "$bus" ] || kill "$bus" 2>/dev/null || true' EXIT

# The app starts itself again when its first paint stalls, and dbus-run-session would end
# the bus with the first process, so the bus lives as long as this script, as a desktop's does.
busdir=$(mktemp -d)
bus=$(dbus-daemon --session --address="unix:path=$busdir/bus" --fork --print-pid)
DBUS_SESSION_BUS_ADDRESS="unix:path=$busdir/bus"; export DBUS_SESSION_BUS_ADDRESS

# Headless Weston offers no seat, which GTK 3 answers with criticals; wlroots always has one.
# cage hands the app its own WAYLAND_DISPLAY and exits with it. setsid lets the trap end the group.
# Portals the bus starts need that display too.
env -u DISPLAY -u WAYLAND_DISPLAY WLR_BACKENDS=headless WLR_RENDERER=pixman WAYLAND_DEBUG=client \
  setsid cage -- sh -c 'dbus-update-activation-environment WAYLAND_DISPLAY; exec "$@"' sh "$@" \
  > "$out/app.log" 2>&1 &
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

# A restart writes to the same log, so what follows its line is the restarted app.
restart='never painted, starting again with the WebKitGTK DMABUF renderer off'
painted='[frontend] the interface painted its first frame'
check=$log
restarted=
if grep -Fq "$restart" "$log"; then
  restarted=", restart path taken"
  echo "restart path taken: the first page never painted, so the app started again with the WebKitGTK DMABUF renderer off"
  check=$out/restarted.log
  awk -v line="$restart" 'seen { print } index($0, line) { seen = 1 }' "$log" > "$check"
  what="the restarted app"
else
  what="the app"
fi
# libwayland logs objects as name@id before 1.22 and name#id since.
grep -Eq 'xdg_surface[@#][0-9]+\.get_toplevel\(' "$check" || err "$what created no xdg_toplevel"
grep -Eq 'wl_surface[@#][0-9]+\.attach\(wl_buffer[@#][0-9]+' "$check" || err "$what attached no buffer to a surface"
grep -Fq "$painted" "$check" || err "$what never painted its page"
bad='(Gdk|WebKit[A-Za-z]*)-(ERROR|CRITICAL|WARNING)|Gtk-(ERROR|CRITICAL)|Gtk:ERROR|Bail out!|dispatching to Wayland display|wl_display[@#]1\.error\('
if grep -Eq "$bad" "$log"; then
  err "GTK, GDK, WebKit or Wayland errors in the output:"; grep -E "$bad" "$log" | head -n 20
fi
grep -Ev '^\[ *[0-9.]+\] ' "$log" | tail -n 30 || true
[ "$fail" = 0 ] && echo "Wayland smoke passed: the window mapped, the page painted and the app ran $secs s$restarted"
exit "$fail"
