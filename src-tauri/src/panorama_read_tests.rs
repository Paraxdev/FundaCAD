use super::*;
use std::path::PathBuf;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-panorama-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn vouched(path: &Path) -> (Provenance, String) {
    let raw = path.to_str().unwrap().to_string();
    let held = Provenance::default();
    held.vouch_all([raw.as_str()]);
    (held, raw)
}

#[test]
fn a_vouched_small_hdr_is_returned_byte_for_byte() {
    let dir = scratch("ok");
    let file = dir.join("sky.hdr");
    let body: Vec<u8> = (0..=255).collect();
    std::fs::write(&file, &body).unwrap();
    let (held, raw) = vouched(&file);
    assert_eq!(read_panorama(&held, &raw, 1024).unwrap(), body);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_exr_in_capitals_counts_as_a_panorama() {
    let dir = scratch("caps");
    let file = dir.join("SKY.EXR");
    std::fs::write(&file, b"x").unwrap();
    let (held, raw) = vouched(&file);
    assert_eq!(read_panorama(&held, &raw, 1024).unwrap(), b"x");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_local_path_nobody_handed_over_is_refused() {
    let dir = scratch("unvouched");
    let file = dir.join("sky.hdr");
    std::fs::write(&file, b"x").unwrap();
    let err = read_panorama(&Provenance::default(), file.to_str().unwrap(), 1024).unwrap_err();
    assert!(err.contains("not dropped or picked"), "{err}");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn any_other_extension_is_refused_even_when_vouched() {
    let dir = scratch("ext");
    for name in ["notes.txt", "sky.hdr.png", "sky"] {
        let file = dir.join(name);
        std::fs::write(&file, b"x").unwrap();
        let (held, raw) = vouched(&file);
        let err = read_panorama(&held, &raw, 1024).unwrap_err();
        assert!(err.contains("not an .hdr or .exr"), "{name}: {err}");
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_file_over_the_cap_is_refused() {
    let dir = scratch("big");
    let file = dir.join("sky.hdr");
    std::fs::write(&file, vec![0u8; 2 * 1024 * 1024 + 1]).unwrap();
    let (held, raw) = vouched(&file);
    let err = read_panorama(&held, &raw, 2 * 1024 * 1024).unwrap_err();
    assert!(err.contains("larger than 2 MB"), "{err}");
    assert!(read_panorama(&held, &raw, 2 * 1024 * 1024 + 1).is_ok());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_folder_named_like_a_panorama_is_refused() {
    let dir = scratch("folder");
    let sub = dir.join("sky.hdr");
    std::fs::create_dir_all(&sub).unwrap();
    let (held, raw) = vouched(&sub);
    assert!(read_panorama(&held, &raw, 1024).unwrap_err().contains("not a file"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_missing_file_is_refused_with_the_reason() {
    let dir = scratch("gone");
    let (held, raw) = vouched(&dir.join("gone.hdr"));
    assert!(read_panorama(&held, &raw, 1024).is_err());
    let _ = std::fs::remove_dir_all(dir);
}
