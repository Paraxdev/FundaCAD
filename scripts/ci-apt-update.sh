#!/usr/bin/env bash
# apt-get update for the runners. A stalled mirror once held it for three hours
# and apt's own timeout never fired, so the whole call is on a clock and retried.
set -euo pipefail

echo 'Acquire::Retries "3"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' \
  | sudo tee /etc/apt/apt.conf.d/80-ci-timeouts > /dev/null

for try in 1 2 3; do
  if sudo timeout -k 10 240 apt-get update "$@"; then exit 0; fi
  echo "::warning::apt-get update did not finish, try $try of 3"
  sleep 15
done
echo "::error::apt-get update did not finish in three tries"
exit 1
