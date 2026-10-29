use std::path::Path;

use fundacad_mcp::write_target::extension_refusal;

#[test]
fn an_extension_in_the_list_passes_in_any_case() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["a.step", "a.STP", "a.Step"] {
        assert_eq!(extension_refusal(&dir.path().join(name), &["step", "stp"], "a step export"), None, "{name}");
    }
}

#[test]
fn any_other_ending_is_refused_and_the_reply_names_the_one_to_use() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["a.txt", "a", "a.step.cmd", "a.step.", "a.step ", ".step"] {
        let why = extension_refusal(&dir.path().join(name), &["step", "stp"], "a step export");
        let why = why.unwrap_or_else(|| panic!("{name:?} passed"));
        assert!(why.contains("a step export writes only .step or .stp files"), "{why}");
        assert!(why.contains("Give a path ending in .step."), "{why}");
    }
}

#[test]
fn a_path_whose_folder_does_not_exist_is_judged_by_its_name() {
    assert_eq!(extension_refusal(Path::new("/no/such/dir/out.funda"), &["funda"], "doc_save"), None);
    assert!(extension_refusal(Path::new("/no/such/dir/out.txt"), &["funda"], "doc_save").is_some());
}
