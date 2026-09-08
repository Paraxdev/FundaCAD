#!/usr/bin/env bash
# Run the plugin bundle guards on a machine where the app's own test binary
# cannot start.
#
# src-tauri/src/plugins/bundle.rs holds the refusals that stop a downloaded
# plugin from writing outside its own directory, from being fetched from
# somewhere other than the releases host, and from arriving with permissions
# other than the ones its installer screen showed. They have unit tests. On
# Linux CI `cargo test --lib` runs them with everything else.
#
# It does not run on this Windows box: linking fundacad_lib pulls in the webview
# stack, and the resulting test executable dies with STATUS_ENTRYPOINT_NOT_FOUND
# before a single test starts (`cargo test --lib -- --list` fails identically,
# so it is the binary, not the tests). That would leave the guards shipping
# having never been executed here.
#
# So: build bundle.rs on its own, in a throwaway crate that links serde, sha2
# and zip and nothing else, and run its tests against the real file. Same
# source, no webview, no excuse.
#
# It then does one thing the unit tests cannot: builds the MCP plugin bundle
# the release job publishes, and unpacks THAT with the same extractor the app
# uses. The unit tests build their zips in memory, so they prove the guard
# rejects what it should; this proves the archive we actually ship is one it
# accepts. A packaging script that quietly produces something the installer
# refuses would otherwise be found by the first person to press Install.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/src-tauri/src/plugins/bundle.rs"
OUT="$REPO/src-tauri/target/plugin-guard"

[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }

mkdir -p "$OUT/src"
cat > "$OUT/Cargo.toml" <<TOML
[package]
name = "plugin-guard"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
zip = { version = "4", default-features = false, features = ["deflate-flate2"] }
flate2 = "1"

[workspace]
TOML

# The real file, by path. Not a copy: a copy is a second thing to keep in step,
# and the whole point is to test what ships. cygpath because rustc wants a
# Windows path where the shell here hands out /d/dev/... ones.
SRCW="$(cygpath -m "$SRC" 2>/dev/null || echo "$SRC")"
cat > "$OUT/src/lib.rs" <<RS
#[path = "$SRCW"]
pub mod bundle;
RS

# The bundle as it will be published, built by the same script CI runs.
BUNDLE="$OUT/bundle"
rm -rf "$BUNDLE"
python "$REPO/scripts/build-plugins.py" "$BUNDLE" FundaCAD.MCP >/dev/null
ZIP="$(cygpath -m "$BUNDLE/plugin-FundaCAD.MCP.zip" 2>/dev/null || echo "$BUNDLE/plugin-FundaCAD.MCP.zip")"

mkdir -p "$OUT/tests"
cat > "$OUT/tests/real_bundle.rs" <<'RS'
//! The bundle the release job publishes, unpacked by the extractor the app
//! ships. Not a fixture: the path comes from the packaging script that just
//! ran.

use plugin_guard::bundle::extract_into;

#[test]
fn the_published_mcp_bundle_unpacks_and_declares_itself() {
    let zip = std::env::var("PLUGIN_ZIP").expect("PLUGIN_ZIP must name the built bundle");
    let bytes = std::fs::read(&zip).expect("the packaging script produced no zip");
    let dir = std::env::temp_dir().join("fundacad-plugin-guard-unpack");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    extract_into(&bytes, &dir).expect("the shipped bundle was refused by the extractor");

    // The two files the installer and the launch command depend on by name.
    assert!(dir.join("manifest.json").is_file(), "no manifest.json in the bundle");
    assert!(dir.join("server.py").is_file(), "no server.py in the bundle");

    // Tests are deliberately not packaged, so a bundle carrying them means the
    // exclusion in the packaging script stopped working.
    assert!(!dir.join("tests").exists(), "the bundle carries its test suite");
    let _ = std::fs::remove_dir_all(&dir);
}
RS

cd "$OUT"
PLUGIN_ZIP="$ZIP" cargo test --quiet 2>&1 | tail -40
