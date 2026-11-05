#!/bin/sh
# Starts a command in cage on a headless wlroots output with no X server and checks
# that it maps a native Wayland window and stays up with no GDK, WebKit or protocol errors.
#   wayland-smoke.sh <log dir> <command...>     SMOKE_SECONDS (default 20) is the wait
set -eu
out=$1; shift
secs=${SMOKE_SECONDS:-20}
mkdir -p "$out"
if [ -z "${XDG_RUNTIME_DIR:-}" ]; then
  XDG_RUNTIME_DIR=$(mktemp -d); export XDG_RUNTIME_DIR
fi
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
kill -0 "$app" 2>/dev/null || err "the app exited within $secs s"
# libwayland logs objects as name@id before 1.22 and name#id since.
grep -Eq 'xdg_surface[@#][0-9]+\.get_toplevel\(' "$out/app.log" || err "the app created no xdg_toplevel"
grep -Eq 'wl_surface[@#][0-9]+\.attach\(wl_buffer[@#][0-9]+' "$out/app.log" || err "the app attached no buffer to a surface"
bad='(Gdk|WebKit[A-Za-z]*)-(ERROR|CRITICAL|WARNING)|dispatching to Wayland display|wl_display[@#]1\.error\('
if grep -Eq "$bad" "$out/app.log"; then
  err "GDK, WebKit or Wayland errors in the output:"; grep -E "$bad" "$out/app.log" | head -n 20
fi
grep -Ev '^\[ *[0-9.]+\] ' "$out/app.log" | tail -n 30 || true
[ "$fail" = 0 ] && echo "Wayland smoke passed: the window mapped and the app ran $secs s"
exit "$fail"
