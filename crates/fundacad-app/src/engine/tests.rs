use super::*;

fn open_text(name: &str, text: &str) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!("fundacad-app-test-{}-engine-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{name}.funda"));
    std::fs::write(&path, text).unwrap();
    let opened = open(&path, || {}).map(|_| ());
    let _ = std::fs::remove_dir_all(&dir);
    opened
}

#[test]
fn a_file_from_a_newer_build_is_refused_before_the_engine_starts() {
    let newer = fundacad_core::schema::DOCUMENT_VERSION + 3;
    let err = open_text("newer", &format!(r#"{{"version": {newer}, "parameters": {{}}, "features": []}}"#)).err();
    assert_eq!(
        err.as_deref(),
        Some(
            format!(
                "it was saved by a newer FundaCAD (document version {newer}, this build reads up to {}), update FundaCAD to open it",
                fundacad_core::schema::DOCUMENT_VERSION
            )
            .as_str()
        )
    );
}

#[test]
fn a_file_that_is_not_an_object_is_not_a_document() {
    let err = open_text("list", "[1, 2]").unwrap_err();
    assert!(err.ends_with("list.funda is not a document"), "{err}");
}
