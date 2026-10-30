use fundacad_engine::sandbox::stage::{stage, Staged};
use fundacad_protocol::envelope;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let root = std::env::temp_dir().join(format!("fcd-stage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("stage")).unwrap();
        fs::create_dir_all(root.join("user")).unwrap();
        Scratch(root)
    }
    fn stage(&self) -> PathBuf {
        self.0.join("stage")
    }
    fn user(&self, name: &str) -> PathBuf {
        self.0.join("user").join(name)
    }
    fn users_files(&self) -> Vec<String> {
        names(&self.0.join("user"))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> =
        fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    out.sort();
    out
}

fn export(target: &Path, separate: bool, dir: &Path) -> Staged {
    let text = json!({"id": "x1", "op": "export", "path": target, "separate": separate}).to_string();
    stage(&text, dir).unwrap().unwrap()
}

fn answer(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn a_finished_export_replaces_the_users_file_and_names_it() {
    let s = Scratch::new("file");
    let target = s.user("Bracket.step");
    fs::write(&target, "old").unwrap();
    let staged = export(&target, false, &s.stage());
    fs::write(s.stage().join("Bracket.step"), "ISO-10303-21").unwrap();
    let reply = envelope::ok(&json!("x1"), &json!({"path": s.stage().join("Bracket.step"), "warnings": []}));
    let out = answer(&staged.finish(&reply));
    assert_eq!((&out["id"], &out["ok"]), (&json!("x1"), &json!(true)));
    assert_eq!(out["result"], json!({"path": target, "warnings": []}));
    assert_eq!(fs::read_to_string(&target).unwrap(), "ISO-10303-21");
    assert_eq!(s.users_files(), ["Bracket.step"]);
}

#[test]
fn a_separate_export_copies_each_body_into_a_new_folder() {
    let s = Scratch::new("folder");
    let staged = export(&s.user("Lamp.stl"), true, &s.stage());
    let base = s.stage().join("Lamp");
    fs::create_dir(&base).unwrap();
    for n in ["Shade.stl", "Foot.stl"] {
        fs::write(base.join(n), n).unwrap();
    }
    let reply =
        envelope::ok(&json!("x1"), &json!({"path": base, "paths": [base.join("Shade.stl"), base.join("Foot.stl")]}));
    let out = answer(&staged.finish(&reply));
    let real = s.user("Lamp");
    assert_eq!(out["result"]["path"], json!(real));
    assert_eq!(out["result"]["paths"], json!([real.join("Shade.stl"), real.join("Foot.stl")]));
    assert_eq!(fs::read_to_string(real.join("Foot.stl")).unwrap(), "Foot.stl");
    assert_eq!(names(&real), ["Foot.stl", "Shade.stl"]);
}

#[test]
fn a_separate_export_never_writes_into_a_folder_that_exists() {
    let s = Scratch::new("exists");
    fs::create_dir(s.user("Lamp")).unwrap();
    let staged = export(&s.user("Lamp.stl"), true, &s.stage());
    let base = s.stage().join("Lamp");
    fs::create_dir(&base).unwrap();
    fs::write(base.join("Shade.stl"), "solid").unwrap();
    let reply = envelope::ok(&json!("x1"), &json!({"path": base, "paths": [base.join("Shade.stl")]}));
    let out = answer(&staged.finish(&reply));
    assert_eq!((&out["id"], &out["ok"]), (&json!("x1"), &json!(false)));
    let message = out["error"]["message"].as_str().unwrap();
    assert!(message.starts_with("Lamp already exists, the separate-bodies export"), "{message}");
    assert!(names(&s.user("Lamp")).is_empty());
}

#[test]
fn a_failed_or_cancelled_export_copies_nothing() {
    let s = Scratch::new("failed");
    let staged = export(&s.user("a.step"), false, &s.stage());
    fs::write(s.stage().join("a.step"), "half").unwrap();
    let message = format!("could not write {}: disk full", s.stage().join("a.step").display());
    let out = answer(&staged.finish(&envelope::err(&json!("x1"), &message, None)));
    let shown = format!("could not write {}: disk full", s.user("a.step").display());
    assert_eq!(out["error"]["message"], json!(shown));
    let out = answer(&staged.finish(&envelope::cancelled(&json!("x1"))));
    assert_eq!(out["cancelled"], json!(true));
    assert!(s.users_files().is_empty());
}

#[test]
fn a_reply_without_the_staged_file_becomes_an_error_and_leaves_nothing() {
    let s = Scratch::new("missing");
    let staged = export(&s.user("a.step"), false, &s.stage());
    fs::write(s.stage().join("b.step"), "other").unwrap();
    for path in [s.stage().join("a.step"), s.stage().join("b.step")] {
        let out = answer(&staged.finish(&envelope::ok(&json!("x1"), &json!({ "path": path }))));
        assert_eq!(out["ok"], json!(false), "{path:?}");
        assert!(s.users_files().is_empty(), "{path:?}");
    }
}

#[test]
fn a_link_in_the_stage_is_not_followed() {
    let s = Scratch::new("link");
    let secret = s.0.join("secret.txt");
    fs::write(&secret, "private").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&secret, s.stage().join("a.step")).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_file(&secret, s.stage().join("a.step")).is_err() {
        return; // Making a link needs Developer Mode on Windows.
    }
    let staged = export(&s.user("a.step"), false, &s.stage());
    let out = answer(&staged.finish(&envelope::ok(&json!("x1"), &json!({"path": s.stage().join("a.step")}))));
    assert_eq!(out["ok"], json!(false));
    assert!(s.users_files().is_empty());
}
