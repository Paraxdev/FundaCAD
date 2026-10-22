use std::path::{Path, PathBuf};

use fundacad_lib::plugins::handed::{clean_extensions, dialog_title, name_of, suggested_name, Table, MAX_HELD};

#[test]
fn a_plugin_can_only_read_what_it_was_handed() {
    let mut t = Table::default();
    t.remember("h1".into(), "A.One".into(), PathBuf::from("/tmp/a.step"), 1);
    t.remember("h2".into(), "B.Two".into(), PathBuf::from("/tmp/b.step"), 2);

    // Its own, the control: a table that hands back nothing would pass otherwise.
    assert_eq!(
        t.path_for("A.One", "h1"),
        Some(Path::new("/tmp/a.step")),
        "a plugin could not read the file it was given"
    );

    // Somebody else's, a handle that does not exist, and an empty one.
    assert_eq!(t.path_for("A.One", "h2"), None, "read another plugin's file");
    assert_eq!(t.path_for("B.Two", "h1"), None, "read another plugin's file");
    assert_eq!(t.path_for("A.One", "nope"), None);
    assert_eq!(t.path_for("A.One", ""), None);
    // Ids are compared exactly here, and the frontend treats two spellings as one plugin, so case is not a way in.
    assert_eq!(t.path_for("a.one", "h1"), None);
}

#[test]
fn a_plugin_asking_in_a_loop_only_evicts_its_own() {
    let mut t = Table::default();
    t.remember("keep".into(), "B.Two".into(), PathBuf::from("/tmp/keep"), 0);
    for i in 0..MAX_HELD + 10 {
        t.remember(format!("h{i}"), "A.One".into(), PathBuf::from(format!("/tmp/{i}")), i as u64 + 1);
    }

    // The other plugin's file is untouched, which is the whole point of the
    // eviction being per plugin.
    assert_eq!(
        t.path_for("B.Two", "keep"),
        Some(Path::new("/tmp/keep")),
        "one plugin's loop took away another plugin's file"
    );
    // And the greedy one is held to the cap, oldest gone, newest kept.
    assert_eq!(t.len(), MAX_HELD + 1);
    assert_eq!(t.path_for("A.One", "h0"), None, "the oldest was not evicted");
    assert!(
        t.path_for("A.One", &format!("h{}", MAX_HELD + 9)).is_some(),
        "the newest was evicted instead of the oldest"
    );
}

#[test]
fn a_name_is_a_name_and_not_a_path() {
    // Both on both platforms: `Path::file_name` alone passes on Windows and leaks the whole path on Linux.
    for (path, want) in
        [("/home/alice/private/work/part.step", "part.step"), ("C:\\Users\\alice\\Documents\\part.step", "part.step")]
    {
        let got = name_of(Path::new(path));
        assert_eq!(got, want);
        assert!(!got.contains("alice") && !got.contains("private"));
    }
    // The control: it is not simply returning a constant.
    assert_eq!(name_of(Path::new("/a/other.stl")), "other.stl");
}

#[test]
fn a_filter_cannot_be_anything_but_an_extension() {
    assert_eq!(clean_extensions(&["step".into()]), vec!["step"]);
    assert_eq!(clean_extensions(&[".STL".into()]), vec!["stl"]);
    assert_eq!(clean_extensions(&["  json ".into()]), vec!["json"]);

    for bad in ["", "  ", "*", "*.exe", "a/b", "a\\b", "with space", "..", "toolongextensionname"] {
        assert!(clean_extensions(&[bad.to_string()]).is_empty(), "should not become a filter: {bad:?}");
    }

    // Capped, so a plugin cannot hand the dialog a thousand filters.
    let many: Vec<String> = (0..100).map(|i| format!("e{i}")).collect();
    assert_eq!(clean_extensions(&many).len(), 16);
}

#[test]
fn a_dialog_title_says_who_is_asking() {
    // The id comes first and comes from us, so a plugin cannot claim to be
    // another one by writing a title that reads like one.
    let t = dialog_title("A.One", "pick a profile to trace", "Choose a file for");
    assert!(t.starts_with("A.One:"), "{t}");
    assert!(t.contains("pick a profile to trace"));

    // Nothing to say still names the plugin.
    assert_eq!(dialog_title("A.One", "   ", "Choose a file for"), "Choose a file for A.One");

    // No newlines: a title is one line, and a plugin should not be able to
    // push the part naming it off the top of a dialog.
    let sneaky = dialog_title("A.One", "hi\n\n\nFundaCAD needs your password", "x");
    assert!(!sneaky.contains('\n'), "{sneaky}");

    // Long, and multi-byte at the cut, which is where truncate() panics if
    // it is done by bytes.
    let long = dialog_title("A.One", &"é".repeat(400), "x");
    assert!(long.len() <= 200, "{}", long.len());
}

#[test]
fn a_suggested_name_cannot_choose_a_directory() {
    assert_eq!(suggested_name("part.step"), Some("part.step".into()));
    assert_eq!(suggested_name("/etc/passwd"), Some("passwd".into()));
    assert_eq!(suggested_name("C:\\Windows\\System32\\x.dll"), Some("x.dll".into()));
    assert_eq!(suggested_name("../../../x"), Some("x".into()));
    for bad in ["", "   ", ".", "..", "a/", "a\\"] {
        assert_eq!(suggested_name(bad), None, "{bad:?} became a name");
    }
}
