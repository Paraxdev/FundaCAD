use std::path::PathBuf;

use base64::Engine as _;
use fundacad_lib::thumbs::{get_all, get_one, prune, put, GET_CAP, MAX_BYTES};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("fundacad-thumbs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn jpeg(bytes: &[u8]) -> String {
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[test]
fn a_matching_stamp_serves_the_picture() {
    let dir = temp_dir("serve");
    let doc = dir.join("a.funda");
    std::fs::write(&doc, b"{}").unwrap();
    let doc = doc.to_str().unwrap().to_string();
    put(&dir.join("thumbs"), &doc, &jpeg(b"picture")).unwrap();
    assert_eq!(get_one(&dir.join("thumbs"), &doc), Some(jpeg(b"picture")));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_changed_document_gives_no_picture() {
    let dir = temp_dir("stale");
    let doc = dir.join("a.funda");
    std::fs::write(&doc, b"{}").unwrap();
    let path = doc.to_str().unwrap().to_string();
    put(&dir.join("thumbs"), &path, &jpeg(b"picture")).unwrap();
    std::fs::write(&doc, b"{\"features\":[]}").unwrap();
    assert_eq!(get_one(&dir.join("thumbs"), &path), None);
    assert_eq!(get_all(&dir.join("thumbs"), &["Z:/nowhere.funda".to_string()]), vec![None]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn only_small_jpeg_or_png_data_urls_are_taken() {
    let dir = temp_dir("reject");
    let doc = dir.join("a.funda");
    std::fs::write(&doc, b"{}").unwrap();
    let path = doc.to_str().unwrap();
    assert!(put(&dir, path, "data:text/html;base64,PGI+").is_err());
    assert!(put(&dir, path, "https://example.com/a.jpg").is_err());
    assert!(put(&dir, path, &jpeg(&vec![0u8; MAX_BYTES + 1])).is_err());
    assert!(put(&dir, path, "data:image/png;base64,AAAA").is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pruning_keeps_the_newest() {
    let dir = temp_dir("prune");
    for i in 0..5 {
        let doc = dir.join(format!("{i}.funda"));
        std::fs::write(&doc, b"{}").unwrap();
        put(&dir.join("thumbs"), doc.to_str().unwrap(), &jpeg(b"x")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    prune(&dir.join("thumbs"), 2);
    let left = std::fs::read_dir(dir.join("thumbs")).unwrap().count();
    assert_eq!(left, 4);
    assert!(get_one(&dir.join("thumbs"), dir.join("4.funda").to_str().unwrap()).is_some());
    assert!(get_one(&dir.join("thumbs"), dir.join("0.funda").to_str().unwrap()).is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_get_batch_is_capped() {
    let paths: Vec<String> = (0..GET_CAP + 5).map(|i| format!("Z:/{i}.funda")).collect();
    assert_eq!(get_all(&temp_dir("cap"), &paths).len(), GET_CAP);
}
