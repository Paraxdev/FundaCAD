use std::ffi::OsString;
use std::path::PathBuf;

use serde_json::json;

use super::{dir_from, Store, FILE};

pub(crate) fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-app-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn the_env_folder_wins_over_the_os_one() {
    let os = Some(PathBuf::from("C:/os/config"));
    assert_eq!(dir_from(Some(OsString::from("D:/elsewhere")), os.clone()), Some(PathBuf::from("D:/elsewhere")));
    assert_eq!(dir_from(None, os.clone()), Some(PathBuf::from("C:/os/config/FundaCAD 2")));
    assert_eq!(dir_from(Some(OsString::new()), os), Some(PathBuf::from("C:/os/config/FundaCAD 2")));
    assert_eq!(dir_from(None, None), None);
}

#[test]
fn values_survive_a_reload_and_unknown_keys_are_kept() {
    let dir = temp_dir("roundtrip");
    std::fs::write(dir.join(FILE), r#"{"fromNewer": {"a": 7}}"#).unwrap();
    let mut store = Store::load(Some(&dir));
    store.set("recent", &vec!["D:/a.funda".to_string(), "E:/b.funda".to_string()]).unwrap();
    store.set("count", &-3.25).unwrap();

    let again = Store::load(Some(&dir));
    assert_eq!(again.get::<Vec<String>>("recent"), Some(vec!["D:/a.funda".into(), "E:/b.funda".into()]));
    assert_eq!(again.get::<f64>("count"), Some(-3.25));
    assert_eq!(again.get::<serde_json::Value>("fromNewer"), Some(json!({"a": 7})));
    assert_eq!(again.get::<String>("count"), None);
    assert_eq!(again.get::<f64>("missing"), None);
    assert!(!dir.join("settings.json.tmp").exists());
}

#[test]
fn a_missing_file_is_empty_and_a_bad_one_is_moved_aside() {
    let dir = temp_dir("bad");
    assert_eq!(Store::load(Some(&dir)).values.len(), 0);

    std::fs::write(dir.join(FILE), "[1, 2").unwrap();
    let mut store = Store::load(Some(&dir));
    assert_eq!(store.values.len(), 0);
    assert_eq!(std::fs::read_to_string(dir.join("settings.json.bad")).unwrap(), "[1, 2");
    store.set("k", &1).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), "{\n  \"k\": 1\n}");
}

#[test]
fn a_store_without_a_folder_keeps_values_in_memory() {
    let mut store = Store::load(None);
    store.set("k", &"v").unwrap();
    assert_eq!(store.get::<String>("k"), Some("v".into()));
}
