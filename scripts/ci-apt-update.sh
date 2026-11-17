#!/usr/bin/env bash
# apt-get update for the runners. A stalled mirror once held it for three hours
# and apt's own timeout never fired, so the whole call is on a clock and retried.
set -euo pipefail

# A dead mirror leaves indexes missing while apt-get update still exits 0, so any failure counts.
# One retry only: apt retried the same stalled mirror instead of failing over to the next one.
printf '%s\n' 'Acquire::Retries "1";' 'Acquire::http::Timeout "20";' 'Acquire::https::Timeout "20";' \
  'APT::Update::Error-Mode "any";' | sudo tee /etc/apt/apt.conf.d/80-ci-timeouts > /dev/null

# The hosted images fetch from Azure's Ubuntu mirror first, and when it stalls apt waits on it for every
# package (2026-11-11, every Linux job timed out). A self-hosted runner's sources are its owner's.
azure='azure\.archive\.ubuntu\.com'
lists=()
for p in /etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d; do
  if [ -e "$p" ]; then lists+=("$p"); fi
done
on_azure() {
  [ "${RUNNER_ENVIRONMENT:-}" != self-hosted ] && [ ${#lists[@]} -gt 0 ] && sudo grep -rqs "$azure" "${lists[@]}"
}
leave_azure() {
  on_azure || return 0
  echo "::warning::the Azure Ubuntu mirror $1, apt uses archive.ubuntu.com"
  sudo grep -rls "$azure" "${lists[@]}" | while read -r f; do
    sudo sed -i "s#http://$azure#http://archive.ubuntu.com#g" "$f"
  done
}

if on_azure; then
  . /etc/os-release
  curl -fsS --max-time 10 -o /dev/null "http://azure.archive.ubuntu.com/ubuntu/dists/$VERSION_CODENAME/InRelease" \
    || leave_azure "did not answer"
fi

for try in 1 2 3; do
  if sudo timeout -k 10 180 apt-get update "$@"; then exit 0; fi
  echo "::warning::apt-get update failed or stalled, try $try of 3"
  leave_azure "failed an update"
  sleep 10
done
echo "::error::apt-get update did not finish in three tries"
exit 1
