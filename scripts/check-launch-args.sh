#!/usr/bin/env bash
# Run the launch path tests (src-tauri/tests/unit/launch_args.rs) against the
# real src-tauri/src/launch_args.rs, by path, in a crate with no Tauri, the same
# way check-plugin-guards.sh runs the plugin guards. On Windows it runs the tests
# of Windows quoting without building the webview stack, since CI runs the app's
# tests on Linux.
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

# The tests name the app's lib.
[lib]
name = "fundacad_lib"

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

mkdir -p "$OUT/tests"
cat > "$OUT/tests/unit.rs" <<RS
#[path = "$(w "$REPO/src-tauri/tests/unit/launch_args.rs")"]
mod launch_args;
RS

cd "$OUT"
cargo test --quiet launch_args -- --test-threads=4 2>&1 | tail -40
