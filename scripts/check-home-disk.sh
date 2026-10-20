#!/usr/bin/env sh
# Runs the tests of Home's disk code (src-tauri/src/library.rs) in a
# crate with no Tauri in it: on Windows the app's own test binary cannot start.
# HOME_DISK_OUT picks where the crate is built.
set -eu

REPO="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
OUT="${HOME_DISK_OUT:-$REPO/src-tauri/target/home-disk}"
mkdir -p "$OUT/src"
cat > "$OUT/Cargo.toml" <<TOML
[package]
name = "home-disk"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
base64 = "0.22"
fundacad-format = { path = "$REPO/crates/fundacad-format" }

[workspace]
TOML
: > "$OUT/src/lib.rs"
for m in library; do
  printf '#[path = "%s"]
pub mod %s;
' "$REPO/src-tauri/src/$m.rs" "$m" >> "$OUT/src/lib.rs"
done
cargo test --manifest-path "$OUT/Cargo.toml" --quiet
