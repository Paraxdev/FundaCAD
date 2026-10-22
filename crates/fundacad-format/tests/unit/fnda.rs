use blake2::digest::consts::U16;
use blake2::{Blake2b, Digest};
use fundacad_format::fnda::*;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::Cursor;
use std::path::{Path, PathBuf};

type Blake2b128 = Blake2b<U16>;

fn tmpdir(tag: &str) -> PathBuf {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).unwrap();
    let d = std::env::temp_dir().join(format!("fundacad_fnda_{tag}_{}", hex(&b)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn sample(dir: &Path) -> (PathBuf, String, Vec<u8>) {
    let doc = r#"{"version":9,"parameters":{"w":12.5},"features":[{"id":"f1","type":"box","length":10,"width":20,"height":5,"name":"Base"}]}"#;
    let geometry: Vec<u8> = (0..300_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    let hash = {
        let mut h = Blake2b128::new();
        h.update(&geometry);
        hex(&h.finalize())
    };
    let blob = dir.join("blob.bin");
    std::fs::write(&blob, &geometry).unwrap();
    let blobs = BTreeMap::from([(hash, blob)]);
    let meshes = BTreeMap::new();
    let info = json_to_cbor(r#"{"app":"test"}"#).unwrap();
    let cbor = json_to_cbor(doc).unwrap();
    let path = dir.join("part.funda");
    let mut file = File::create(&path).unwrap();
    write(&mut file, &document_sections(&info, &cbor, &blobs, &meshes, &[])).unwrap();
    (path, doc.to_string(), geometry)
}

fn same_json(a: &str, b: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(a).unwrap() == serde_json::from_str::<serde_json::Value>(b).unwrap()
}

#[test]
fn round_trips_the_document_and_its_geometry() {
    let dir = tmpdir("roundtrip");
    let (path, doc, geometry) = sample(&dir);
    assert!(looks_like_fnda(&path));
    let blobs = dir.join("blobs");
    let opened = read_file(&path, &blobs, None, None).unwrap();
    assert!(same_json(&opened.document_json, &doc));
    assert_eq!(opened.report, RepairReport::default());
    let blob = std::fs::read_dir(&blobs).unwrap().next().unwrap().unwrap().path();
    assert_eq!(std::fs::read(blob).unwrap(), geometry);
}

#[test]
fn is_not_json_on_disk() {
    let dir = tmpdir("binary");
    let (path, _, _) = sample(&dir);
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[0..8], MAGIC);
    assert!(!bytes.windows(9).any(|w| w == br#""features""#));
}

#[test]
fn repairs_damaged_shards_from_parity() {
    let dir = tmpdir("repair");
    let (path, doc, geometry) = sample(&dir);
    let mut bytes = std::fs::read(&path).unwrap();
    let mut report = RepairReport::default();
    let entries = read_index(&mut File::open(&path).unwrap(), &mut report).unwrap();
    // Scribble over two shards of the document and three of the geometry.
    for e in &entries {
        let size = e.layout.shard_size as usize;
        let hits: &[usize] = if e.kind == KIND_GEOMETRY {
            &[0, 5, 9]
        } else if e.kind == KIND_DOCUMENT {
            &[0, 2]
        } else {
            &[]
        };
        for &i in hits {
            let at = e.offset as usize + i * size + 17;
            for b in &mut bytes[at..at + 40] {
                *b ^= 0xA5;
            }
        }
    }
    std::fs::write(&path, &bytes).unwrap();
    let blobs = dir.join("blobs");
    let opened = read_file(&path, &blobs, None, None).unwrap();
    assert!(same_json(&opened.document_json, &doc));
    assert!(opened.report.repaired_shards >= 3, "{:?}", opened.report);
    let blob = std::fs::read_dir(&blobs).unwrap().next().unwrap().unwrap().path();
    assert_eq!(std::fs::read(blob).unwrap(), geometry);
}

#[test]
fn survives_a_destroyed_header_through_the_trailer_and_backup_table() {
    let dir = tmpdir("header");
    let (path, doc, _) = sample(&dir);
    let mut bytes = std::fs::read(&path).unwrap();
    for b in &mut bytes[0..HEADER_LEN as usize] {
        *b = 0;
    }
    std::fs::write(&path, &bytes).unwrap();
    let opened = read_file(&path, &dir.join("blobs"), None, None).unwrap();
    assert!(same_json(&opened.document_json, &doc));
    assert!(opened.report.used_backup_index);
    assert!(looks_like_fnda(&path), "known by its trailer");
    let app = fundacad_format::container::open_document_full(&path, &dir.join("blobs_app"), None, None).unwrap();
    assert!(same_json(&app.document, &doc) && app.report.used_backup_index);
}

#[test]
fn only_a_whole_header_or_trailer_makes_a_file_binary() {
    let dir = tmpdir("magic");
    let (path, _, _) = sample(&dir);
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[0] ^= 1;
    let n = bytes.len();
    bytes[n - 10] ^= 1;
    std::fs::write(&path, &bytes).unwrap();
    assert!(!looks_like_fnda(&path));
    let short = dir.join("short.funda");
    std::fs::write(&short, b"FNDATAIL").unwrap();
    assert!(!looks_like_fnda(&short));
}

#[test]
fn refuses_damage_beyond_the_parity() {
    let dir = tmpdir("beyond");
    let (path, _, _) = sample(&dir);
    let mut bytes = std::fs::read(&path).unwrap();
    let entries = read_index(&mut File::open(&path).unwrap(), &mut RepairReport::default()).unwrap();
    let doc = entries.iter().find(|e| e.kind == KIND_DOCUMENT).unwrap();
    let size = doc.layout.shard_size as usize;
    for i in 0..(doc.layout.parity_shards as usize + 1) {
        let at = doc.offset as usize + i * size;
        bytes[at] ^= 0xFF;
    }
    std::fs::write(&path, &bytes).unwrap();
    let err = read_file(&path, &dir.join("blobs"), None, None).err().unwrap();
    assert!(err.contains("damaged"), "{err}");
}

#[test]
fn verify_reports_repairs_without_extracting() {
    let dir = tmpdir("verify");
    let (path, _, _) = sample(&dir);
    assert_eq!(verify(&path).unwrap(), RepairReport::default());
    let mut bytes = std::fs::read(&path).unwrap();
    let entries = read_index(&mut File::open(&path).unwrap(), &mut RepairReport::default()).unwrap();
    let geom = entries.iter().find(|e| e.kind == KIND_GEOMETRY).unwrap();
    bytes[geom.offset as usize + 3] ^= 1;
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(verify(&path).unwrap().repaired_shards, 1);
}

#[test]
fn writes_into_memory_too() {
    let info = json_to_cbor("{}").unwrap();
    let cbor = json_to_cbor(r#"{"features":[]}"#).unwrap();
    let (b, m) = (BTreeMap::new(), BTreeMap::new());
    let mut out = Cursor::new(Vec::new());
    let entries = write(&mut out, &document_sections(&info, &cbor, &b, &m, &[])).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(&out.get_ref()[0..8], MAGIC);
}

fn future_file(dir: &Path) -> (PathBuf, Vec<u8>) {
    let payload: Vec<u8> = (0..5000u32).map(|i| (i * 7 % 251) as u8).collect();
    let info = json_to_cbor("{}").unwrap();
    let cbor = json_to_cbor(r#"{"version":11,"features":[]}"#).unwrap();
    let (b, m) = (BTreeMap::new(), BTreeMap::new());
    let mut sections = document_sections(&info, &cbor, &b, &m, &[]);
    sections.push(SectionSpec {
        kind: 9,
        name: "futureIndex".into(),
        source: Source::Bytes(&payload),
        layout: SMALL_LAYOUT,
    });
    let path = dir.join("future.fundab");
    write(&mut File::create(&path).unwrap(), &sections).unwrap();
    (path, payload)
}

fn index_of(path: &Path) -> Vec<Entry> {
    read_index(&mut File::open(path).unwrap(), &mut RepairReport::default()).unwrap()
}

#[test]
fn a_section_of_an_unknown_kind_is_carried_and_written_back() {
    let dir = tmpdir("carry");
    let (path, payload) = future_file(&dir);
    let carry = dir.join("sections");
    let opened = read_file(&path, &dir.join("blobs"), None, Some(&carry)).unwrap();
    let original = index_of(&path).into_iter().find(|e| e.kind == 9).unwrap();
    assert_eq!(opened.carried, vec![Carried { kind: 9, name: "futureIndex".into(), hash: hex(&original.raw_hash) }]);
    let kept = carry.join(format!("{}.bin", opened.carried[0].hash));
    assert_eq!(std::fs::read(&kept).unwrap(), payload);

    let info = json_to_cbor("{}").unwrap();
    let cbor = json_to_cbor(&opened.document_json).unwrap();
    let (b, m) = (BTreeMap::new(), BTreeMap::new());
    let carried = vec![(opened.carried[0].clone(), kept)];
    let again = dir.join("again.fundab");
    write(&mut File::create(&again).unwrap(), &document_sections(&info, &cbor, &b, &m, &carried)).unwrap();
    let written = index_of(&again).into_iter().find(|e| e.kind == 9).unwrap();
    assert_eq!((written.name, written.raw_len, written.raw_hash), (original.name, original.raw_len, original.raw_hash));
    assert_eq!(verify(&again).unwrap(), RepairReport::default());
}

#[test]
fn nothing_is_carried_without_a_carry_folder() {
    let dir = tmpdir("nocarry");
    let (path, _) = future_file(&dir);
    let opened = read_file(&path, &dir.join("blobs"), None, None).unwrap();
    assert!(opened.carried.is_empty());
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
}

const SEG: usize = 64 << 10;

fn opts(threads: usize) -> WriteOptions {
    WriteOptions { segment_raw: SEG, threads }
}

/// Text-like bytes that deflate about as well as a BinTools blob.
fn big_blob(len: usize) -> Vec<u8> {
    let mut x = 0x9E37_79B9u32;
    (0..len)
        .map(|i| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            if i % 7 == 0 {
                b' '
            } else {
                b'0' + (x % 10) as u8
            }
        })
        .collect()
}

fn write_blob(dir: &Path, name: &str, geometry: &[u8], o: &WriteOptions) -> (PathBuf, String) {
    let hash = {
        let mut h = Blake2b128::new();
        h.update(geometry);
        hex(&h.finalize())
    };
    let blob = dir.join(format!("{name}.bin"));
    std::fs::write(&blob, geometry).unwrap();
    let blobs = BTreeMap::from([(hash.clone(), blob)]);
    let info = json_to_cbor("{}").unwrap();
    let cbor = json_to_cbor(r#"{"features":[]}"#).unwrap();
    let path = dir.join(format!("{name}.fundab"));
    write_with(&mut File::create(&path).unwrap(), &document_sections(&info, &cbor, &blobs, &BTreeMap::new(), &[]), o)
        .unwrap();
    (path, hash)
}

#[test]
fn a_big_section_round_trips_in_segments() {
    let dir = tmpdir("segrt");
    let geometry = big_blob(3 << 20);
    let (path, hash) = write_blob(&dir, "seg", &geometry, &opts(4));
    let blobs = dir.join("blobs");
    read_file(&path, &blobs, None, None).unwrap();
    assert_eq!(std::fs::read(blobs.join(format!("{hash}.bbrep"))).unwrap(), geometry);
    assert_eq!(verify(&path).unwrap(), RepairReport::default());
}

#[test]
fn the_info_and_the_document_stay_one_stream_however_big() {
    let dir = tmpdir("bigdoc");
    let long = String::from_utf8(big_blob(3 * SEG)).unwrap();
    let info = json_to_cbor(&format!(r#"{{"note":"{long}"}}"#)).unwrap();
    let cbor = json_to_cbor(&format!(r#"{{"features":[],"note":"{long}"}}"#)).unwrap();
    let path = dir.join("doc.fundab");
    let none = BTreeMap::new();
    write_with(&mut File::create(&path).unwrap(), &document_sections(&info, &cbor, &none, &none, &[]), &opts(4))
        .unwrap();
    assert!(index_of(&path).iter().all(|e| e.kind != KIND_SEGMENTS));
    let opened = read_file(&path, &dir.join("blobs"), None, None).unwrap();
    assert!(opened.document_json.contains(&long));
}

#[test]
fn the_bytes_written_do_not_depend_on_the_thread_count() {
    let dir = tmpdir("segthreads");
    let geometry = big_blob(1 << 20);
    let files: Vec<Vec<u8>> = [1, 2, 8]
        .iter()
        .map(|&t| std::fs::read(write_blob(&dir, &format!("t{t}"), &geometry, &opts(t)).0).unwrap())
        .collect();
    assert!(files.windows(2).all(|w| w[0] == w[1]));
}

#[test]
fn a_carried_index_is_never_written_twice() {
    let dir = tmpdir("segcarry");
    let geometry = big_blob(4 * SEG);
    let (path, hash) = write_blob(&dir, "seg", &geometry, &opts(2));
    let old = read_section_of_kind(&path, KIND_SEGMENTS).unwrap().unwrap();
    let stale = dir.join("stale.bin");
    std::fs::write(&stale, &old).unwrap();
    let carried = vec![(Carried { kind: KIND_SEGMENTS, name: "segments".into(), hash: "00".into() }, stale)];
    let blobs = BTreeMap::from([(hash, dir.join("seg.bin"))]);
    let info = json_to_cbor("{}").unwrap();
    let cbor = json_to_cbor(r#"{"features":[]}"#).unwrap();
    let meshes = BTreeMap::new();
    let mut sections = document_sections(&info, &cbor, &blobs, &meshes, &carried);
    sections.push(SectionSpec {
        kind: KIND_SEGMENTS,
        name: "segments".into(),
        source: Source::Bytes(&old),
        layout: SMALL_LAYOUT,
    });
    let again = dir.join("again.fundab");
    write_with(&mut File::create(&again).unwrap(), &sections, &opts(2)).unwrap();
    assert_eq!(index_of(&again).iter().filter(|e| e.kind == KIND_SEGMENTS).count(), 1);
    let opened = read_file(&again, &dir.join("blobs"), None, Some(&dir.join("carry"))).unwrap();
    assert!(opened.carried.is_empty());
}
