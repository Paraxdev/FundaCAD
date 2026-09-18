//! End-to-end check of the seam between the engine and the document container.
//!
//! The engine stores an import's geometry in the blob store, and the app's
//! container (container.rs) packs that store into a saved file and unpacks it
//! somewhere else. Each half has its own tests; this proves they compose: a
//! blob the ENGINE wrote survives the app's container round trip into a store
//! that has never seen it, and the engine rebuilds from it there. A mismatch in
//! the hash, the filename convention or the directory the worker is told would
//! slip through both halves and show up as "the geometry vanished" on a user's
//! machine.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::import::{self, blobstore::BlobStore};

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad_seam_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

#[test]
fn an_engine_blob_survives_the_container_and_rebuilds() {
    let dir = tmpdir("e2e");
    let blobs_a = dir.join("blobs_a"); // the authoring machine
    let blobs_b = dir.join("blobs_b"); // a machine that has never seen this file

    // 1. The engine imports a real STEP assembly and stores its geometry.
    let store = BlobStore::open(&blobs_a).unwrap();
    let imported = import::import_geometry(&fixture("asm_nested.step"), "step", &store).unwrap();
    let hash = imported["geom"].as_str().expect("the import names its blob").to_owned();
    assert_eq!(hash.len(), 32, "expected a blake2b-128 hex hash, got {hash:?}");

    // The filename convention has to match on both sides or every reference
    // dangles; assert it rather than trusting two independent format! calls.
    let blob = blobs_a.join(format!("{hash}.bbrep"));
    assert!(blob.exists(), "the engine did not write {}", blob.display());

    // 2. The app packages it, exactly as `container_save` does.
    let doc = format!(
        r#"{{"version":5,"parameters":{{}},"features":[{{"id":"f1","type":"import","name":"Asm","format":"step","geom":"{hash}"}}]}}"#
    );
    let mut map = BTreeMap::new();
    map.insert(hash.clone(), blob);
    let dest = dir.join("part.funda");
    fundacad_lib::container::write_container(&dest, &doc, &map, &BTreeMap::new(), "seam-test")
        .expect("write_container failed");

    // 3. The app opens it somewhere that has never seen this geometry.
    let (got_doc, manifest) =
        fundacad_lib::container::read_container(&dest, &blobs_b, None).expect("read_container");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&got_doc).unwrap(),
        serde_json::from_str::<serde_json::Value>(&doc).unwrap(),
        "document did not survive the round trip"
    );
    assert_eq!(manifest.blobs.len(), 1);
    assert!(blobs_b.join(format!("{hash}.bbrep")).exists());

    // 4. The engine rebuilds from the EXTRACTED blob, with no other geometry
    //    around. The builder reads the store the worker is told about, the
    //    variable `engine::configure_env` sets.
    std::env::set_var("FUNDACAD_BLOB_DIR", &blobs_b);
    let value: serde_json::Value = serde_json::from_str(&got_doc).unwrap();
    let typed: CadDocument = serde_json::from_value(value.clone()).unwrap();
    let rebuilt = builder::rebuild(&typed, &value, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(rebuilt.errors.is_empty(), "rebuild reported errors: {:?}", rebuilt.errors);
    assert_eq!(rebuilt.bodies.len(), 7, "asm_nested is a 7-body assembly");

    let _ = std::fs::remove_dir_all(&dir);
}

/// The worker has to be told the same blob store the container reads, or an
/// import is geometry a save cannot find.
#[test]
fn the_engine_worker_is_told_the_containers_blob_store() {
    let mut cmd = Command::new("fundacad");
    fundacad_lib::engine::configure_env(
        &mut cmd,
        Some(Path::new("/data/blobs")),
        Some(Path::new("/data/plugins")),
        "tok",
    );
    let env: BTreeMap<String, Option<String>> = cmd
        .get_envs()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
        .collect();
    assert_eq!(env["FUNDACAD_BLOB_DIR"].as_deref(), Some("/data/blobs"));
    assert_eq!(env["FUNDACAD_PLUGIN_DIR"].as_deref(), Some("/data/plugins"));
    assert_eq!(env["FUNDACAD_LIVE_TOKEN"].as_deref(), Some("tok"));

    let mut bare = Command::new("fundacad");
    fundacad_lib::engine::configure_env(&mut bare, None, None, "tok");
    assert!(
        !bare.get_envs().any(|(k, _)| k == "FUNDACAD_BLOB_DIR" || k == "FUNDACAD_PLUGIN_DIR"),
        "an unresolved directory leaves the engine's own default"
    );
}
