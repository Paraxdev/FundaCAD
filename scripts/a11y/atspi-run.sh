#!/usr/bin/env bash
# Starts the AppImage under Xvfb on its own accessibility bus and walks its
# AT-SPI tree. Run it inside dbus-run-session so the app, the bus launcher and
# the walker share one session bus:
#   dbus-run-session -- bash scripts/a11y/atspi-run.sh <AppImage> <out dir>
set -euo pipefail
img=$1 out=$2
mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd)

fuse=()
if ! { [ -e /dev/fuse ] && { command -v fusermount3 || command -v fusermount; } >/dev/null; }; then
  fuse=(--appimage-extract-and-run)
fi

launcher=$(ls /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher 2>/dev/null | head -1 || true)
if [ -z "$launcher" ]; then echo "::error::no at-spi-bus-launcher, is at-spi2-core installed?"; exit 1; fi
"$launcher" --launch-immediately > "$out/bus.log" 2>&1 &
bus=$!
gui=
trap '{ [ -z "$gui" ] || kill -- -"$gui"; kill "$bus"; } 2>/dev/null || true' EXIT

a11y=(gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus)
for _ in $(seq 20); do "${a11y[@]}" --method org.a11y.Bus.GetAddress > /dev/null 2>&1 && break; sleep 0.5; done
if ! "${a11y[@]}" --method org.a11y.Bus.GetAddress; then
  echo "::error::the accessibility bus never came up"; cat "$out/bus.log" || true; exit 1
fi
# What a desktop sets when a screen reader starts, so toolkits that ask expose their tree.
for prop in IsEnabled ScreenReaderEnabled; do
  "${a11y[@]}" --method org.freedesktop.DBus.Properties.Set org.a11y.Status "$prop" "<true>" > /dev/null || true
done

export NO_AT_BRIDGE=0 GNOME_ACCESSIBILITY=1
export XDG_DATA_HOME="$out/data" WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1
session="$XDG_DATA_HOME/dev.fundacad.app/session.json"
mkdir -p "$XDG_DATA_HOME"
setsid xvfb-run -a "$img" "${fuse[@]}" > "$out/gui.log" 2>&1 &
gui=$!
for _ in $(seq 120); do [ -f "$session" ] && break; sleep 1; done
if [ ! -f "$session" ]; then
  echo "::error::the app wrote no session file in 120 s"; tail -n 50 "$out/gui.log" || true; exit 1
fi
# The web process may sit on the bus as its own application rather than under the window.
python3 "$here/atspi_dump.py" --app fundacad --app WebKitWebProcess --out "$out/atspi.txt" --wait 60
