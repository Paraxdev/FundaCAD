//! Where the server looks for the geometry engine. A port of
//! `crates/fundacad-mcp/tools/python-oracle/tests/test_sidecar_dir.py`, which asked the same three
//! questions of the Python sidecar's directory.
//!
//! From a checkout the answer is the binary this workspace built. Installed as
//! a plugin there is no such build, so the app hands the path over in the
//! environment when it writes the launch command.
//!
//! Both readings have a way to be silently wrong, and each section here is one
//! of them. An override that is ignored sends an installed plugin looking for a
//! binary that is not there, and the failure surfaces as a spawn error naming a
//! path nobody set. An override that is trusted without checking does the same
//! thing while looking like it worked.

use std::path::{Path, PathBuf};

use fundacad_mcp::link::{engine_command, is_rust_engine_app, split_command};

const VARS: &[&str] = &[
    "FUNDACAD_ENGINE_CMD",
    "SINDRI_ENGINE_CMD",
    "SINDRICAD_ENGINE_CMD",
];

/// Set the override, run, and put back whatever was there. One test function
/// for all three cases because the environment is the process's, not a
/// thread's, and parallel tests would read each other's setting.
fn with_override<T>(value: Option<&str>, body: impl FnOnce() -> T) -> T {
    let saved: Vec<(&str, Option<String>)> =
        VARS.iter().map(|k| (*k, std::env::var(k).ok())).collect();
    for k in VARS {
        std::env::remove_var(k);
    }
    if let Some(v) = value {
        std::env::set_var("FUNDACAD_ENGINE_CMD", v);
    }
    let out = body();
    for (k, v) in saved {
        match v {
            Some(v) => std::env::set_var(k, v),
            None => std::env::remove_var(k),
        }
    }
    out
}

/// Where the engine is in THIS checkout, worked out from the test binary rather
/// than from the code under test: an expectation that searched the same way
/// would agree with a broken search. The test binary is in `target/<profile>/deps`.
fn built_engine() -> PathBuf {
    let exe = std::env::current_exe().expect("a test binary has a path");
    let profile = exe
        .parent()
        .and_then(Path::parent)
        .expect("target/<profile>/deps");
    profile.join(if cfg!(windows) {
        "fundacad-engine.exe"
    } else {
        "fundacad-engine"
    })
}

#[test]
fn the_engine_is_found_the_three_ways_that_matter() {
    // The control for everything below: with nothing set, the answer is the
    // engine this workspace built, and it is really there.
    let found = with_override(None, engine_command);
    let engine = built_engine();
    assert!(
        engine.is_file(),
        "build the engine first: {}",
        engine.display()
    );
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(
        same_file(Path::new(&found[0]), &engine),
        "{found:?} is not {}",
        engine.display()
    );

    // An installed plugin is told where the engine is, and a command line with
    // arguments in it survives.
    let told = with_override(Some(&engine.to_string_lossy()), engine_command);
    assert!(same_file(Path::new(&told[0]), &engine), "{told:?}");

    // An override naming nothing is not believed. A path that is not there is a
    // setting that is wrong, and spawning it anyway turns a wrong setting into
    // an error message about a file nobody named.
    let missing = std::env::temp_dir().join("fundacad-no-such-engine.exe");
    assert!(!missing.exists());
    let fallen_back = with_override(Some(&missing.to_string_lossy()), engine_command);
    assert!(
        same_file(Path::new(&fallen_back[0]), &engine),
        "{fallen_back:?}"
    );
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[test]
fn a_command_line_splits_the_way_a_shell_would() {
    // FUNDACAD_ENGINE_CMD is what the protocol suites drive both engines with,
    // and a path with a space in it is the ordinary case on Windows.
    assert_eq!(split_command("one two three"), ["one", "two", "three"]);
    assert_eq!(
        split_command("\"C:/Program Files/fundacad-engine.exe\" --flag"),
        ["C:/Program Files/fundacad-engine.exe", "--flag"]
    );
    assert_eq!(split_command("  spaced   out  "), ["spaced", "out"]);
    assert!(split_command("   ").is_empty());
}

#[test]
fn only_an_app_built_with_the_rust_engine_is_started_as_one() {
    // A Python sidecar build ignores `--engine` and opens a window, which is
    // not an engine however long the MCP server waits for LISTENING.
    let dir = tempfile::tempdir().unwrap();
    let rust = dir.path().join("rust.exe");
    let python = dir.path().join("python.exe");
    std::fs::write(&rust, b"MZ...\0engine_kind\0engine_attach\0engine_send\0").unwrap();
    std::fs::write(&python, b"MZ...\0sidecar_token\0").unwrap();
    assert!(is_rust_engine_app(&rust));
    assert!(!is_rust_engine_app(&python));
    assert!(!is_rust_engine_app(&dir.path().join("absent.exe")));
}
