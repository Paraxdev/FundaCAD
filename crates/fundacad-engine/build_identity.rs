// The build identity an engine answers `ping` with (docs/PROTOCOL.md), for the
// build scripts of the two executables that host the engine: `include!`d by
// crates/fundacad-cli/build.rs and src-tauri/build.rs, which pass it on with
// `fundacad_engine::set_build(env!("FUNDACAD_BUILD"))`.
//
// The identity is the commit the engine's source was at and, when that source
// had changes nobody committed, a hash of them, so two executables built from
// the same tree say the same thing whichever of the two they are. Without git
// it is `{}`, which a client reads as "cannot say".

/// What counts as the engine's source: everything an engine executable
/// compiles in, less the MCP server, which does not build geometry.
const ENGINE_SOURCE: &[&str] = &["crates", "third_party", "Cargo.toml", "Cargo.lock"];
const NOT_ENGINE_SOURCE: &str = ":(exclude)crates/fundacad-mcp";

fn emit_engine_build() {
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let git = |args: &[&str]| -> Option<Vec<u8>> {
        let out = std::process::Command::new("git").args(args).current_dir(&manifest).output().ok()?;
        out.status.success().then_some(out.stdout)
    };
    let text = |args: &[&str]| git(args).map(|o| String::from_utf8_lossy(&o).trim().to_string());
    let (Some(root), Some(commit)) = (text(&["rev-parse", "--show-toplevel"]), text(&["rev-parse", "HEAD"])) else {
        println!("cargo:rustc-env=FUNDACAD_BUILD={{}}");
        return;
    };
    let root = std::path::PathBuf::from(root);

    // HEAD moves on a checkout, the branch ref on a commit. Both live in git's
    // own directory, which for a worktree is not `.git` in the checkout, and
    // git names them relative to the directory it was asked from.
    let mut watched: Vec<std::path::PathBuf> = ["HEAD", "packed-refs"]
        .iter()
        .filter_map(|p| text(&["rev-parse", "--git-path", p]))
        .chain(text(&["symbolic-ref", "-q", "HEAD"]).and_then(|r| text(&["rev-parse", "--git-path", &r])))
        .map(|p| manifest.join(p))
        .collect();
    if let Ok(crates) = std::fs::read_dir(root.join("crates")) {
        watched
            .extend(crates.flatten().map(|e| e.path()).filter(|p| p.file_name().is_some_and(|n| n != "fundacad-mcp")));
    }
    watched.extend(ENGINE_SOURCE.iter().filter(|p| **p != "crates").map(|p| root.join(p)));
    for p in &watched {
        println!("cargo:rerun-if-changed={}", p.display());
    }

    let mut spec: Vec<&str> = vec!["--"];
    spec.extend(ENGINE_SOURCE);
    spec.push(NOT_ENGINE_SOURCE);
    // The files as they are on disk, never the diff: staging a file changes
    // the diff and no file time, so cargo would keep the old identity.
    let root_arg = root.to_string_lossy();
    let mut changed: Vec<Vec<u8>> = [
        &["diff", "HEAD", "--name-only", "-z", "--no-renames"][..],
        &["ls-files", "-z", "--others", "--exclude-standard"][..],
    ]
    .iter()
    .filter_map(|args| git(&[&["-C", &root_arg][..], args, &spec].concat()))
    .flat_map(|out| out.split(|b| *b == 0).filter(|n| !n.is_empty()).map(<[u8]>::to_vec).collect::<Vec<_>>())
    .collect();
    changed.sort();
    changed.dedup();
    // FNV-1a rather than std's hasher, which may change between toolchains:
    // the app and the CLI are separate builds and have to agree.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            hash = (hash ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for name in &changed {
        feed(name);
        match std::fs::read(root.join(String::from_utf8_lossy(name).as_ref())) {
            Ok(bytes) => {
                feed(&(bytes.len() as u64).to_le_bytes());
                feed(&bytes);
            }
            Err(_) => feed(&u64::MAX.to_le_bytes()),
        }
    }
    let changed = !changed.is_empty();

    let date = text(&["log", "-1", "--format=%cs", "HEAD"]).unwrap_or_default();
    let changes = if changed { format!(",\"changes\":\"{hash:016x}\"") } else { String::new() };
    println!("cargo:rustc-env=FUNDACAD_BUILD={{\"commit\":\"{commit}\",\"commitDate\":\"{date}\"{changes}}}");
}
