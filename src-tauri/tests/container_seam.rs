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
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures").join(name).to_string_lossy().into_owned()
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
    fundacad_lib::container::write_container(&dest, &doc, &map, &BTreeMap::new(), &[], "seam-test")
        .expect("write_container failed");

    // 3. The app opens it somewhere that has never seen this geometry.
    let (got_doc, manifest) = fundacad_lib::container::read_container(&dest, &blobs_b, None).expect("read_container");
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

fn future_fundab(dir: &Path, payload: &[u8]) -> PathBuf {
    use fundacad_lib::fnda;
    let info = fnda::json_to_cbor("{}").unwrap();
    let cbor = fnda::json_to_cbor(r#"{"version":11,"features":[]}"#).unwrap();
    let (b, m) = (BTreeMap::new(), BTreeMap::new());
    let mut sections = fnda::document_sections(&info, &cbor, &b, &m, &[]);
    sections.push(fnda::SectionSpec {
        kind: 9,
        name: "futureIndex".into(),
        source: fnda::Source::Bytes(payload),
        layout: fnda::SMALL_LAYOUT,
    });
    let path = dir.join("future.fundab");
    fnda::write(&mut std::fs::File::create(&path).unwrap(), &sections).unwrap();
    path
}

#[test]
fn a_section_this_version_does_not_read_is_saved_back_into_a_fundab_only() {
    use fundacad_lib::container::{open_document_full, save_document, Stores};
    let dir = tmpdir("carried");
    let stores = Stores { blobs: dir.join("blobs"), meshes: dir.join("meshes"), sections: dir.join("sections") };
    let payload: Vec<u8> = (0..4000u32).map(|i| (i % 249) as u8).collect();
    let opened =
        open_document_full(&future_fundab(&dir, &payload), &stores.blobs, Some(&stores.meshes), Some(&stores.sections))
            .unwrap();
    assert_eq!(opened.carried.len(), 1);

    let bin = dir.join("saved.fundab");
    let json = dir.join("saved.funda");
    for dest in [&bin, &json] {
        save_document(&stores, dest, &opened.document, vec![], vec![], vec![], opened.carried.clone(), "seam-test")
            .unwrap();
    }
    let elsewhere = dir.join("sections_b");
    let again = open_document_full(&bin, &dir.join("blobs_b"), None, Some(&elsewhere)).unwrap();
    assert_eq!(again.carried, opened.carried);
    assert_eq!(std::fs::read(elsewhere.join(format!("{}.bin", again.carried[0].hash))).unwrap(), payload);
    assert!(open_document_full(&json, &dir.join("blobs_b"), None, Some(&elsewhere)).unwrap().carried.is_empty());

    let mut forged = opened.carried[0].clone();
    forged.hash = "../../escape".into();
    save_document(&stores, &bin, &opened.document, vec![], vec![], vec![], vec![forged], "seam-test").unwrap();
    assert!(open_document_full(&bin, &dir.join("blobs_b"), None, Some(&elsewhere)).unwrap().carried.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn geometry_a_hash_shaped_string_names_is_embedded_when_stored_and_skipped_when_not() {
    use fundacad_lib::container::{open_document_full, save_document, Stores};
    let dir = tmpdir("optional");
    let stores = Stores { blobs: dir.join("blobs"), meshes: dir.join("meshes"), sections: dir.join("sections") };
    std::fs::create_dir_all(&stores.blobs).unwrap();
    let data: Vec<u8> = (0..64u32).map(|i| (i * 37 + 11) as u8).collect();
    let stored = fundacad_lib::container::hash_bytes(&data);
    std::fs::write(stores.blobs.join(format!("{stored}.bbrep")), &data).unwrap();
    let absent = "0123456789abcdef0123456789abcdef".to_string();
    let doc = format!(
        r#"{{"version":99,"features":[{{"id":"w1","type":"futureWidget","blob":"{stored}","also":"{absent}"}}]}}"#
    );

    let dest = dir.join("saved.funda");
    save_document(&stores, &dest, &doc, vec![], vec![stored.clone(), absent.clone()], vec![], vec![], "seam-test")
        .unwrap();
    let fresh = dir.join("blobs_b");
    open_document_full(&dest, &fresh, None, None).unwrap();
    assert_eq!(std::fs::read(fresh.join(format!("{stored}.bbrep"))).unwrap(), data);

    let err = save_document(&stores, &dest, &doc, vec![absent], vec![], vec![], vec![], "seam-test").unwrap_err();
    assert!(err.contains("could not be found"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A big import is saved in segments with their index beside it, and every way
/// the app opens a file publishes the same bytes on a machine that never saw it.
#[test]
fn a_big_import_saved_in_segments_opens_the_same_every_way() {
    use fundacad_lib::container::{
        hash_bytes, open_document_bytes, open_document_checked, open_document_full, save_document, Stores,
    };
    use fundacad_lib::fnda;
    let dir = tmpdir("segmented");
    let stores = Stores { blobs: dir.join("blobs"), meshes: dir.join("meshes"), sections: dir.join("sections") };
    std::fs::create_dir_all(&stores.blobs).unwrap();
    let data: Vec<u8> =
        (0..3u32 << 20).map(|i| b"0123456789 ,.-e"[((i.wrapping_mul(2654435761) >> 15) % 15) as usize]).collect();
    let hash = hash_bytes(&data);
    std::fs::write(stores.blobs.join(format!("{hash}.bbrep")), &data).unwrap();
    let doc = format!(
        r#"{{"version":10,"parameters":{{}},"features":[{{"id":"f1","type":"import","name":"Big","format":"step","geom":"{hash}"}}]}}"#
    );
    let dest = dir.join("big.fundab");
    save_document(&stores, &dest, &doc, vec![hash.clone()], vec![], vec![], vec![], "seam-test").unwrap();
    let index = fnda::read_section_of_kind(&dest, fnda::KIND_SEGMENTS).unwrap();
    assert!(index.is_some(), "a 3 MiB blob is saved in segments");

    let full = dir.join("blobs_full");
    let opened = open_document_full(&dest, &full, Some(&dir.join("meshes_b")), Some(&dir.join("sections_b"))).unwrap();
    assert!(opened.carried.is_empty(), "the index is never carried");
    assert_eq!(opened.report, fnda::RepairReport::default());
    let checked = dir.join("blobs_checked");
    let (got, _) = open_document_checked(&dest, &checked, None).unwrap();
    let dropped = dir.join("blobs_dropped");
    let from_bytes =
        open_document_bytes(&std::fs::read(&dest).unwrap(), &dropped, None, Some(&dir.join("sections_c"))).unwrap();
    assert!(from_bytes.was_container && from_bytes.carried.is_empty());
    for (store, text) in [(&full, &opened.document), (&checked, &got), (&dropped, &from_bytes.document)] {
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(text).unwrap(),
            serde_json::from_str::<serde_json::Value>(&doc).unwrap()
        );
        assert_eq!(std::fs::read(store.join(format!("{hash}.bbrep"))).unwrap(), data);
    }

    let fixture_store = dir.join("blobs_fixture");
    let fixture =
        open_document_full(Path::new(&fixture("versions/segmented.fundab")), &fixture_store, None, None).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&fixture.document).unwrap()["version"], 10);
    assert_eq!(std::fs::read_dir(&fixture_store).unwrap().count(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}
