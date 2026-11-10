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
  # A stalled mirror once held apt past the job's 20 minutes. A dead one left half the indexes
  # missing while apt-get update still exited 0, so the install failed on "held broken packages".
  # The images keep their own mirror: azure.archive.ubuntu.com, which the runner itself uses,
  # stalled every Ubuntu install from inside the container (run 42796033842).
  printf '%s\n' 'Acquire::Retries "3";' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' \
    'APT::Update::Error-Mode "any";' > /etc/apt/apt.conf.d/80-ci-retries
  for try in 1 2 3; do
    if timeout -k 10 120 apt-get update -qq; then break; fi
    [ "$try" != 3 ] || { echo "::error::apt-get update failed or stalled in three tries"; exit 1; }
    echo "::warning::apt-get update failed or stalled, try $try of 3"
    sleep 15
  done
  # An unresolvable Depends fails here. Its Get: lines stay in the log, to show a download that stalls.
  if ! timeout -k 10 480 apt-get install -y -q -o Dpkg::Use-Pty=0 "$pkg"/FundaCAD_*.deb python3; then
    echo "::error::apt-get install failed or stalled, where it was:"
    tail -n 15 /var/log/apt/term.log /var/log/dpkg.log 2>/dev/null || true
    find /var/cache/apt/archives/partial -type f -printf '%s bytes %p\n' 2>/dev/null | tail -n 5
    exit 1
  fi
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
