use fundacad_format::container::hash_bytes;
use fundacad_format::json_doc::*;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn tmpdir(tag: &str) -> PathBuf {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).unwrap();
    let d = std::env::temp_dir().join(format!("fundacad_jsondoc_{tag}_{}", u64::from_le_bytes(b)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn blob(dir: &Path, data: &[u8]) -> (String, BTreeMap<String, PathBuf>) {
    let h = hash_bytes(data);
    let p = dir.join(format!("{h}.src"));
    std::fs::write(&p, data).unwrap();
    (h.clone(), BTreeMap::from([(h, p)]))
}

fn pretty_doc(hash: &str) -> String {
    format!("{{\n  \"version\": 9,\n  \"features\": [\n    {{\n      \"id\": \"im\",\n      \"type\": \"import\",\n      \"geom\": \"{hash}\"\n    }}\n  ]\n}}")
}

#[test]
fn only_the_binary_extension_is_binary() {
    assert!(is_binary_doc_path(Path::new("a/part.fundab")));
    assert!(is_binary_doc_path(Path::new("PART.FUNDAB")));
    for p in ["part.funda", "part.neocad", "part.sindri", "part.json", "part", "fundab"] {
        assert!(!is_binary_doc_path(Path::new(p)), "{p}");
    }
}

#[test]
fn round_trips_its_geometry_and_keeps_the_text_readable() {
    let dir = tmpdir("rt");
    let data: Vec<u8> = (0..150_000u32).map(|i| (i.wrapping_mul(2246822519) >> 16) as u8).collect();
    let (h, blobs) = blob(&dir, &data);
    let doc = pretty_doc(&h);
    let dest = dir.join("part.funda");
    write_json_document(&dest, &doc, &blobs).unwrap();

    let text = std::fs::read_to_string(&dest).unwrap();
    assert!(text.starts_with(&doc[..doc.len() - 2]), "the frontend's text is kept as written");
    assert!(text.find("\"features\"").unwrap() < text.find("\"geometry\"").unwrap());

    let store = dir.join("blobs");
    let opened = read_json_document(&dest, &store).unwrap();
    let got: serde_json::Value = serde_json::from_str(&opened).unwrap();
    let want: serde_json::Value = serde_json::from_str(&doc).unwrap();
    assert_eq!(got, want, "the geometry map is removed, everything else survives");
    assert_eq!(std::fs::read(store.join(format!("{h}.bbrep"))).unwrap(), data);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn wrong_geometry_is_refused_and_nothing_is_published() {
    let dir = tmpdir("tamper");
    let data = vec![5u8; 9_000];
    let (h, blobs) = blob(&dir, &data);
    let dest = dir.join("part.funda");
    write_json_document(&dest, &pretty_doc(&h), &blobs).unwrap();
    let text = std::fs::read_to_string(&dest).unwrap();
    let at = text.find(&format!("\"{h}\": \"")).unwrap() + 40;
    let mut bytes = text.into_bytes();
    bytes[at] = if bytes[at] == b'A' { b'Q' } else { b'A' };
    std::fs::write(&dest, bytes).unwrap();

    let store = dir.join("blobs");
    let err = read_json_document(&dest, &store).unwrap_err();
    assert!(err.contains("does not match") || err.contains("damaged"), "unexpected: {err}");
    assert!(!store.join(format!("{h}.bbrep")).exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_document_without_geometry_is_passed_through_untouched() {
    let dir = tmpdir("plain");
    let dest = dir.join("part.funda");
    write_json_document(&dest, "{}", &BTreeMap::new()).unwrap();
    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "{\n}\n");
    let doc = "{\n  \"version\": 9,\n  \"features\": []\n}";
    write_json_document(&dest, doc, &BTreeMap::new()).unwrap();
    assert_eq!(read_json_document(&dest, &dir.join("blobs")).unwrap(), format!("{doc}\n"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_empty_object_still_gets_a_valid_geometry_map() {
    let dir = tmpdir("empty");
    let (h, blobs) = blob(&dir, b"payload");
    let dest = dir.join("part.funda");
    write_json_document(&dest, "{}", &blobs).unwrap();
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
    assert!(v["geometry"][&h].is_string());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn refuses_a_document_that_already_uses_the_key() {
    let dir = tmpdir("clash");
    let err = write_json_document(&dir.join("p.funda"), r#"{"geometry":1}"#, &BTreeMap::new()).unwrap_err();
    assert!(err.contains("already has"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_text_past_the_cap_is_refused() {
    let dir = tmpdir("cap_over");
    let path = dir.join("big.funda");
    std::fs::write(&path, "x".repeat(33)).unwrap();
    let err = read_text_capped(&path, 32).unwrap_err();
    assert!(err.contains("larger than"), "{err}");
}

#[test]
fn a_text_at_the_cap_is_read_whole() {
    let dir = tmpdir("cap_at");
    let path = dir.join("fit.funda");
    std::fs::write(&path, "y".repeat(32)).unwrap();
    assert_eq!(read_text_capped(&path, 32).unwrap(), "y".repeat(32));
}

struct Unreadable;

impl std::io::Read for Unreadable {
    fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("read"))
    }
}

#[test]
fn a_file_the_disk_reports_past_the_cap_is_refused_unread() {
    let cap = 3 << 20;
    let err = read_text_within(Unreadable, cap + 1, cap).unwrap_err();
    assert_eq!(err, "This document is larger than 3 MiB and was refused.");
}

#[test]
fn a_json_document_past_one_gib_is_refused_unread() {
    let dir = tmpdir("gib_open");
    let path = dir.join("huge.funda");
    std::fs::File::create(&path).unwrap().set_len((1 << 30) + 1).unwrap();
    let got = read_json_document(&path, &dir.join("blobs")).err();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(got.as_deref(), Some("This document is larger than 1024 MiB and was refused."));
}

#[test]
fn a_json_save_past_one_gib_is_refused_before_writing() {
    let dir = tmpdir("gib_save");
    let blob = dir.join("big.bbrep");
    std::fs::File::create(&blob).unwrap().set_len(800 << 20).unwrap();
    let dest = dir.join("p.funda");
    let blobs = BTreeMap::from([("0123456789abcdef0123456789abcdef".to_string(), blob)]);
    let got = write_json_document(&dest, "{}", &blobs).err();
    let written = dest.exists();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(
        (got.as_deref(), written),
        (
            Some(
                "This document is larger than the 1024 MiB a .funda file can hold. Save it as a .fundab file instead."
            ),
            false
        )
    );
}
