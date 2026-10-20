#!/bin/sh
# Rewrites what tests/fixtures/versions is checked against: expected/vN.json, each
# vN.funda as the app opens it, and v10.fundab, the binary twin of v10.funda.
# Only for a deliberate change in how an existing file opens; the diff is the review.
#   sh scripts/regen-version-fixtures.sh
set -eu
cd "$(dirname "$0")/.."
UPDATE_VERSION_FIXTURES=1 npx vitest run tests/document/versionFixtures.test.ts
cargo test -p fundacad-format --test version_fixtures -- --ignored write_the_v10_binary_fixture
