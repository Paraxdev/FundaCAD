//! Opening a file on several threads: the same blobs for any thread count, and
//! a segment index that is stale, wrong or damaged costs speed, never the open.

use super::read_tests::rewrite_table;
use super::*;

const SEG: usize = 64 << 10;
const SMALL_GROUPS: Layout = Layout { shard_size: 4096, data_shards: 4, parity_shards: 2 };

fn tmpdir(tag: &str) -> PathBuf {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).unwrap();
    let d = std::env::temp_dir().join(format!("fundacad_fopen_{tag}_{}", hex(&b)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Text-like bytes that deflate about as well as a BinTools blob.
fn text(len: usize, seed: u32) -> Vec<u8> {
    let mut x = 0x9E37_79B9u32 ^ seed;
    (0..len)
        .map(|i| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            if i % 7 == 0 { b' ' } else { b'0' + (x % 10) as u8 }
        })
        .collect()
}

fn hash_hex(b: &[u8]) -> String {
    let mut h = Blake2b128::new();
    h.update(b);
    hex(&h.finalize())
}

fn wopts() -> WriteOptions {
    WriteOptions { segment_raw: SEG, threads: 2 }
}

/// Two segmented blobs over many small groups, and five small ones.
fn blobs() -> Vec<Vec<u8>> {
    let mut out = vec![text(4 * SEG, 1), text(5 * SEG + 123, 2)];
    out.extend((0..5).map(|i| text(3000 + 700 * i, 10 + i as u32)));
    out
}

fn write_doc(path: &Path, blobs: &[Vec<u8>], extra: Option<&[u8]>, o: &WriteOptions) -> Vec<Entry> {
    let info = json_to_cbor("{}").unwrap();
    let cbor = json_to_cbor(r#"{"features":[]}"#).unwrap();
    let mut sections = vec![
        SectionSpec { kind: KIND_INFO, name: "info".into(), source: Source::Bytes(&info), layout: SMALL_LAYOUT },
        SectionSpec { kind: KIND_DOCUMENT, name: "document".into(), source: Source::Bytes(&cbor), layout: SMALL_LAYOUT },
    ];
    for b in blobs {
        let layout = if b.len() >= 2 * SEG { SMALL_GROUPS } else { LARGE_LAYOUT };
        sections.push(SectionSpec { kind: KIND_GEOMETRY, name: hash_hex(b), source: Source::Bytes(b), layout });
    }
    if let Some(index) = extra {
        sections.push(SectionSpec { kind: 9, name: "segments".into(), source: Source::Bytes(index), layout: SMALL_LAYOUT });
    }
    let entries = write_with(&mut File::create(path).unwrap(), &sections, o).unwrap();
    if extra.is_some() {
        // An older writer carries an index it does not know as it found it.
        rewrite_table(path, |e| {
            if e.kind == 9 {
                e.kind = KIND_SEGMENTS;
            }
        });
    }
    entries
}

fn rows_of(path: &Path) -> Vec<segments::Row> {
    read_section_of_kind(path, KIND_SEGMENTS).unwrap().map(|b| segments::decode(&b)).unwrap_or_default()
}

fn open(path: &Path, blob_dir: &Path, threads: usize) -> Result<Opened, String> {
    read_file_with(path, blob_dir, None, None, &ReadOptions { threads })
}

fn assert_blobs(blob_dir: &Path, blobs: &[Vec<u8>]) {
    for b in blobs {
        assert_eq!(&std::fs::read(blob_dir.join(format!("{}.bbrep", hash_hex(b)))).unwrap(), b);
    }
    assert_eq!(std::fs::read_dir(blob_dir).unwrap().count(), blobs.len(), "no stray files");
}

fn geometry(entries: &[Entry], raw: &[u8]) -> Entry {
    entries.iter().find(|e| e.kind == KIND_GEOMETRY && hex(&e.raw_hash) == hash_hex(raw)).unwrap().clone()
}

/// Run `read_segmented` on one section by `row`: Some(raw bytes) when it took the fast path.
fn segmented(path: &Path, e: &Entry, row: &segments::Row, threads: usize) -> Result<Option<Vec<u8>>, String> {
    let file = File::open(path).unwrap();
    let (crcs, _) = read_crcs(&file, e)?;
    let mut out = Vec::new();
    Ok(read_segmented(&file, e, row, &crcs, threads, &mut out)?.map(|_| out))
}

#[test]
fn the_blobs_are_the_same_for_any_thread_count() {
    let dir = tmpdir("threads");
    let path = dir.join("doc.fundab");
    let blobs = blobs();
    let entries = write_doc(&path, &blobs, None, &wopts());
    let rows = rows_of(&path);
    assert_eq!(rows.len(), 2);
    for t in [1, 2, 8] {
        let store = dir.join(format!("blobs{t}"));
        test_hooks::take();
        let opened = open(&path, &store, t).unwrap();
        assert_eq!(test_hooks::take().0, 2, "both big blobs by their rows at {t} threads");
        assert_eq!(opened.report, RepairReport::default());
        assert_blobs(&store, &blobs);
        for (raw, row) in blobs.iter().zip(&rows) {
            assert_eq!(segmented(&path, &geometry(&entries, raw), row, t).unwrap().as_deref(), Some(&raw[..]), "fast path at {t} threads");
        }
    }
}

#[test]
fn repairs_on_the_fast_path_are_counted() {
    let dir = tmpdir("fastrepair");
    let path = dir.join("doc.fundab");
    let blobs = blobs();
    let entries = write_doc(&path, &blobs, None, &wopts());
    let e = geometry(&entries, &blobs[1]);
    let size = e.layout.shard_size as u64;
    let mut bytes = std::fs::read(&path).unwrap();
    for g in [0u64, 3, e.groups() - 1] {
        bytes[(e.offset + g * e.shards_per_group() * size + 11) as usize] ^= 0x77;
    }
    std::fs::write(&path, bytes).unwrap();
    let store = dir.join("blobs");
    assert_eq!(open(&path, &store, 4).unwrap().report.repaired_shards, 3);
    assert_blobs(&store, &blobs);
}

#[test]
fn a_stale_index_opens_on_the_serial_path_and_a_save_writes_a_fresh_one() {
    let dir = tmpdir("stale");
    let blobs = blobs();
    let fresh = dir.join("fresh.fundab");
    write_doc(&fresh, &blobs, None, &wopts());
    let index = read_section_of_kind(&fresh, KIND_SEGMENTS).unwrap().unwrap();
    // An older writer encoded the geometry again as one stream and carried the index.
    let stale = dir.join("stale.fundab");
    let one_stream = WriteOptions { segment_raw: 8 << 20, threads: 1 };
    write_doc(&stale, &blobs, Some(&index), &one_stream);
    assert_eq!(rows_of(&stale), rows_of(&fresh));
    let store = dir.join("blobs");
    test_hooks::take();
    let opened = read_file_with(&stale, &store, None, Some(&dir.join("carry")), &ReadOptions { threads: 4 }).unwrap();
    assert_eq!(test_hooks::take().0, 0);
    assert!(opened.carried.is_empty());
    assert_blobs(&store, &blobs);

    let again = dir.join("again.fundab");
    let entries = write_doc(&again, &blobs, None, &wopts());
    let rows = rows_of(&again);
    assert_eq!(rows.len(), 2);
    let e = geometry(&entries, &blobs[0]);
    let (_, crc) = read_crcs(&File::open(&again).unwrap(), &e).unwrap();
    assert!(segments::matches(&rows[0], e.kind, e.codec, &e.raw_hash, e.stored_len, e.raw_len, crc));
}

#[test]
fn a_wrong_index_opens_correctly_every_way() {
    let dir = tmpdir("wrong");
    let blobs = blobs();
    let good = dir.join("good.fundab");
    write_doc(&good, &blobs, None, &wopts());
    let row = rows_of(&good)[0].clone();
    let mut variants: Vec<(&str, Vec<u8>)> = Vec::new();
    let mut edit = |name, f: &dyn Fn(&mut segments::Row)| {
        let mut r = row.clone();
        f(&mut r);
        variants.push((name, segments::encode(&[r])));
    };
    edit("crc", &|r| r.crc_table_crc ^= 1);
    edit("stored sum", &|r| r.segments[0].stored += 1);
    edit("raw sum", &|r| r.segments[1].raw -= 1);
    edit("past the end", &|r| r.segments.last_mut().unwrap().stored += 4096);
    edit("too many", &|r| {
        let raw: u32 = r.segments.iter().map(|s| s.raw).sum();
        let stored: u32 = r.segments.iter().map(|s| s.stored).sum();
        let n = raw / 1024 + 2;
        r.segments = (0..n - 1).map(|_| segments::Segment { stored: 1, raw: 1 }).collect();
        r.segments.push(segments::Segment { stored: stored - (n - 1), raw: raw - (n - 1) });
    });
    // A wrong split inside the right sums: the first segment cannot inflate to its length.
    edit("wrong length", &|r| {
        r.segments[0].raw += 1;
        r.segments[1].raw -= 1;
    });
    let mut bad_magic = segments::encode(std::slice::from_ref(&row));
    bad_magic[0] ^= 1;
    variants.push(("magic", bad_magic));
    let mut v2 = segments::encode(std::slice::from_ref(&row));
    v2[4] = 2;
    variants.push(("version", v2));

    for (i, (name, index)) in variants.iter().enumerate() {
        let path = dir.join(format!("v{i}.fundab"));
        let entries = write_doc(&path, &blobs, Some(index), &wopts());
        let store = dir.join(format!("blobs{i}"));
        test_hooks::take();
        let opened = open(&path, &store, 4).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(test_hooks::take().0, 0, "{name} read on the serial path");
        assert_eq!(opened.report, RepairReport::default(), "{name}");
        assert_blobs(&store, &blobs);
        if *name == "wrong length" {
            let forged = rows_of(&path)[0].clone();
            assert_eq!(segmented(&path, &geometry(&entries, &blobs[0]), &forged, 4).unwrap(), None);
        }
    }
}

#[test]
fn an_index_damaged_beyond_its_parity_is_ignored() {
    let dir = tmpdir("index");
    let path = dir.join("doc.fundab");
    let blobs = blobs();
    write_doc(&path, &blobs, None, &wopts());
    let e = read_index(&mut File::open(&path).unwrap(), &mut RepairReport::default())
        .unwrap()
        .into_iter()
        .find(|e| e.kind == KIND_SEGMENTS)
        .unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    for i in 0..e.layout.parity_shards as u64 + 1 {
        bytes[(e.offset + i * e.layout.shard_size as u64) as usize] ^= 0xFF;
    }
    std::fs::write(&path, bytes).unwrap();
    let store = dir.join("blobs");
    open(&path, &store, 4).unwrap();
    assert_blobs(&store, &blobs);
    assert!(verify(&path).is_err());
}

#[test]
fn damage_beyond_parity_in_a_segmented_blob_fails_and_publishes_nothing() {
    let dir = tmpdir("beyond");
    let path = dir.join("doc.fundab");
    let blobs = blobs();
    let entries = write_doc(&path, &blobs, None, &wopts());
    let e = geometry(&entries, &blobs[0]);
    let size = e.layout.shard_size as u64;
    let mut bytes = std::fs::read(&path).unwrap();
    for i in 0..e.layout.parity_shards as u64 + 1 {
        bytes[(e.offset + (e.shards_per_group() + i) * size) as usize] ^= 0xFF;
    }
    std::fs::write(&path, bytes).unwrap();
    let store = dir.join("blobs");
    let err = open(&path, &store, 4).err().unwrap();
    assert!(err.contains("damaged"), "{err}");
    assert_eq!(std::fs::read_dir(&store).unwrap().count(), 0, "the open stops at the first broken geometry");
}

#[test]
fn redundant_segments_are_inflated_a_bounded_batch_at_a_time() {
    let dir = tmpdir("batches");
    let path = dir.join("doc.fundab");
    let zeros = vec![vec![0u8; 3 * INFLATE_RAW_PER_THREAD as usize + 5 * SEG]];
    let entries = write_doc(&path, &zeros, None, &wopts());
    let e = geometry(&entries, &zeros[0]);
    assert!(e.groups() <= 2, "the whole section fits in one window at 1 thread");
    for t in [1, 2] {
        let store = dir.join(format!("blobs{t}"));
        test_hooks::take();
        open(&path, &store, t).unwrap();
        let (fast, largest) = test_hooks::take();
        assert_eq!(fast, 1);
        assert!(largest <= INFLATE_RAW_PER_THREAD * t as u64 && largest > 0, "{largest} at {t} threads");
        assert_blobs(&store, &zeros);
    }
}

#[test]
fn a_stored_blob_of_the_wrong_length_is_replaced_and_a_whole_one_kept() {
    let dir = tmpdir("existing");
    let path = dir.join("doc.fundab");
    let blobs = blobs();
    write_doc(&path, &blobs, None, &wopts());
    let store = dir.join("blobs");
    std::fs::create_dir_all(&store).unwrap();
    let torn = store.join(format!("{}.bbrep", hash_hex(&blobs[0])));
    std::fs::write(&torn, &blobs[0][..1000]).unwrap();
    let kept = store.join(format!("{}.bbrep", hash_hex(&blobs[2])));
    let stand_in = vec![b'x'; blobs[2].len()];
    std::fs::write(&kept, &stand_in).unwrap();
    open(&path, &store, 4).unwrap();
    assert_eq!(std::fs::read(&torn).unwrap(), blobs[0]);
    assert_eq!(std::fs::read(&kept).unwrap(), stand_in);
}

#[test]
fn a_carried_section_already_kept_is_listed_in_file_order() {
    let dir = tmpdir("carried");
    let path = dir.join("doc.fundab");
    let blobs = blobs();
    let info = json_to_cbor("{}").unwrap();
    let cbor = json_to_cbor(r#"{"features":[]}"#).unwrap();
    let (a, b) = (text(5000, 40), text(3 * SEG, 41));
    let sections = vec![
        SectionSpec { kind: KIND_INFO, name: "info".into(), source: Source::Bytes(&info), layout: SMALL_LAYOUT },
        SectionSpec { kind: KIND_DOCUMENT, name: "document".into(), source: Source::Bytes(&cbor), layout: SMALL_LAYOUT },
        SectionSpec { kind: KIND_GEOMETRY, name: hash_hex(&blobs[0]), source: Source::Bytes(&blobs[0]), layout: SMALL_GROUPS },
        SectionSpec { kind: 9, name: "later".into(), source: Source::Bytes(&a), layout: SMALL_LAYOUT },
        SectionSpec { kind: 10, name: "big".into(), source: Source::Bytes(&b), layout: SMALL_GROUPS },
    ];
    write_with(&mut File::create(&path).unwrap(), &sections, &wopts()).unwrap();
    assert_eq!(rows_of(&path).len(), 2);
    let carry = dir.join("carry");
    std::fs::create_dir_all(&carry).unwrap();
    std::fs::write(carry.join(format!("{}.bin", hash_hex(&a))), &a).unwrap();
    let opened = read_file_with(&path, &dir.join("blobs"), None, Some(&carry), &ReadOptions { threads: 4 }).unwrap();
    let names: Vec<&str> = opened.carried.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["later", "big"]);
    assert_eq!(std::fs::read(carry.join(format!("{}.bin", hash_hex(&b)))).unwrap(), b);
}

#[test]
fn two_opens_of_the_same_file_at_once_leave_one_good_blob() {
    let dir = tmpdir("twice");
    let path = dir.join("doc.fundab");
    let blobs = blobs();
    write_doc(&path, &blobs, None, &wopts());
    let store = dir.join("blobs");
    std::thread::scope(|s| {
        let runs: Vec<_> = (0..3).map(|_| s.spawn(|| open(&path, &store, 2).map(|_| ()))).collect();
        for r in runs {
            r.join().unwrap().unwrap();
        }
    });
    assert_blobs(&store, &blobs);
}

#[test]
fn a_segment_over_the_batch_budget_is_inflated_alone() {
    let cap = INFLATE_RAW_PER_THREAD as usize;
    let spans = [(0, 1, cap / 2), (1, 2, cap / 2), (2, 3, cap + 1), (3, 4, 1), (4, 5, 1)];
    let lens: Vec<usize> = inflate_batches(&spans, 1).iter().map(|b| b.len()).collect();
    assert_eq!(lens, [2, 1, 2]);
    assert_eq!(inflate_batches(&spans, 3).len(), 1);
    assert!(inflate_batches(&[], 4).is_empty());
}
