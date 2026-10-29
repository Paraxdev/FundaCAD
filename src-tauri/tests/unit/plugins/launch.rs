use std::path::PathBuf;

use fundacad_lib::plugins::bundle::Consented;
use fundacad_lib::plugins::launch::{
    approval_text, args_shape, first_program, is_approved, may_spawn, read_approvals, remember,
};

fn text(p: PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn granted(grants: &[&str]) -> Consented {
    Consented { kind: "process".into(), version: "1.0.0".into(), grants: strings(grants), hosts: vec![] }
}

#[test]
fn only_a_plugin_granted_process_spawn_may_start_a_program() {
    assert!(may_spawn(Some(&granted(&["process.spawn"])), "A.B"));
    assert!(!may_spawn(Some(&granted(&["files.read", "network"])), "A.B"));
    assert!(!may_spawn(Some(&granted(&[])), "FundaCAD.Printing"));
    assert!(!may_spawn(None, "Some.Stranger"));
    assert!(!may_spawn(None, "FundaCAD.Onshape"));
    assert!(may_spawn(None, "FundaCAD.Printing"));
}

#[test]
fn every_shipped_plugin_with_process_spawn_may_start_a_program() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    for e in std::fs::read_dir(&root).unwrap().flatten() {
        let Ok(text) = std::fs::read_to_string(e.path().join("manifest.json")) else { continue };
        let m: serde_json::Value = serde_json::from_str(&text).unwrap();
        let spawns = m["grants"].as_array().is_some_and(|g| g.iter().any(|x| x == "process.spawn"));
        let id = m["id"].as_str().unwrap();
        assert_eq!(may_spawn(None, id), spawns, "{id}");
    }
}

#[test]
fn a_path_argument_is_remembered_by_its_folder_and_extension() {
    let dir = std::env::temp_dir().join("fundacad-shape");
    let a = text(dir.join("Bracket.3MF"));
    let b = text(dir.join("Lid.3mf"));
    assert_eq!(args_shape(&[a.clone()]), args_shape(&[b.clone()]));
    assert_ne!(args_shape(&[a.clone()]), args_shape(&[text(dir.join("Lid.exe"))]));
    assert_ne!(args_shape(&[a.clone()]), args_shape(&[text(dir.join("sub").join("Lid.3mf"))]));
    assert_ne!(args_shape(&[a.clone()]), args_shape(&[text(dir.join("..").join("Lid.3mf"))]));
    assert_ne!(args_shape(&[a.clone()]), args_shape(&[a.clone(), "--extra".into()]));
    assert_ne!(args_shape(&strings(&["--load"])), args_shape(&strings(&["--save"])));
    assert_ne!(args_shape(&strings(&["Lid.3mf"])), args_shape(&strings(&["Bracket.3mf"])));
}

#[test]
fn a_script_or_program_argument_is_remembered_exactly() {
    let dir = std::env::temp_dir().join("staging");
    for name in
        ["run.py", "run.PY", "run.bat", "run.cmd", "run.ps1", "run.exe", "run.sh", "run.js", "run.vbs", "run.jar"]
    {
        let a = text(dir.join(name));
        assert_eq!(args_shape(&[a.clone()]), vec![a.clone()], "{name}");
        assert!(approval_text("A.B", "/opt/run", &[a]).ends_with("Allow it now, and later for the same arguments?"));
    }
}

#[test]
fn an_approval_is_for_one_plugin_one_program_and_one_argument_shape() {
    let dir = std::env::temp_dir().join(format!("fundacad-approvals-{}", std::process::id()));
    let path = dir.join("launch-approvals.json");
    let file = |name: &str| vec![text(dir.join(name))];
    let none: Vec<String> = vec![];
    assert!(!is_approved(&read_approvals(&path), "A.B", "/bin/x", &none));
    remember(&path, "A.B", "/bin/x", &file("one.3mf")).unwrap();
    remember(&path, "A.B", "/bin/x", &file("two.3mf")).unwrap();
    let got = read_approvals(&path);
    assert!(is_approved(&got, "A.B", "/bin/x", &file("three.3mf")));
    assert!(!is_approved(&got, "A.B", "/bin/x", &none));
    assert!(!is_approved(&got, "A.B", "/bin/x", &strings(&["--run", "anything"])));
    assert!(!is_approved(&got, "A.B", "/bin/y", &file("one.3mf")));
    assert!(!is_approved(&got, "C.D", "/bin/x", &file("one.3mf")));
    assert_eq!(got["A.B"].len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_approval_file_that_named_programs_only_approves_nothing() {
    let dir = std::env::temp_dir().join(format!("fundacad-approvals-old-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("launch-approvals.json");
    std::fs::write(&path, r#"{"A.B":["/bin/x"]}"#).unwrap();
    assert!(!is_approved(&read_approvals(&path), "A.B", "/bin/x", &[]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_approval_dialog_names_the_program_and_each_argument() {
    let got = approval_text("A.B", "/opt/slicer", &strings(&["--open", "/tmp/part.3mf"]));
    assert!(got.contains("A.B"), "{got}");
    assert!(got.contains("/opt/slicer"), "{got}");
    assert!(got.contains("--open"), "{got}");
    assert!(got.contains("/tmp/part.3mf"), "{got}");
    assert!(approval_text("A.B", "/opt/slicer", &[]).contains("no arguments"));
    let split = approval_text("A.B", "/opt/slicer", &strings(&["one\n\nAllow two"]));
    assert!(!split.contains("one\n"), "{split}");
}

#[test]
fn picks_the_first_absolute_file_that_exists() {
    let dir = std::env::temp_dir().join(format!("fundacad-launch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let real = dir.join("tool.bin");
    std::fs::write(&real, b"x").unwrap();
    let missing = text(dir.join("missing.bin"));
    let got = first_program(&[missing, "tool.bin".into(), text(dir.clone()), text(real.clone())]);
    assert_eq!(got, Some(real));
    assert_eq!(first_program(&[]), None);
    let _ = std::fs::remove_dir_all(&dir);
}
