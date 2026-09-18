//! Document files in both formats: `.funda` JSON and `.fundab` binary. A port
//! of `crates/fundacad-mcp/tools/python-oracle/tests/test_docfile.py`.
//!
//! The binary case builds a format 2 file by the spec in docs/FUNDA-FORMAT.md,
//! with parity shards the reader must step over, since the app's own writer is
//! the one that computes them.

use std::io::Write;
use std::path::Path;

use blake2::digest::{Update, VariableOutput};
use fundacad_mcp::docfile;
use serde_json::{json, Map, Value};

fn geometry() -> Vec<u8> {
    (0..20_000u64)
        .map(|i| (((i * 2_654_435_761) >> 13) & 0xFF) as u8)
        .collect()
}

fn digest(data: &[u8]) -> String {
    let mut h = blake2::Blake2bVar::new(16).unwrap();
    h.update(data);
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).unwrap();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn doc(digest: &str) -> Map<String, Value> {
    json!({"version": 9, "parameters": {"w": 12.5},
           "features": [{"id": "im", "type": "import", "geom": digest, "name": "Speaker"}]})
    .as_object()
    .unwrap()
    .clone()
}

// --- a format 2 file, written the way the app writes one ---------------------

fn cbor(v: &Value) -> Vec<u8> {
    fn head(major: u8, n: u64) -> Vec<u8> {
        if n < 24 {
            return vec![major << 5 | n as u8];
        }
        if n < 1 << 8 {
            return vec![major << 5 | 24, n as u8];
        }
        if n < 1 << 16 {
            let mut o = vec![major << 5 | 25];
            o.extend_from_slice(&(n as u16).to_be_bytes());
            return o;
        }
        if n < 1 << 32 {
            let mut o = vec![major << 5 | 26];
            o.extend_from_slice(&(n as u32).to_be_bytes());
            return o;
        }
        let mut o = vec![major << 5 | 27];
        o.extend_from_slice(&n.to_be_bytes());
        o
    }
    match v {
        Value::Bool(true) => vec![0xf5],
        Value::Bool(false) => vec![0xf4],
        Value::Null => vec![0xf6],
        Value::Number(n) if n.is_u64() || n.is_i64() => {
            let i = n.as_i64().unwrap_or(0);
            if i >= 0 {
                head(0, i as u64)
            } else {
                head(1, (-1 - i) as u64)
            }
        }
        Value::Number(n) => {
            let mut o = vec![0xfb];
            o.extend_from_slice(&n.as_f64().unwrap_or(0.0).to_be_bytes());
            o
        }
        Value::String(s) => {
            let mut o = head(3, s.len() as u64);
            o.extend_from_slice(s.as_bytes());
            o
        }
        Value::Array(items) => {
            let mut o = head(4, items.len() as u64);
            items.iter().for_each(|i| o.extend(cbor(i)));
            o
        }
        Value::Object(map) => {
            let mut o = head(5, map.len() as u64);
            for (k, val) in map {
                o.extend(cbor(&Value::String(k.clone())));
                o.extend(cbor(val));
            }
            o
        }
    }
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn deflate(raw: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    e.write_all(raw).unwrap();
    e.finish().unwrap()
}

fn write_fundab(path: &Path, document: &Map<String, Value>, blobs: &[(String, Vec<u8>)]) {
    let (shard, k, m) = (4096usize, 8usize, 4usize);
    let mut body = vec![0u8; 64];
    let mut entries: Vec<(u8, String, usize, usize, usize, [u8; 16])> = Vec::new();
    let mut sections: Vec<(u8, String, Vec<u8>)> = vec![(
        1,
        "document".into(),
        cbor(&Value::Object(document.clone())),
    )];
    for (h, b) in blobs {
        sections.push((2, h.clone(), b.clone()));
    }
    for (kind, name, raw) in sections {
        let stored = deflate(&raw);
        let off = body.len();
        let groups = stored.len().div_ceil(shard * k);
        let mut padded = stored.clone();
        padded.resize(groups * shard * k, 0);
        for g in 0..groups {
            body.extend_from_slice(&padded[g * shard * k..(g + 1) * shard * k]);
            body.extend(std::iter::repeat_n(0xAAu8, m * shard));
        }
        body.extend(std::iter::repeat_n(0u8, 4 * groups * (k + m)));
        let mut h = blake2::Blake2bVar::new(16).unwrap();
        h.update(&raw);
        let mut d = [0u8; 16];
        h.finalize_variable(&mut d).unwrap();
        entries.push((kind, name, off, stored.len(), raw.len(), d));
    }
    let mut table: Vec<u8> = b"FTBL".to_vec();
    table.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (kind, name, off, sl, rl, h) in &entries {
        table.push(*kind);
        table.push(1); // deflate
        table.extend_from_slice(&(name.len() as u16).to_le_bytes());
        table.extend_from_slice(name.as_bytes());
        table.extend_from_slice(&(*off as u64).to_le_bytes());
        table.extend_from_slice(&(*sl as u64).to_le_bytes());
        table.extend_from_slice(&(*rl as u64).to_le_bytes());
        table.extend_from_slice(h);
        table.extend_from_slice(&(shard as u32).to_le_bytes());
        table.extend_from_slice(&(k as u16).to_le_bytes());
        table.extend_from_slice(&(m as u16).to_le_bytes());
    }
    let ta = body.len();
    body.extend_from_slice(&table);
    let tb = body.len();
    body.extend_from_slice(&table);

    let mut head = vec![0u8; 64];
    head[..8].copy_from_slice(b"FUNDACAD");
    head[8..10].copy_from_slice(&2u16.to_le_bytes());
    head[16..24].copy_from_slice(&(ta as u64).to_le_bytes());
    head[24..32].copy_from_slice(&(tb as u64).to_le_bytes());
    head[32..40].copy_from_slice(&(table.len() as u64).to_le_bytes());
    head[40..44].copy_from_slice(&crc32(&table).to_le_bytes());
    let crc = crc32(&head[..56]);
    head[56..60].copy_from_slice(&crc.to_le_bytes());
    body[..64].copy_from_slice(&head);

    let mut tail = head.clone();
    tail[..8].copy_from_slice(b"FNDATAIL");
    let tail_crc = crc32(&tail[..56]);
    tail[56..60].copy_from_slice(&tail_crc.to_le_bytes());
    body.extend_from_slice(&tail);
    std::fs::write(path, &body).unwrap();
}

// --- the tests ---------------------------------------------------------------

#[test]
fn json_round_trips_with_geometry_embedded_last() {
    let tmp = tempfile::tempdir().unwrap();
    let data = geometry();
    let d = digest(&data);
    let store = tmp.path().join("blobs");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(store.join(format!("{d}.bbrep")), &data).unwrap();
    let path = tmp.path().join("part.funda");
    assert_eq!(docfile::write(&path, &doc(&d), Some(&store)).unwrap(), 1);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        text.find("\"features\"") < text.find("\"geometry\""),
        "the feature tree reads first"
    );

    let fresh = tmp.path().join("fresh");
    let (back, n) = docfile::read(&path, Some(&fresh)).unwrap();
    assert_eq!(n, 1);
    assert_eq!(back, doc(&d));
    assert_eq!(
        std::fs::read(fresh.join(format!("{d}.bbrep"))).unwrap(),
        data
    );
}

#[test]
fn reads_a_binary_file_and_publishes_its_geometry() {
    let tmp = tempfile::tempdir().unwrap();
    let data = geometry();
    let d = digest(&data);
    let path = tmp.path().join("part.fundab");
    write_fundab(&path, &doc(&d), &[(d.clone(), data.clone())]);
    let store = tmp.path().join("blobs");
    let (back, n) = docfile::read(&path, Some(&store)).unwrap();
    assert_eq!(back, doc(&d));
    assert_eq!(n, 1);
    assert_eq!(
        std::fs::read(store.join(format!("{d}.bbrep"))).unwrap(),
        data
    );
}

#[test]
fn the_extension_does_not_decide_how_a_file_is_read() {
    let tmp = tempfile::tempdir().unwrap();
    let d = digest(&geometry());
    let path = tmp.path().join("misnamed.funda");
    write_fundab(&path, &doc(&d), &[]);
    let (back, _) = docfile::read(&path, Some(&tmp.path().join("b"))).unwrap();
    assert_eq!(back, doc(&d));
}

#[test]
fn damaged_binary_and_wrong_geometry_are_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let data = geometry();
    let d = digest(&data);
    let path = tmp.path().join("part.fundab");
    write_fundab(&path, &doc(&d), &[(d.clone(), data)]);
    let mut raw = std::fs::read(&path).unwrap();
    raw[70] ^= 0xFF;
    std::fs::write(&path, &raw).unwrap();
    assert!(
        docfile::read(&path, Some(&tmp.path().join("b"))).is_err(),
        "a damaged section was accepted"
    );

    let mut bad = doc(&d);
    bad.insert("geometry".into(), json!({d.clone(): "AAAA".repeat(10)}));
    let jpath = tmp.path().join("bad.funda");
    std::fs::write(&jpath, Value::Object(bad).to_string()).unwrap();
    let store = tmp.path().join("b2");
    assert!(
        docfile::read(&jpath, Some(&store)).is_err(),
        "geometry that does not match its hash was accepted"
    );
    assert!(!store.join(format!("{d}.bbrep")).exists());
}

#[test]
fn saving_binary_is_refused_with_the_way_round_it() {
    let tmp = tempfile::tempdir().unwrap();
    let d = digest(&geometry());
    let out = docfile::write(&tmp.path().join("part.fundab"), &doc(&d), Some(tmp.path()));
    let Err(e) = out else {
        panic!("wrote a .fundab without parity");
    };
    assert!(e.0.contains("Save As .fundab"), "{}", e.0);
}

#[test]
fn saving_with_missing_geometry_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let d = digest(&geometry());
    let path = tmp.path().join("part.funda");
    assert!(
        docfile::write(&path, &doc(&d), Some(&tmp.path().join("empty"))).is_err(),
        "saved a document whose geometry is nowhere"
    );
    assert!(!path.exists());
}
