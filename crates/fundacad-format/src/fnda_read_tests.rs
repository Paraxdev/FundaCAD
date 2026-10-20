//! The section reader against damage and truncation, on a small custom layout so
//! a section spans many groups with little data.

use super::*;

const TINY: Layout = Layout { shard_size: 1024, data_shards: 4, parity_shards: 2 };

fn tmpdir(tag: &str) -> PathBuf {
    let mut b = [0u8; 8];
    getrandom::getrandom(&mut b).unwrap();
    let d = std::env::temp_dir().join(format!("fundacad_fread_{tag}_{}", hex(&b)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn noise(len: usize) -> Vec<u8> {
    let mut x = 0x1234_5678u32;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

fn hash_hex(b: &[u8]) -> String {
    let mut h = Blake2b128::new();
    h.update(b);
    hex(&h.finalize())
}

/// A file whose geometry is about ten groups of TINY.
fn tiny_file(dir: &Path) -> (PathBuf, Vec<u8>, Entry) {
    let geometry = noise(40_000);
    let info = json_to_cbor("{}").unwrap();
    let cbor = json_to_cbor(r#"{"features":[]}"#).unwrap();
    let sections = vec![
        SectionSpec { kind: KIND_INFO, name: "info".into(), source: Source::Bytes(&info), layout: SMALL_LAYOUT },
        SectionSpec { kind: KIND_DOCUMENT, name: "document".into(), source: Source::Bytes(&cbor), layout: SMALL_LAYOUT },
        SectionSpec { kind: KIND_GEOMETRY, name: hash_hex(&geometry), source: Source::Bytes(&geometry), layout: TINY },
    ];
    let path = dir.join("tiny.fundab");
    let entries = write(&mut File::create(&path).unwrap(), &sections).unwrap();
    let geom = entries.into_iter().find(|e| e.kind == KIND_GEOMETRY).unwrap();
    assert_eq!(geom.layout, TINY);
    assert!(geom.groups() >= 8, "{}", geom.groups());
    (path, geometry, geom)
}

fn shard_at(e: &Entry, g: u64, i: u64) -> usize {
    (e.offset + (g * e.shards_per_group() + i) * e.layout.shard_size as u64) as usize
}

fn flip(path: &Path, at: &[usize]) {
    let mut bytes = std::fs::read(path).unwrap();
    for &i in at {
        bytes[i] ^= 0x5A;
    }
    std::fs::write(path, bytes).unwrap();
}

/// The shard by shard reader this one replaced, kept as the reference.
fn reference_stored(path: &Path, e: &Entry) -> Result<(Vec<u8>, u64), ()> {
    let mut f = File::open(path).unwrap();
    let l = e.layout;
    let rs = ReedSolomon::new(l.data_shards as usize, l.parity_shards as usize).unwrap();
    let n = e.shards_per_group() as usize;
    let size = l.shard_size as usize;
    let mut raw = vec![0u8; (e.groups() * n as u64 * 4) as usize];
    f.seek(SeekFrom::Start(e.crc_table_offset())).unwrap();
    let _ = read_fully(&mut f, &mut raw);
    let crcs: Vec<u32> = raw.chunks(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
    let (mut out, mut repaired) = (Vec::new(), 0u64);
    for g in 0..e.groups() {
        f.seek(SeekFrom::Start(e.offset + g * (n * size) as u64)).unwrap();
        let mut shards: Vec<Option<Vec<u8>>> = Vec::new();
        let mut bad = 0;
        for i in 0..n {
            let mut shard = vec![0u8; size];
            let got = read_fully(&mut f, &mut shard).unwrap();
            let ok = got == size && crcs.get(g as usize * n + i).is_some_and(|c| *c == crc32fast::hash(&shard));
            if !ok && i < l.data_shards as usize {
                bad += 1;
            }
            shards.push(ok.then_some(shard));
        }
        if bad > 0 {
            rs.reconstruct_data(&mut shards).map_err(|_| ())?;
            repaired += bad;
        }
        for s in shards.into_iter().take(l.data_shards as usize) {
            out.extend_from_slice(&s.unwrap());
        }
    }
    out.truncate(e.stored_len as usize);
    Ok((out, repaired))
}

fn read_fully(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match f.read(&mut buf[got..])? {
            0 => break,
            n => got += n,
        }
    }
    Ok(got)
}

fn new_stored(path: &Path, e: &Entry) -> Result<(Vec<u8>, u64), ()> {
    let f = File::open(path).unwrap();
    let mut r = SectionReader::new(&f, e).map_err(|_| ())?;
    let mut out = Vec::new();
    r.read_to_end(&mut out).map_err(|_| ())?;
    Ok((out, r.repaired))
}

/// The section decoded and the repairs it took, checked against the reference.
fn read_geometry(path: &Path, e: &Entry) -> Result<(Vec<u8>, u64), String> {
    assert_eq!(new_stored(path, e), reference_stored(path, e));
    let f = File::open(path).unwrap();
    let mut report = RepairReport::default();
    let mut out = Vec::new();
    read_section(&f, e, &mut out, &mut report)?;
    Ok((out, report.repaired_shards))
}

fn nothing_published(blobs: &Path) -> bool {
    std::fs::read_dir(blobs).map(|d| d.count() == 0).unwrap_or(true)
}

#[test]
fn an_intact_section_reads_like_the_reference_without_repairs() {
    let dir = tmpdir("intact");
    let (path, geometry, e) = tiny_file(&dir);
    assert_eq!(read_geometry(&path, &e).unwrap(), (geometry, 0));
}

#[test]
fn damage_in_the_first_a_middle_and_the_last_group_is_repaired() {
    let dir = tmpdir("groups");
    let (path, geometry, e) = tiny_file(&dir);
    let last = e.groups() - 1;
    flip(&path, &[shard_at(&e, 0, 0) + 3, shard_at(&e, last / 2, 2) + 100, shard_at(&e, last, 0) + 1]);
    assert_eq!(read_geometry(&path, &e).unwrap(), (geometry, 3));
}

#[test]
fn damage_to_parity_alone_needs_no_repair() {
    let dir = tmpdir("parity");
    let (path, geometry, e) = tiny_file(&dir);
    flip(&path, &[shard_at(&e, 2, 4) + 7, shard_at(&e, 3, 5)]);
    assert_eq!(read_geometry(&path, &e).unwrap(), (geometry, 0));
}

#[test]
fn as_many_damaged_shards_as_parity_are_repaired_and_one_more_is_refused() {
    let dir = tmpdir("limit");
    let (path, geometry, e) = tiny_file(&dir);
    flip(&path, &[shard_at(&e, 1, 0), shard_at(&e, 1, 3) + 9]);
    assert_eq!(read_geometry(&path, &e).unwrap(), (geometry, 2));
    flip(&path, &[shard_at(&e, 1, 1) + 50]);
    let err = read_geometry(&path, &e).unwrap_err();
    assert!(err.contains("damaged"), "{err}");
    let blobs = dir.join("blobs");
    assert!(read_file(&path, &blobs, None, None).is_err());
    assert!(nothing_published(&blobs));
}

#[test]
fn damage_across_two_groups_is_repaired_in_each() {
    let dir = tmpdir("straddle");
    let (path, geometry, e) = tiny_file(&dir);
    let boundary = shard_at(&e, 2, 0);
    let mut hits: Vec<usize> = (boundary - 20..boundary + 20).collect();
    hits.push(shard_at(&e, 1, 1) + 5);
    flip(&path, &hits);
    assert_eq!(read_geometry(&path, &e).unwrap(), (geometry, 2));
}

#[test]
fn a_damaged_crc_entry_costs_one_repair() {
    let dir = tmpdir("crc");
    let (path, geometry, e) = tiny_file(&dir);
    flip(&path, &[e.crc_table_offset() as usize + 4]);
    assert_eq!(read_geometry(&path, &e).unwrap(), (geometry, 1));
}

#[test]
fn a_truncated_file_is_an_error_and_publishes_nothing() {
    let dir = tmpdir("trunc");
    let (path, _, e) = tiny_file(&dir);
    let bytes = std::fs::read(&path).unwrap();
    let table_a = parse_header(&bytes[..HEADER_LEN as usize], MAGIC).unwrap().table_a as usize;
    for (i, cut) in [HEADER_LEN as usize + 10, (e.offset + e.stored_len / 2) as usize, table_a + 6].into_iter().enumerate() {
        let short = dir.join(format!("short{i}.fundab"));
        std::fs::write(&short, &bytes[..cut]).unwrap();
        let blobs = dir.join(format!("blobs{i}"));
        let err = read_file(&short, &blobs, None, None).err().unwrap();
        assert!(err.contains("damaged"), "{err}");
        assert!(nothing_published(&blobs));
        assert!(verify(&short).is_err());
    }
}

#[test]
fn a_file_cut_inside_its_trailer_still_opens_from_its_header() {
    let dir = tmpdir("trailer");
    let (path, geometry, _) = tiny_file(&dir);
    let bytes = std::fs::read(&path).unwrap();
    std::fs::write(&path, &bytes[..bytes.len() - 20]).unwrap();
    let blobs = dir.join("blobs");
    read_file(&path, &blobs, None, None).unwrap();
    assert_eq!(std::fs::read(blobs.join(format!("{}.bbrep", hash_hex(&geometry)))).unwrap(), geometry);
}

#[test]
fn a_damaged_first_table_falls_back_to_the_second() {
    let dir = tmpdir("tables");
    let (path, _, _) = tiny_file(&dir);
    let bytes = std::fs::read(&path).unwrap();
    let h = parse_header(&bytes[..HEADER_LEN as usize], MAGIC).unwrap();
    flip(&path, &[h.table_a as usize + 9]);
    let opened = read_file(&path, &dir.join("blobs"), None, None).unwrap();
    assert!(opened.report.used_backup_index);
    flip(&path, &[3]);
    let opened = read_file(&path, &dir.join("blobs2"), None, None).unwrap();
    assert!(opened.report.used_backup_index);
}

#[test]
fn a_section_declared_bigger_than_the_cap_is_refused_before_decoding() {
    let dir = tmpdir("maxraw");
    let (path, _, _) = tiny_file(&dir);
    rewrite_table(&path, |e| {
        if e.kind == KIND_GEOMETRY {
            e.raw_len = MAX_RAW + 1;
        }
    });
    let blobs = dir.join("blobs");
    let err = read_file(&path, &blobs, None, None).err().unwrap();
    assert!(err.contains("GiB"), "{err}");
    assert!(nothing_published(&blobs));
}

#[test]
fn a_section_declared_bigger_than_the_file_is_refused() {
    let dir = tmpdir("hostile");
    let (path, _, _) = tiny_file(&dir);
    rewrite_table(&path, |e| {
        if e.kind == KIND_GEOMETRY {
            e.stored_len = 1 << 50;
            e.layout.shard_size = u32::MAX;
        }
    });
    assert!(read_file(&path, &dir.join("blobs"), None, None).err().unwrap().contains("damaged"));
}

/// Rewrite both tables and headers, with `edit` applied to every entry.
pub(super) fn rewrite_table(path: &Path, edit: impl Fn(&mut Entry)) {
    let mut bytes = std::fs::read(path).unwrap();
    let table_a = parse_header(&bytes[0..HEADER_LEN as usize], MAGIC).unwrap().table_a;
    let mut entries = read_index(&mut File::open(path).unwrap(), &mut RepairReport::default()).unwrap();
    entries.iter_mut().for_each(&edit);
    bytes.truncate(table_a as usize);
    let table = encode_table(&entries);
    let crc = crc32fast::hash(&table);
    let table_b = table_a + table.len() as u64;
    bytes.extend_from_slice(&table);
    bytes.extend_from_slice(&table);
    bytes.extend_from_slice(&encode_header(TAIL_MAGIC, table_a, table_b, table.len() as u64, crc));
    bytes[0..HEADER_LEN as usize].copy_from_slice(&encode_header(MAGIC, table_a, table_b, table.len() as u64, crc));
    std::fs::write(path, bytes).unwrap();
}
