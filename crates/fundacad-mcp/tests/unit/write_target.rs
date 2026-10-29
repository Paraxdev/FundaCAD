use std::path::Path;

use fundacad_mcp::write_target::{extension_refusal, looks_like, overwrite_refusal};

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

fn binary_stl(triangles: u32, extra: u64) -> (Vec<u8>, u64) {
    let mut head = vec![0u8; 84];
    head[80..84].copy_from_slice(&triangles.to_le_bytes());
    (head, 84 + 50 * u64::from(triangles) + extra)
}

#[test]
fn each_kind_is_told_by_its_first_bytes() {
    let funda: &[&str] = &["funda"];
    let step: &[&str] = &["step", "stp"];
    let (stl, three, dxf, svg): (&[&str], &[&str], &[&str], &[&str]) = (&["stl"], &["3mf"], &["dxf"], &["svg"]);
    let cases: &[(&[&str], &[u8], bool)] = &[
        (funda, b"{\n  \"version\": 3", true),
        (funda, b"\xEF\xBB\xBF \r\n{", true),
        (funda, b"FUNDACAD\x01\x00", true),
        (funda, b"PK\x03\x04", true),
        (funda, b"keep me", false),
        (funda, b"@echo off", false),
        (step, b"ISO-10303-21;\nHEADER;", true),
        (step, b"\n ISO-10303-21;", true),
        (step, b"solid box", false),
        (stl, b"solid box\n", true),
        (stl, b"  solid", true),
        (stl, b"ISO-10303-21;", false),
        (three, b"PK\x03\x04", true),
        (three, b"<?xml version", false),
        (dxf, b"  0\nSECTION", true),
        (dxf, b"0\r\nSECTION", true),
        (dxf, b"999\nmade by hand", true),
        (dxf, b"AutoCAD Binary DXF\r\n\x1a\x00", true),
        (dxf, b"10\n", false),
        (dxf, b"keep me", false),
        (svg, b"<?xml version=\"1.0\"?>\n<svg xmlns", true),
        (svg, b"<SVG", true),
        (svg, b"<?xml version=\"1.0\"?><html>", false),
    ];
    for (exts, head, want) in cases {
        let len = head.len() as u64;
        assert_eq!(looks_like(exts, head, len), *want, "{exts:?} {:?}", String::from_utf8_lossy(head));
    }
}

#[test]
fn a_binary_stl_is_told_by_its_triangle_count_and_length() {
    let (head, len) = binary_stl(3, 0);
    assert!(looks_like(&["stl"], &head, len));
    let (head, len) = binary_stl(3, 1);
    assert!(!looks_like(&["stl"], &head, len));
    assert!(!looks_like(&["stl"], &head[..60], 60));
}

#[test]
fn only_a_file_of_another_kind_is_kept_from_being_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("x.funda");
    assert_eq!(overwrite_refusal(&path, &["funda"], "doc_save"), None, "nothing there yet");
    std::fs::write(&path, "").unwrap();
    assert_eq!(overwrite_refusal(&path, &["funda"], "doc_save"), None, "an empty file");
    std::fs::write(&path, "{\"version\": 3}").unwrap();
    assert_eq!(overwrite_refusal(&path, &["funda"], "doc_save"), None, "a .funda file");
    std::fs::write(&path, "keep me").unwrap();
    let why = overwrite_refusal(&path, &["funda"], "doc_save").expect("plain text was let through");
    assert!(why.contains("does not read as a .funda file") && why.contains("overwrite: true"), "{why}");
    assert_eq!(overwrite_refusal(dir.path(), &["funda"], "doc_save"), None, "a folder is the caller's refusal");
}
