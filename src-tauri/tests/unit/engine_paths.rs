use fundacad_lib::doc_paths::Provenance;
use fundacad_lib::engine::check_request_path;
use serde_json::json;

const REMOTE: &str = "//host/share/a.step";

fn local(name: &str) -> String {
    std::env::temp_dir().join(name).to_str().unwrap().to_string()
}

fn check(req: serde_json::Value, held: &Provenance) -> Result<(), String> {
    check_request_path(&req.to_string(), held)
}

fn existing(name: &str) -> String {
    let path = local(&format!("fundacad-engine-paths-{}-{name}", std::process::id()));
    std::fs::write(&path, b"x").unwrap();
    path
}

#[test]
fn an_import_reads_a_network_path_only_once_it_was_handed_over() {
    let held = Provenance::default();
    let req = json!({"id": "1", "op": "import", "format": "step", "path": REMOTE});
    assert!(check(req.clone(), &held).unwrap_err().contains("network or device path"));
    held.vouch_all([REMOTE]);
    assert_eq!(check(req, &held), Err(format!("{REMOTE}: {}", std::fs::metadata(REMOTE).unwrap_err())));
}

#[test]
fn an_import_of_a_local_file_passes() {
    let held = Provenance::default();
    let path = existing("a.step");
    assert_eq!(check(json!({"id": "1", "op": "import", "format": "step", "path": path}), &held), Ok(()));
    let _ = std::fs::remove_file(path);
}

#[test]
fn an_import_reads_only_a_regular_file() {
    let held = Provenance::default();
    let dir = std::env::temp_dir().to_str().unwrap().to_string();
    assert_eq!(
        check(json!({"id": "1", "op": "import", "format": "step", "path": dir}), &held),
        Err(format!("{dir} is not a file"))
    );
}

#[cfg(unix)]
#[test]
fn an_import_of_a_device_node_is_refused() {
    let held = Provenance::default();
    let req = json!({"id": "1", "op": "import", "format": "stl", "path": "/dev/zero"});
    assert_eq!(check(req, &held), Err("/dev/zero is not a file".to_string()));
}

#[cfg(windows)]
#[test]
fn an_import_of_a_windows_device_name_or_a_file_stream_is_refused() {
    let held = Provenance::default();
    let file = existing("a.funda");
    for raw in [r"C:\in\CON.step".to_string(), format!("{file}:x.step")] {
        let err = check(json!({"id": "1", "op": "import", "format": "step", "path": raw}), &held).unwrap_err();
        assert!(err.contains("names a Windows device or a file stream"), "{raw}: {err}");
    }
    let _ = std::fs::remove_file(file);
}

#[test]
fn an_export_writes_only_to_a_full_local_path_or_one_handed_over() {
    let held = Provenance::default();
    for op in ["export", "exportWith"] {
        assert!(check(json!({"id": "1", "op": op, "path": REMOTE, "document": {}}), &held).is_err(), "{op}");
        assert!(check(json!({"id": "1", "op": op, "path": "parts/a.stl", "document": {}}), &held).is_err(), "{op}");
        for name in ["a.stl", "a.3mf", "a.step", "A.STP", "a.glb", "a.dxf", "a.svg"] {
            assert_eq!(
                check(json!({"id": "1", "op": op, "path": local(name), "document": {}}), &held),
                Ok(()),
                "{op} {name}"
            );
        }
    }
    held.vouch_all([REMOTE]);
    assert_eq!(check(json!({"id": "1", "op": "export", "path": REMOTE, "document": {}}), &held), Ok(()));
}

#[test]
fn an_export_writes_another_kind_of_file_only_where_a_dialog_put_it() {
    let held = Provenance::default();
    let picked = [local("notes.docx"), local("part"), local("run.cmd"), local("a.stl.")];
    for op in ["export", "exportWith"] {
        for path in &picked {
            let err = check(json!({"id": "1", "op": op, "path": path, "document": {}}), &held).unwrap_err();
            assert_eq!(err, format!("{path} is not a model file FundaCAD exports, so nothing was written."), "{op}");
        }
    }
    held.vouch_all(picked.iter().map(String::as_str));
    for op in ["export", "exportWith"] {
        for path in &picked {
            let err = check(json!({"id": "1", "op": op, "path": path, "document": {}}), &held).unwrap_err();
            assert_eq!(err, format!("{path} is not a model file FundaCAD exports, so nothing was written."), "{op}");
        }
    }
    for path in &picked {
        held.vouch_picked(path);
    }
    for op in ["export", "exportWith"] {
        for path in &picked {
            assert_eq!(check(json!({"id": "1", "op": op, "path": path, "document": {}}), &held), Ok(()), "{op} {path}");
        }
    }
}

#[test]
fn an_escaped_path_key_is_still_checked() {
    let held = Provenance::default();
    let remote = serde_json::to_string(REMOTE).unwrap();
    let plain = check(json!({"id": "1", "op": "import", "format": "step", "path": REMOTE}), &held);
    assert!(plain.as_ref().unwrap_err().contains("network or device path"));
    let key_escaped = format!(r#"{{"id":"1","op":"import","format":"step","path":{remote}}}"#);
    assert_eq!(check_request_path(&key_escaped, &held), plain);
    let both_escaped = format!(r#"{{"id":"1","op":"import","format":"step","path":{remote}}}"#);
    assert_eq!(check_request_path(&both_escaped, &held), plain);
}

#[cfg(windows)]
#[test]
fn an_export_to_a_windows_device_name_or_a_file_stream_is_refused() {
    let held = Provenance::default();
    for raw in [r"C:\out\NUL.stl", r"C:\out\com1.step", r"C:\out\a.txt:x.stl"] {
        assert!(check(json!({"id": "1", "op": "export", "path": raw}), &held).is_err(), "{raw}");
    }
}

#[test]
fn a_repeated_key_is_checked_as_the_worker_reads_it() {
    let held = Provenance::default();
    let local = serde_json::to_string(&local("a.step")).unwrap();
    let remote = serde_json::to_string(REMOTE).unwrap();
    let path_twice = format!(r#"{{"id":"1","op":"import","format":"step","path":{local},"path":{remote}}}"#);
    assert!(check_request_path(&path_twice, &held).is_err());
    let op_twice = format!(r#"{{"id":"1","op":"rebuild","op":"import","format":"step","path":{remote}}}"#);
    assert!(check_request_path(&op_twice, &held).is_err());
}

#[test]
fn other_ops_and_requests_without_a_path_pass() {
    let held = Provenance::default();
    assert_eq!(check(json!({"id": "1", "op": "rebuild", "document": {"features": []}}), &held), Ok(()));
    assert_eq!(
        check(json!({"id": "1", "op": "import", "format": "step", "data": "AA==", "name": "a.step"}), &held),
        Ok(())
    );
    assert_eq!(check_request_path("not json", &held), Ok(()));
}

#[test]
fn an_export_never_writes_over_a_document_however_the_path_was_handed_over() {
    let held = Provenance::default();
    let docs = [local("a.funda"), local("a.FUNDAB"), local("a.neocad"), local("a.sindri")];
    held.vouch_all(docs.iter().map(String::as_str));
    for path in &docs {
        held.vouch_picked(path);
    }
    for op in ["export", "exportWith"] {
        for path in &docs {
            let err = check(json!({"id": "1", "op": op, "path": path, "document": {}}), &held).unwrap_err();
            assert_eq!(err, format!("{path} is a FundaCAD document, and an export never writes over one."), "{op}");
        }
    }
}

#[cfg(unix)]
#[test]
fn an_export_does_not_follow_a_link_at_a_model_name_no_dialog_picked() {
    let held = Provenance::default();
    let target = existing("link-target.txt");
    let link = local(&format!("fundacad-engine-paths-{}-link.stl", std::process::id()));
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let req = json!({"id": "1", "op": "export", "path": link, "document": {}});
    assert_eq!(check(req.clone(), &held), Err(format!("{link} is not a file, so nothing was written.")));
    held.vouch_all([link.as_str()]);
    assert_eq!(check(req.clone(), &held), Err(format!("{link} is not a file, so nothing was written.")));
    held.vouch_picked(&link);
    assert_eq!(check(req, &held), Ok(()));
    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_file(&target);
}
