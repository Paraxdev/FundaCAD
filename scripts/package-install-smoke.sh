#!/bin/sh
# Runs inside a clean distro container (job deb-install in build.yml), where
# only the package manager and what the package itself pulls in exist.
#   package-install-smoke.sh deb <dir with FundaCAD_*.deb>
#   package-install-smoke.sh appimage <dir with the .AppImage>
set -eu
kind=$1 pkg=$2
here=$(cd "$(dirname "$0")" && pwd)
smoke() { python3 "$here/bundle-smoke.py" --work /tmp/smoke -- "$@"; }

case "$kind" in
deb)
  export DEBIAN_FRONTEND=noninteractive
  apt-get -o Acquire::Retries=3 update -qq
  # An unresolvable Depends fails here.
  apt-get install -y -qq "$pkg"/FundaCAD_*.deb python3
  smoke /usr/bin/fundacad --mcp
  ;;
appimage)
  dnf install -y -q python3
  img=$(ls "$pkg"/*.AppImage)
  chmod +x "$img"
  export APPIMAGE_EXTRACT_AND_RUN=1
  # Without WebKitGTK the AppRun check has to name it, not die in the loader.
  if timeout 60 "$img" --mcp </dev/null >/dev/null 2>/tmp/bare.err; then
    echo "::error::the AppImage started without WebKitGTK installed"; exit 1
  fi
  if grep -q 'error while loading shared libraries' /tmp/bare.err \
    || ! grep -q 'needs WebKitGTK 4.1' /tmp/bare.err; then
    echo "::error::no deps check message, only:"; cat /tmp/bare.err; exit 1
  fi
  dnf install -y -q webkit2gtk4.1
  smoke "$img" --mcp
  ;;
*)
  echo "unknown kind $kind" >&2; exit 2
  ;;
esac
