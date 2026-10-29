use fundacad_lib::container::{mesh_sources, save_document, verify_document, Stores};
use fundacad_lib::doc_paths::{refuse_unvouched, Provenance, Vouched};
use std::collections::BTreeMap;
use std::path::PathBuf;

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad_app_container_{tag}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_save_refuses_an_import_geometry_id_that_is_not_a_digest() {
    let dir = tmpdir("geom_id");
    let stores = Stores { blobs: dir.join("blobs"), meshes: dir.join("meshes"), sections: dir.join("sections") };
    std::fs::create_dir_all(&stores.blobs).unwrap();
    std::fs::write(dir.join("outside.bbrep"), b"not from the store").unwrap();
    for name in ["saved.funda", "saved.fundab"] {
        let dest = dir.join(name);
        let err = save_document(
            &stores,
            &dest,
            r#"{"version":11,"features":[]}"#,
            vec!["../outside".into()],
            vec![],
            vec![],
            vec![],
            "unit-test",
        )
        .unwrap_err();
        assert!(err.contains("previous file is unchanged"), "{name}: {err}");
        assert!(!dest.exists(), "{name}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_save_takes_a_mesh_only_by_a_plain_key_inside_the_store() {
    let dir = tmpdir("mesh_key");
    let meshes = dir.join("meshes");
    std::fs::create_dir_all(&meshes).unwrap();
    std::fs::write(meshes.join("good.bin"), b"m").unwrap();
    std::fs::write(dir.join("outside.bin"), b"o").unwrap();
    let outside = dir.join("outside").to_string_lossy().into_owned();
    let got = mesh_sources(&meshes, vec!["good".into(), outside, "../outside".into(), "gone".into()]);
    assert_eq!(got, BTreeMap::from([("good".to_string(), meshes.join("good.bin"))]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_verify_refuses_a_device_path_nobody_handed_over() {
    let raw = r"\\.\NUL";
    let want = refuse_unvouched(raw, &Vouched::default()).unwrap_err();
    assert_eq!(verify_document(&Provenance::default(), raw).map(|_| ()), Err(want));
}

#[test]
fn a_verify_refuses_a_folder() {
    let dir = tmpdir("verify_dir");
    let raw = dir.to_string_lossy().into_owned();
    assert_eq!(verify_document(&Provenance::default(), &raw).map(|_| ()), Err(format!("{raw} is not a file")));
    let _ = std::fs::remove_dir_all(&dir);
}
