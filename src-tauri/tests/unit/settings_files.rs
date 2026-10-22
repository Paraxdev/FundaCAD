use std::path::PathBuf;

use fundacad_lib::settings_files::check_settings;

fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-settings-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn an_unreadable_settings_file_is_renamed_with_the_time() {
    let d = dir("bad");
    let plugins = d.join("plugins");
    std::fs::create_dir_all(plugins.join("good")).unwrap();
    std::fs::create_dir_all(plugins.join("broken")).unwrap();
    std::fs::write(d.join("launch-approvals.json"), "{\"a\": [").unwrap();
    std::fs::write(plugins.join("good/installed.json"), "{\"id\":\"good\"}").unwrap();
    std::fs::write(plugins.join("broken/installed.json"), "").unwrap();

    let moved = check_settings(&d, &plugins, "installed.json");
    assert_eq!(moved.len(), 2, "{moved:?}");
    assert!(!d.join("launch-approvals.json").exists());
    assert!(!plugins.join("broken/installed.json").exists());
    assert_eq!(std::fs::read_to_string(plugins.join("good/installed.json")).unwrap(), "{\"id\":\"good\"}");
    let name = moved[0].file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("launch-approvals.json.bad-"), "{name}");
    assert_eq!(std::fs::read_to_string(&moved[0]).unwrap(), "{\"a\": [");
    assert!(check_settings(&d, &plugins, "installed.json").is_empty());
}
