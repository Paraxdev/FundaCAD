use fundacad_lib::mcp_switch::{enabled, set, FILE};
use std::path::PathBuf;

fn dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-mcp-switch-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn it_is_on_until_turned_off() {
    assert!(enabled(&dir("fresh")));
}

#[test]
fn off_is_kept_and_on_leaves_no_file() {
    let d = dir("round");
    set(&d, false).unwrap();
    assert!(!enabled(&d));
    assert!(!d.join(format!("{FILE}.part")).exists());
    set(&d, true).unwrap();
    assert!(enabled(&d));
    assert!(!d.join(FILE).exists());
    set(&d, true).unwrap();
}

#[test]
fn off_makes_the_data_folder_on_a_first_run() {
    let d = dir("first").join("not-yet");
    set(&d, false).unwrap();
    assert!(!enabled(&d));
}

#[test]
fn only_a_plain_false_turns_it_off() {
    let d = dir("odd");
    for (text, on) in [
        ("{\"enabled\":false}", false),
        ("{\"enabled\":true}", true),
        ("{\"enabled\":\"false\"}", true),
        ("{\"enabled\":0}", true),
        ("{}", true),
        ("[false]", true),
        ("{\"enabled\":fal", true),
        ("", true),
    ] {
        std::fs::write(d.join(FILE), text).unwrap();
        assert_eq!(enabled(&d), on, "{text:?}");
    }
}
