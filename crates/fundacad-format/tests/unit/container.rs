use fundacad_format::container::*;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad_container_{tag}_{}", random_hex()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn random_hex() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).unwrap();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn blob(dir: &Path, name: &str, data: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, data).unwrap();
    p
}

/// The blob store is addressed by content hash, so if Rust and the Python engine ever disagree every reference
/// dangles. The Python engine's `test_blobstore.py` pins the same vectors.
#[test]
fn hash_matches_python() {
    assert_eq!(hash_bytes(b""), "cae66941d9efbd404e4d88758ea67670");
    assert_eq!(hash_bytes(b"fundacad"), "5648909c8c0ccf6096c0e672255e68a0");
    assert_eq!(hash_bytes(&[0x00u8, 0xff].repeat(8)), "2a7271a37f134cb3bfb8ff7e507e0da7");
    assert_eq!(hash_bytes(b"x").len(), 32, "blake2b-128 as hex");
}

#[test]
fn roundtrip_preserves_bytes_exactly() {
    let dir = tmpdir("rt");
    // One incompressible blob and one that deflates ~1000x, so both sides of
    // the compression path are covered.
    let a: Vec<u8> = (0..200_000u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
    let b = vec![0u8; 500_000];
    let (ha, hb) = (hash_bytes(&a), hash_bytes(&b));

    let mut blobs = BTreeMap::new();
    blobs.insert(ha.clone(), blob(&dir, "a.bin", &a));
    blobs.insert(hb.clone(), blob(&dir, "b.bin", &b));
    let mut meshes = BTreeMap::new();
    meshes.insert("deadbeef-t0".to_string(), blob(&dir, "m.bin", b"MESHDATA".repeat(1000).as_slice()));

    let doc = format!(r#"{{"version":5,"features":[{{"type":"import","geom":"{ha}"}}]}}"#);
    let dest = dir.join("part.funda");
    write_zip_container(&dest, &doc, &blobs, &meshes, "test").unwrap();

    assert!(looks_like_container(&dest), "written file is a zip");

    // The manifest must be first AND stored, or a minimal reader needs a
    // decompressor just to learn the format version.
    {
        let mut z = zip::ZipArchive::new(File::open(&dest).unwrap()).unwrap();
        assert_eq!(z.by_index(0).unwrap().name(), "manifest.json");
        assert_eq!(z.by_name("manifest.json").unwrap().compression(), zip::CompressionMethod::Stored);
        assert!(
            z.by_name(&format!("geom/{hb}.bbrep")).unwrap().compressed_size() < 500_000,
            "the compressible blob should actually have shrunk"
        );
    }

    let out = dir.join("blobs");
    let meshes_out = dir.join("meshes");
    let (got_doc, manifest) = read_container(&dest, &out, Some(&meshes_out)).unwrap();

    assert_eq!(got_doc, doc, "document survives byte-for-byte");
    assert_eq!(manifest.container, CONTAINER_VERSION);
    assert_eq!(std::fs::read(out.join(format!("{ha}.bbrep"))).unwrap(), a);
    assert_eq!(std::fs::read(out.join(format!("{hb}.bbrep"))).unwrap(), b);
    assert!(meshes_out.join("deadbeef-t0.bin").exists());

    // Meshes are a cache: the same container must open fine without them.
    let out2 = dir.join("blobs2");
    let (got2, _) = read_container(&dest, &out2, None).unwrap();
    assert_eq!(got2, doc);

    // Re-reading is idempotent, not a duplicate-write, and leaves no litter.
    read_container(&dest, &out, Some(&meshes_out)).unwrap();
    let names: Vec<_> =
        std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert_eq!(names.len(), 2, "re-read did not duplicate: {names:?}");
    assert!(!names.iter().any(|n| n.contains(".tmp-")), "temp files left: {names:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

/// The case that must never pass silently: a valid zip and manifest with wrong bytes, which nothing else in the
/// stack would notice before showing the wrong shape.
#[test]
fn tampered_geometry_is_refused_and_nothing_is_published() {
    let dir = tmpdir("tamper");
    let data = vec![7u8; 50_000];
    let h = hash_bytes(&data);
    let mut blobs = BTreeMap::new();
    blobs.insert(h.clone(), blob(&dir, "d.bin", &data));
    let good = dir.join("ok.funda");
    write_zip_container(&good, r#"{"version":5}"#, &blobs, &BTreeMap::new(), "t").unwrap();

    let tampered = dir.join("bad.funda");
    {
        let mut zin = zip::ZipArchive::new(File::open(&good).unwrap()).unwrap();
        let mut zout = zip::ZipWriter::new(File::create(&tampered).unwrap());
        let opts = SimpleFileOptions::default();
        for i in 0..zin.len() {
            let mut e = zin.by_index(i).unwrap();
            let name = e.name().to_string();
            let mut payload = Vec::new();
            e.read_to_end(&mut payload).unwrap();
            if name.starts_with("geom/") {
                payload = vec![9u8; payload.len()]; // same size, different bytes
            }
            zout.start_file(&name, opts).unwrap();
            zout.write_all(&payload).unwrap();
        }
        zout.finish().unwrap();
    }

    let out = dir.join("blobs");
    let err = read_container(&tampered, &out, None).unwrap_err();
    assert!(err.contains("does not match"), "unexpected message: {err}");
    assert!(!out.join(format!("{h}.bbrep")).exists(), "a mismatching blob must never be published");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn truncated_file_is_refused_not_crashed_on() {
    let dir = tmpdir("trunc");
    let data = vec![3u8; 50_000];
    let mut blobs = BTreeMap::new();
    blobs.insert(hash_bytes(&data), blob(&dir, "d.bin", &data));
    let good = dir.join("ok.funda");
    write_zip_container(&good, r#"{"version":5}"#, &blobs, &BTreeMap::new(), "t").unwrap();

    let whole = std::fs::read(&good).unwrap();
    let trunc = dir.join("trunc.funda");
    std::fs::write(&trunc, &whole[..whole.len() / 2]).unwrap();

    assert!(read_container(&trunc, &dir.join("blobs"), None).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_write_leaves_the_previous_file_intact() {
    let dir = tmpdir("atomic");
    let dest = dir.join("part.funda");
    std::fs::write(&dest, b"PREVIOUS GOOD FILE").unwrap();

    let mut blobs = BTreeMap::new();
    blobs.insert("deadbeef".to_string(), PathBuf::from("/nonexistent/x"));
    assert!(write_zip_container(&dest, r#"{"version":5}"#, &blobs, &BTreeMap::new(), "t").is_err());

    assert_eq!(std::fs::read(&dest).unwrap(), b"PREVIOUS GOOD FILE");
    let litter: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n.contains(".tmp-"))
        .collect();
    assert!(litter.is_empty(), "temp files left behind: {litter:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_newer_container_version_says_so_plainly() {
    let dir = tmpdir("newer");
    let p = dir.join("newer.funda");
    {
        let mut z = zip::ZipWriter::new(File::create(&p).unwrap());
        z.start_file("manifest.json", SimpleFileOptions::default()).unwrap();
        let m = format!(r#"{{"container":{},"hashAlg":"{}","blobs":[],"meshes":[]}}"#, CONTAINER_VERSION + 1, HASH_ALG);
        z.write_all(m.as_bytes()).unwrap();
        z.finish().unwrap();
    }
    let err = read_manifest(&p).unwrap_err();
    assert!(err.contains("Update FundaCAD"), "unexpected message: {err}");
    let _ = std::fs::remove_dir_all(&dir);
}

fn pretty_doc(hash: &str) -> String {
    format!("{{\n  \"version\": 9,\n  \"features\": [\n    {{\n      \"id\": \"im\",\n      \"type\": \"import\",\n      \"geom\": \"{hash}\"\n    }}\n  ]\n}}")
}

#[test]
fn extension_picks_the_format() {
    let dir = tmpdir("ext");
    let data: Vec<u8> = (0..70_000u32).map(|i| (i.wrapping_mul(2654435761) >> 20) as u8).collect();
    let h = hash_bytes(&data);
    let blobs = BTreeMap::from([(h.clone(), blob(&dir, "g.bin", &data))]);
    let doc = pretty_doc(&h);

    let json = dir.join("part.funda");
    let bin = dir.join("part.FundaB");
    write_document(&json, &doc, &blobs, &BTreeMap::new(), &[], "t").unwrap();
    write_document(&bin, &doc, &blobs, &BTreeMap::new(), &[], "t").unwrap();

    assert!(!looks_like_container(&json));
    assert!(fundacad_format::fnda::looks_like_fnda(&bin));
    let text = std::fs::read_to_string(&json).unwrap();
    assert!(text.starts_with(&doc[..doc.len() - 2]), "the frontend's text is kept as written");
    assert!(text.find("\"features\"").unwrap() < text.find("\"geometry\"").unwrap());
    assert!(std::fs::metadata(&bin).unwrap().len() < std::fs::metadata(&json).unwrap().len());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_legacy_plain_json_document_is_not_mistaken_for_a_container() {
    let dir = tmpdir("legacy");
    let p = dir.join("legacy.funda");
    std::fs::write(&p, br#"{"version": 4, "features": []}"#).unwrap();
    assert!(!looks_like_container(&p));
    assert!(read_manifest(&p).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_document_held_as_bytes_publishes_its_geometry_like_one_opened_by_path() {
    let dir = tmpdir("bytes");
    let data: Vec<u8> = (0..50_000u32).map(|i| (i.wrapping_mul(2654435761) >> 24) as u8).collect();
    let h = hash_bytes(&data);
    let blobs = BTreeMap::from([(h.clone(), blob(&dir, "g.bin", &data))]);
    let doc = format!(r#"{{"version":9,"features":[{{"id":"im","type":"import","geom":"{h}"}}]}}"#);

    for (name, binary) in [("part.funda", false), ("part.fundab", true)] {
        let dest = dir.join(name);
        write_document(&dest, &doc, &blobs, &BTreeMap::new(), &[], "test").unwrap();
        let store = dir.join(format!("store-{name}"));
        let opened = open_document_bytes(&std::fs::read(&dest).unwrap(), &store, None, None).unwrap();
        let got: serde_json::Value = serde_json::from_str(&opened.document).unwrap();
        let want: serde_json::Value = serde_json::from_str(&doc).unwrap();
        assert_eq!(got, want, "{name}: the document without its geometry map");
        assert_eq!(opened.was_container, binary, "{name}");
        assert_eq!(std::fs::read(store.join(format!("{h}.bbrep"))).unwrap(), data, "{name}: geometry published");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_section_this_version_does_not_read_survives_a_save_as_fundab_only() {
    let dir = tmpdir("carried");
    let payload: Vec<u8> = (0..3000u32).map(|i| (i % 253) as u8).collect();
    let doc = r#"{"version":11,"features":[]}"#;
    let info = fundacad_format::fnda::json_to_cbor("{}").unwrap();
    let cbor = fundacad_format::fnda::json_to_cbor(doc).unwrap();
    let (b, m) = (BTreeMap::new(), BTreeMap::new());
    let mut sections = fundacad_format::fnda::document_sections(&info, &cbor, &b, &m, &[]);
    sections.push(fundacad_format::fnda::SectionSpec {
        kind: 9,
        name: "futureIndex".into(),
        source: fundacad_format::fnda::Source::Bytes(&payload),
        layout: fundacad_format::fnda::SMALL_LAYOUT,
    });
    let src = dir.join("future.fundab");
    fundacad_format::fnda::write(&mut File::create(&src).unwrap(), &sections).unwrap();

    let carry = dir.join("sections");
    let opened = open_document_full(&src, &dir.join("blobs"), None, Some(&carry)).unwrap();
    assert_eq!(opened.carried.len(), 1);
    let carried: Vec<_> = opened.carried.iter().map(|c| (c.clone(), carry.join(format!("{}.bin", c.hash)))).collect();

    let bin = dir.join("again.fundab");
    let json = dir.join("again.funda");
    write_document(&bin, &opened.document, &b, &m, &carried, "t").unwrap();
    write_document(&json, &opened.document, &b, &m, &carried, "t").unwrap();
    let again = open_document_full(&bin, &dir.join("blobs"), None, Some(&dir.join("sections2"))).unwrap();
    assert_eq!(again.carried, opened.carried);
    assert_eq!(std::fs::read(dir.join("sections2").join(format!("{}.bin", again.carried[0].hash))).unwrap(), payload);
    assert!(open_document_full(&json, &dir.join("blobs"), None, Some(&carry)).unwrap().carried.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
