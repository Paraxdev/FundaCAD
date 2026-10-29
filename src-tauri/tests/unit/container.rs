use fundacad_lib::container::{save_document, Stores};
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
