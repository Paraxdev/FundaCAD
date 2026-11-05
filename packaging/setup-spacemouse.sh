#!/bin/sh
# Install the FundaCAD SpaceMouse hidraw udev rule and apply it to the currently
# connected 3Dconnexion device, no replug/reboot needed. Run with sudo:
#   sudo sh packaging/setup-spacemouse.sh
set -e

# The same 046d product ids as 70-spacemouse.rules.
LOGITECH_3DX="C603 C605 C606 C621 C623 C625 C626 C627 C628 C629 C62B C640"

RULE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/70-spacemouse.rules"
[ -f "$RULE" ] || { echo "can't find 70-spacemouse.rules next to $0" >&2; exit 1; }
# The older 99- rule sorted after 73-seat-late, so its uaccess tag never applied.
rm -f /etc/udev/rules.d/99-spacemouse.rules
install -m644 "$RULE" /etc/udev/rules.d/
udevadm control --reload
udevadm trigger --subsystem-match=hidraw

pattern="v0000256F"
for p in $LOGITECH_3DX; do pattern="$pattern|v0000046Dp0000$p"; done

found=0
for ue in /sys/class/hidraw/*/device/uevent; do
  if grep -qiE "$pattern" "$ue" 2>/dev/null; then
    node="/dev/$(basename "$(dirname "$(dirname "$ue")")")"
    echo "rule applies to $node:"
    ls -l "$node"
    command -v getfacl >/dev/null 2>&1 && getfacl -p "$node" 2>/dev/null | grep '^user:' || true
    found=1
  fi
done
[ "$found" = 1 ] || echo "no 3Dconnexion hidraw node found (is it plugged in?)"
