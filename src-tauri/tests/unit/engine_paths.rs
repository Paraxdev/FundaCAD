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

#[test]
fn an_import_reads_a_network_path_only_once_it_was_handed_over() {
    let held = Provenance::default();
    let req = json!({"id": "1", "op": "import", "format": "step", "path": REMOTE});
    assert!(check(req.clone(), &held).is_err());
    held.vouch_all([REMOTE]);
    assert_eq!(check(req, &held), Ok(()));
}

#[test]
fn an_import_of_a_local_file_passes() {
    let held = Provenance::default();
    assert_eq!(check(json!({"id": "1", "op": "import", "format": "step", "path": local("a.step")}), &held), Ok(()));
}

#[test]
fn an_export_writes_only_to_a_full_local_path_or_one_handed_over() {
    let held = Provenance::default();
    for op in ["export", "exportWith"] {
        assert!(check(json!({"id": "1", "op": op, "path": REMOTE, "document": {}}), &held).is_err(), "{op}");
        assert!(check(json!({"id": "1", "op": op, "path": "parts/a.stl", "document": {}}), &held).is_err(), "{op}");
        assert_eq!(check(json!({"id": "1", "op": op, "path": local("a.stl"), "document": {}}), &held), Ok(()), "{op}");
    }
    held.vouch_all([REMOTE]);
    assert_eq!(check(json!({"id": "1", "op": "export", "path": REMOTE, "document": {}}), &held), Ok(()));
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
