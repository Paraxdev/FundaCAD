//! The disk checkpoints outlive the executable that wrote them: an app update
//! installs a new binary with a new mtime, and the first reopen of a long
//! document after it should still resume from disk.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-cache-identity-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A plate drilled many times, slow enough in kernel time that the rebuild
/// writes a checkpoint at its tip.
fn drilled_plate(holes: usize) -> Value {
    let mut features = vec![
        json!({"id": "plate", "type": "sketch", "plane": "XY",
               "entities": [{"type": "rectangle", "width": 200, "height": 120, "x": 0, "y": 0}]}),
        json!({"id": "body", "type": "extrude", "sketch": "plate", "distance": 10, "operation": "new"}),
    ];
    for i in 0..holes {
        let (x, y) = (-90 + (i % 18) as i64 * 10, -50 + (i / 18) as i64 * 10);
        features.push(json!({"id": format!("s{i}"), "type": "sketch", "plane": "XY",
                             "entities": [{"type": "circle", "radius": 2, "x": x, "y": y}]}));
        features.push(json!({"id": format!("c{i}"), "type": "extrude", "sketch": format!("s{i}"),
                             "distance": 10, "operation": "cut"}));
    }
    json!({"parameters": {}, "features": features})
}

fn rebuild_from(exe: &Path, doc: &Path, root: &Path) -> String {
    let out = Command::new(exe)
        .arg("rebuild")
        .arg(doc)
        .env("XDG_CACHE_HOME", root.join("xdg"))
        .env("FUNDACAD_BLOB_DIR", root.join("blobs"))
        .env("FUNDACAD_PLUGIN_DIR", root.join("plugins"))
        .env_remove("FUNDACAD_ENV_SIG")
        .env_remove("FUNDACAD_DISK_CACHE")
        .stdout(Stdio::null())
        .output()
        .expect("the engine runs");
    let log = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(out.status.success(), "rebuild failed: {log}");
    log.lines()
        .find(|l| l.contains("[rebuild-cached]"))
        .unwrap_or_else(|| panic!("no [rebuild-cached] line in: {log}"))
        .to_owned()
}

#[test]
fn the_same_engine_installed_again_reopens_from_disk() {
    let root = scratch("reinstall");
    let doc = root.join("plate.json");
    std::fs::write(&doc, drilled_plate(80).to_string()).unwrap();
    std::fs::create_dir_all(root.join("plugins")).unwrap();

    // Windows' copy keeps the source's mtime, an installer writes a new one.
    let install = |name: &str, age: u64| {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join(Path::new(env!("CARGO_BIN_EXE_fundacad-engine")).file_name().unwrap());
        std::fs::copy(env!("CARGO_BIN_EXE_fundacad-engine"), &exe).unwrap();
        let mtime = SystemTime::now() - Duration::from_secs(age);
        std::fs::File::options().write(true).open(&exe).unwrap().set_modified(mtime).unwrap();
        exe
    };
    let old = install("old", 3600);
    let first = rebuild_from(&old, &doc, &root);
    assert!(first.contains("src=full"), "{first}");

    let new = install("new", 0);
    let reopened = rebuild_from(&new, &doc, &root);
    let _ = std::fs::remove_dir_all(&root);
    assert!(reopened.contains("src=disk"), "the reinstalled engine rebuilt cold: {reopened}");
}
