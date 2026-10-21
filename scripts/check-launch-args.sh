#!/usr/bin/env bash
# Run the launch path tests (src-tauri/src/launch_args.rs) on a machine where
# the app's own test binary cannot start, the same way check-plugin-guards.sh
# runs the plugin guards: the real file, by path, in a crate with no Tauri.
# On Windows this is the only place the tests of Windows quoting run, since CI
# runs the app's unit tests on Linux.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/src-tauri/target/launch-args"
w() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

mkdir -p "$OUT/src"
cat > "$OUT/Cargo.toml" <<TOML
[package]
name = "launch-args"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
url = "2"

[workspace]
TOML

cat > "$OUT/src/lib.rs" <<RS
#[path = "$(w "$REPO/src-tauri/src/library.rs")"]
pub mod library;
#[path = "$(w "$REPO/src-tauri/src/launch_args.rs")"]
pub mod launch_args;
RS

cd "$OUT"
cargo test --quiet launch_args -- --test-threads=4 2>&1 | tail -40
