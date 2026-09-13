//! The FundaCAD document file, format 2: binary, self-checking and self-repairing.
//! docs/FUNDA-FORMAT.md is the specification; this is the reference writer and
//! reader.
//!
//! Every section (the document, each geometry blob, each cached mesh) is
//! compressed, cut into fixed-size shards, and grouped; each group carries
//! Reed-Solomon parity shards and every shard carries a CRC-32. A reader finds
//! damaged shards by their CRC and rebuilds them from the parity, then proves the
//! result by the section's BLAKE2b hash. The header and the section table are
//! each stored twice, so losing the start or the end of the file is survivable.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use blake2::digest::consts::U16;
use blake2::{Blake2b, Digest};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use reed_solomon_erasure::galois_8::ReedSolomon;

pub const MAGIC: &[u8; 8] = b"FUNDACAD";
pub const TAIL_MAGIC: &[u8; 8] = b"FNDATAIL";
pub const TABLE_MAGIC: &[u8; 4] = b"FTBL";
pub const MAJOR: u16 = 2;
pub const MINOR: u16 = 0;
pub const HEADER_LEN: u64 = 64;

pub const KIND_INFO: u8 = 0;
pub const KIND_DOCUMENT: u8 = 1;
pub const KIND_GEOMETRY: u8 = 2;
pub const KIND_MESH: u8 = 3;

pub const CODEC_RAW: u8 = 0;
pub const CODEC_DEFLATE: u8 = 1;

/// How a section is cut up. Small sections are cheap to protect heavily; a
/// geometry blob can be hundreds of megabytes, so it carries less parity per
/// byte and larger shards.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub shard_size: u32,
    pub data_shards: u16,
    pub parity_shards: u16,
}

pub const SMALL_LAYOUT: Layout = Layout { shard_size: 4096, data_shards: 8, parity_shards: 4 };
pub const LARGE_LAYOUT: Layout = Layout { shard_size: 1 << 16, data_shards: 32, parity_shards: 4 };

/// Cap on what one section may expand to, checked against the declared sizes
/// before anything is inflated.
const MAX_RAW: u64 = 8 << 30;

type Blake2b128 = Blake2b<U16>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub kind: u8,
    pub codec: u8,
    pub name: String,
    pub offset: u64,
    pub stored_len: u64,
    pub raw_len: u64,
    pub raw_hash: [u8; 16],
    pub layout: Layout,
}

impl Entry {
    fn groups(&self) -> u64 {
        let per = self.layout.shard_size as u64 * self.layout.data_shards as u64;
        self.stored_len.div_ceil(per)
    }
    fn shards_per_group(&self) -> u64 {
        self.layout.data_shards as u64 + self.layout.parity_shards as u64
    }
    fn crc_table_offset(&self) -> u64 {
        self.offset + self.groups() * self.shards_per_group() * self.layout.shard_size as u64
    }
}

/// What reading a file had to do to it.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct RepairReport {
    /// shards whose CRC failed and that were rebuilt from parity
    pub repaired_shards: u64,
    /// true when the primary header or table was damaged and a copy was used
    pub used_backup_index: bool,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn looks_like_fnda(path: &Path) -> bool {
    let mut buf = [0u8; 8];
    File::open(path).and_then(|mut f| f.read_exact(&mut buf)).map(|_| &buf == MAGIC).unwrap_or(false)
}

// --- writing ------------------------------------------------------------------

/// A section to write: where its raw bytes come from.
pub enum Source<'a> {
    Bytes(&'a [u8]),
    File(&'a Path),
}

pub struct SectionSpec<'a> {
    pub kind: u8,
    pub name: String,
    pub source: Source<'a>,
    pub layout: Layout,
}

/// The document JSON, as the CBOR the file stores.
pub fn json_to_cbor(json: &str) -> Result<Vec<u8>, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("the document is not valid JSON: {e}"))?;
    let mut out = Vec::new();
    ciborium::into_writer(&value, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn cbor_to_json(cbor: &[u8]) -> Result<String, String> {
    let value: serde_json::Value = ciborium::from_reader(cbor).map_err(|_| DAMAGED.to_string())?;
    serde_json::to_string(&value).map_err(|e| e.to_string())
}

const DAMAGED: &str = "This document is damaged beyond what its error correction can repair.";

/// Write a complete file to `out`. Sections are written in order; the header is
/// filled in last.
pub fn write<W: Write + Seek>(out: &mut W, sections: &[SectionSpec]) -> Result<Vec<Entry>, String> {
    out.write_all(&[0u8; HEADER_LEN as usize]).map_err(io)?;
    let mut entries = Vec::with_capacity(sections.len());
    for s in sections {
        entries.push(write_section(out, s)?);
    }
    let table = encode_table(&entries);
    let table_crc = crc32fast::hash(&table);
    let table_a = out.stream_position().map_err(io)?;
    out.write_all(&table).map_err(io)?;
    let table_b = out.stream_position().map_err(io)?;
    out.write_all(&table).map_err(io)?;
    let header = encode_header(MAGIC, table_a, table_b, table.len() as u64, table_crc);
    out.write_all(&encode_header(TAIL_MAGIC, table_a, table_b, table.len() as u64, table_crc)).map_err(io)?;
    out.seek(SeekFrom::Start(0)).map_err(io)?;
    out.write_all(&header).map_err(io)?;
    out.flush().map_err(io)?;
    Ok(entries)
}

fn io(e: std::io::Error) -> String {
    e.to_string()
}

fn write_section<W: Write + Seek>(out: &mut W, spec: &SectionSpec) -> Result<Entry, String> {
    // Compress into memory for small sources and into a temp file for large
    // ones, hashing the raw bytes on the way.
    let mut hasher = Blake2b128::new();
    let mut raw_len = 0u64;
    let stored: Vec<u8> = {
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        let mut feed = |chunk: &[u8]| -> Result<(), String> {
            hasher.update(chunk);
            raw_len += chunk.len() as u64;
            enc.write_all(chunk).map_err(io)
        };
        match &spec.source {
            Source::Bytes(b) => feed(b)?,
            Source::File(p) => {
                let mut f = BufReader::new(File::open(p).map_err(|e| format!("{}: {e}", p.display()))?);
                let mut buf = vec![0u8; 1 << 20];
                loop {
                    let n = f.read(&mut buf).map_err(io)?;
                    if n == 0 {
                        break;
                    }
                    feed(&buf[..n])?;
                }
            }
        }
        enc.finish().map_err(io)?
    };
    let mut raw_hash = [0u8; 16];
    raw_hash.copy_from_slice(&hasher.finalize());

    let layout = spec.layout;
    let offset = out.stream_position().map_err(io)?;
    let entry = Entry {
        kind: spec.kind,
        codec: CODEC_DEFLATE,
        name: spec.name.clone(),
        offset,
        stored_len: stored.len() as u64,
        raw_len,
        raw_hash,
        layout,
    };
    let rs = ReedSolomon::new(layout.data_shards as usize, layout.parity_shards as usize).map_err(|e| format!("{e:?}"))?;
    let size = layout.shard_size as usize;
    let per_group = size * layout.data_shards as usize;
    let mut crcs: Vec<u32> = Vec::new();
    for g in 0..entry.groups() as usize {
        let start = g * per_group;
        let mut shards: Vec<Vec<u8>> = (0..layout.data_shards as usize + layout.parity_shards as usize)
            .map(|i| {
                let mut shard = vec![0u8; size];
                if i < layout.data_shards as usize {
                    let from = (start + i * size).min(stored.len());
                    let to = (start + (i + 1) * size).min(stored.len());
                    shard[..to - from].copy_from_slice(&stored[from..to]);
                }
                shard
            })
            .collect();
        rs.encode(&mut shards).map_err(|e| format!("{e:?}"))?;
        for shard in &shards {
            crcs.push(crc32fast::hash(shard));
            out.write_all(shard).map_err(io)?;
        }
    }
    for c in crcs {
        out.write_all(&c.to_le_bytes()).map_err(io)?;
    }
    Ok(entry)
}

fn encode_header(magic: &[u8; 8], table_a: u64, table_b: u64, table_len: u64, table_crc: u32) -> [u8; HEADER_LEN as usize] {
    let mut h = [0u8; HEADER_LEN as usize];
    h[0..8].copy_from_slice(magic);
    h[8..10].copy_from_slice(&MAJOR.to_le_bytes());
    h[10..12].copy_from_slice(&MINOR.to_le_bytes());
    h[16..24].copy_from_slice(&table_a.to_le_bytes());
    h[24..32].copy_from_slice(&table_b.to_le_bytes());
    h[32..40].copy_from_slice(&table_len.to_le_bytes());
    h[40..44].copy_from_slice(&table_crc.to_le_bytes());
    let crc = crc32fast::hash(&h[0..56]);
    h[56..60].copy_from_slice(&crc.to_le_bytes());
    h
}

fn encode_table(entries: &[Entry]) -> Vec<u8> {
    let mut t = Vec::new();
    t.extend_from_slice(TABLE_MAGIC);
    t.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for e in entries {
        t.push(e.kind);
        t.push(e.codec);
        t.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        t.extend_from_slice(e.name.as_bytes());
        t.extend_from_slice(&e.offset.to_le_bytes());
        t.extend_from_slice(&e.stored_len.to_le_bytes());
        t.extend_from_slice(&e.raw_len.to_le_bytes());
        t.extend_from_slice(&e.raw_hash);
        t.extend_from_slice(&e.layout.shard_size.to_le_bytes());
        t.extend_from_slice(&e.layout.data_shards.to_le_bytes());
        t.extend_from_slice(&e.layout.parity_shards.to_le_bytes());
    }
    t
}

// --- reading ------------------------------------------------------------------

struct Header {
    table_a: u64,
    table_b: u64,
    table_len: u64,
    table_crc: u32,
}

fn parse_header(h: &[u8], magic: &[u8; 8]) -> Option<Header> {
    if h.len() < HEADER_LEN as usize || &h[0..8] != magic {
        return None;
    }
    let crc = u32::from_le_bytes(h[56..60].try_into().ok()?);
    if crc32fast::hash(&h[0..56]) != crc {
        return None;
    }
    let u64at = |i: usize| u64::from_le_bytes(h[i..i + 8].try_into().unwrap());
    Some(Header {
        table_a: u64at(16),
        table_b: u64at(24),
        table_len: u64at(32),
        table_crc: u32::from_le_bytes(h[40..44].try_into().ok()?),
    })
}

fn major_of(h: &[u8]) -> u16 {
    u16::from_le_bytes([h[8], h[9]])
}

fn decode_table(t: &[u8]) -> Option<Vec<Entry>> {
    if t.len() < 8 || &t[0..4] != TABLE_MAGIC {
        return None;
    }
    let count = u32::from_le_bytes(t[4..8].try_into().ok()?) as usize;
    let mut at = 8usize;
    let mut take = |n: usize| -> Option<&[u8]> {
        let s = t.get(at..at + n)?;
        at += n;
        Some(s)
    };
    let mut out = Vec::with_capacity(count.min(1 << 16));
    for _ in 0..count {
        let kind = take(1)?[0];
        let codec = take(1)?[0];
        let name_len = u16::from_le_bytes(take(2)?.try_into().ok()?) as usize;
        let name = String::from_utf8(take(name_len)?.to_vec()).ok()?;
        let offset = u64::from_le_bytes(take(8)?.try_into().ok()?);
        let stored_len = u64::from_le_bytes(take(8)?.try_into().ok()?);
        let raw_len = u64::from_le_bytes(take(8)?.try_into().ok()?);
        let mut raw_hash = [0u8; 16];
        raw_hash.copy_from_slice(take(16)?);
        let shard_size = u32::from_le_bytes(take(4)?.try_into().ok()?);
        let data_shards = u16::from_le_bytes(take(2)?.try_into().ok()?);
        let parity_shards = u16::from_le_bytes(take(2)?.try_into().ok()?);
        if shard_size == 0 || data_shards == 0 || data_shards as u32 + parity_shards as u32 > 255 {
            return None;
        }
        out.push(Entry { kind, codec, name, offset, stored_len, raw_len, raw_hash, layout: Layout { shard_size, data_shards, parity_shards } });
    }
    Some(out)
}

/// The section table, from whichever copy of the header and table survives.
pub fn read_index(f: &mut File, report: &mut RepairReport) -> Result<Vec<Entry>, String> {
    let len = f.metadata().map_err(io)?.len();
    if len < HEADER_LEN * 2 {
        return Err(DAMAGED.to_string());
    }
    let mut head = vec![0u8; HEADER_LEN as usize];
    f.seek(SeekFrom::Start(0)).map_err(io)?;
    f.read_exact(&mut head).map_err(io)?;
    if &head[0..8] == MAGIC && major_of(&head) > MAJOR {
        return Err(format!("This document uses a newer FundaCAD file format (v{}). Update FundaCAD to open it.", major_of(&head)));
    }
    let mut tail = vec![0u8; HEADER_LEN as usize];
    f.seek(SeekFrom::Start(len - HEADER_LEN)).map_err(io)?;
    f.read_exact(&mut tail).map_err(io)?;

    let headers = [parse_header(&head, MAGIC), parse_header(&tail, TAIL_MAGIC)];
    for (hi, h) in headers.iter().enumerate() {
        let Some(h) = h else { continue };
        if h.table_len > 64 << 20 {
            continue;
        }
        for (ti, off) in [h.table_a, h.table_b].into_iter().enumerate() {
            if off.saturating_add(h.table_len) > len {
                continue;
            }
            let mut t = vec![0u8; h.table_len as usize];
            if f.seek(SeekFrom::Start(off)).is_err() || f.read_exact(&mut t).is_err() {
                continue;
            }
            if crc32fast::hash(&t) != h.table_crc {
                continue;
            }
            if let Some(entries) = decode_table(&t) {
                if hi > 0 || ti > 0 {
                    report.used_backup_index = true;
                }
                return Ok(entries);
            }
        }
    }
    Err(DAMAGED.to_string())
}

/// Reads a section's stored bytes, repairing each group as it is reached.
struct SectionReader<'a> {
    file: &'a mut File,
    entry: Entry,
    rs: ReedSolomon,
    crcs: Vec<u32>,
    group: u64,
    buf: Vec<u8>,
    pos: usize,
    remaining: u64,
    repaired: u64,
}

impl<'a> SectionReader<'a> {
    fn new(file: &'a mut File, entry: &Entry) -> Result<Self, String> {
        let l = entry.layout;
        let rs = ReedSolomon::new(l.data_shards as usize, l.parity_shards as usize).map_err(|_| DAMAGED.to_string())?;
        let count = entry.groups() * entry.shards_per_group();
        let mut raw = vec![0u8; (count * 4) as usize];
        file.seek(SeekFrom::Start(entry.crc_table_offset())).map_err(io)?;
        // A CRC table cut short leaves its missing entries at zero, so those
        // shards read as damaged and parity takes over.
        let _ = read_fully(file, &mut raw);
        let crcs = raw.chunks(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        Ok(Self { file, entry: entry.clone(), rs, crcs, group: 0, buf: Vec::new(), pos: 0, remaining: entry.stored_len, repaired: 0 })
    }

    fn load_group(&mut self) -> std::io::Result<()> {
        let l = self.entry.layout;
        let size = l.shard_size as usize;
        let n = self.entry.shards_per_group() as usize;
        let base = self.entry.offset + self.group * n as u64 * size as u64;
        self.file.seek(SeekFrom::Start(base))?;
        let mut shards: Vec<Option<Vec<u8>>> = Vec::with_capacity(n);
        let mut bad = 0u64;
        for i in 0..n {
            let mut shard = vec![0u8; size];
            let got = read_fully(self.file, &mut shard)?;
            let idx = (self.group as usize) * n + i;
            let ok = got == size && self.crcs.get(idx).is_some_and(|c| *c == crc32fast::hash(&shard));
            if ok {
                shards.push(Some(shard));
            } else {
                shards.push(None);
                if i < l.data_shards as usize {
                    bad += 1;
                }
            }
        }
        if shards[..l.data_shards as usize].iter().any(|s| s.is_none()) {
            self.rs
                .reconstruct_data(&mut shards)
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, DAMAGED))?;
            self.repaired += bad;
        }
        self.buf.clear();
        for s in shards.into_iter().take(l.data_shards as usize) {
            self.buf.extend_from_slice(&s.expect("reconstructed"));
        }
        let keep = (self.remaining as usize).min(self.buf.len());
        self.buf.truncate(keep);
        self.remaining -= keep as u64;
        self.pos = 0;
        self.group += 1;
        Ok(())
    }
}

impl Read for SectionReader<'_> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            if self.remaining == 0 {
                return Ok(0);
            }
            self.load_group()?;
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
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

/// Stream a section's raw bytes into `sink`, repaired and verified.
fn read_section<S: Write>(file: &mut File, entry: &Entry, sink: &mut S, report: &mut RepairReport) -> Result<(), String> {
    if entry.raw_len > MAX_RAW {
        return Err(format!("This document expands to more than {} GiB and was refused.", MAX_RAW >> 30));
    }
    let mut reader = SectionReader::new(file, entry)?;
    let mut hasher = Blake2b128::new();
    let mut total = 0u64;
    let mut buf = vec![0u8; 1 << 20];
    {
        let mut decoded: Box<dyn Read> = match entry.codec {
            CODEC_DEFLATE => Box::new(DeflateDecoder::new(&mut reader)),
            CODEC_RAW => Box::new(&mut reader),
            _ => return Err(DAMAGED.to_string()),
        };
        loop {
            let n = decoded.read(&mut buf).map_err(|_| DAMAGED.to_string())?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > entry.raw_len {
                return Err(DAMAGED.to_string());
            }
            hasher.update(&buf[..n]);
            sink.write_all(&buf[..n]).map_err(io)?;
        }
    }
    report.repaired_shards += reader.repaired;
    if total != entry.raw_len || hasher.finalize().as_slice() != entry.raw_hash {
        return Err(DAMAGED.to_string());
    }
    Ok(())
}

pub struct Opened {
    pub document_json: String,
    pub entries: Vec<Entry>,
    pub report: RepairReport,
}

/// Open a file: the document as JSON, with every geometry blob and cached mesh
/// extracted into its store, each verified before it is published under its hash.
pub fn read_file(path: &Path, blob_dir: &Path, mesh_dir: Option<&Path>) -> Result<Opened, String> {
    let mut f = File::open(path).map_err(io)?;
    let mut report = RepairReport::default();
    let entries = read_index(&mut f, &mut report)?;
    let doc = entries.iter().find(|e| e.kind == KIND_DOCUMENT).ok_or_else(|| DAMAGED.to_string())?;
    let mut cbor = Vec::new();
    read_section(&mut f, doc, &mut cbor, &mut report)?;
    let document_json = cbor_to_json(&cbor)?;

    std::fs::create_dir_all(blob_dir).map_err(io)?;
    for e in entries.iter().filter(|e| e.kind == KIND_GEOMETRY) {
        let hash = hex(&e.raw_hash);
        if e.name != hash {
            return Err(DAMAGED.to_string());
        }
        let dest = blob_dir.join(format!("{hash}.bbrep"));
        if dest.exists() {
            continue;
        }
        extract(&mut f, e, &dest, &mut report)?;
    }
    if let Some(dir) = mesh_dir {
        std::fs::create_dir_all(dir).map_err(io)?;
        for e in entries.iter().filter(|e| e.kind == KIND_MESH) {
            if !safe_key(&e.name) {
                continue;
            }
            let dest = dir.join(format!("{}.bin", e.name));
            // A cached mesh that fails costs a re-tessellation, never the open.
            let _ = extract(&mut f, e, &dest, &mut report);
        }
    }
    Ok(Opened { document_json, entries, report })
}

fn safe_key(key: &str) -> bool {
    !key.is_empty() && !key.contains("..") && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn extract(f: &mut File, e: &Entry, dest: &Path, report: &mut RepairReport) -> Result<(), String> {
    let mut tmp = dest.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut run = || -> Result<(), String> {
        let mut out = BufWriter::new(File::create(&tmp).map_err(io)?);
        read_section(f, e, &mut out, report)?;
        let file = out.into_inner().map_err(|e| e.to_string())?;
        file.sync_all().map_err(io)
    };
    if let Err(err) = run() {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    std::fs::rename(&tmp, dest).map_err(io)
}

/// Check every section of a file without extracting anything.
pub fn verify(path: &Path) -> Result<RepairReport, String> {
    let mut f = File::open(path).map_err(io)?;
    let mut report = RepairReport::default();
    let entries = read_index(&mut f, &mut report)?;
    for e in &entries {
        read_section(&mut f, e, &mut std::io::sink(), &mut report)?;
    }
    Ok(report)
}

/// Sections for a document and the geometry it references.
pub fn document_sections<'a>(
    info_cbor: &'a [u8],
    document_cbor: &'a [u8],
    blobs: &'a BTreeMap<String, PathBuf>,
    meshes: &'a BTreeMap<String, PathBuf>,
) -> Vec<SectionSpec<'a>> {
    let mut out = vec![
        SectionSpec { kind: KIND_INFO, name: "info".into(), source: Source::Bytes(info_cbor), layout: SMALL_LAYOUT },
        SectionSpec { kind: KIND_DOCUMENT, name: "document".into(), source: Source::Bytes(document_cbor), layout: SMALL_LAYOUT },
    ];
    for (hash, path) in blobs {
        out.push(SectionSpec { kind: KIND_GEOMETRY, name: hash.clone(), source: Source::File(path), layout: LARGE_LAYOUT });
    }
    for (key, path) in meshes {
        out.push(SectionSpec { kind: KIND_MESH, name: key.clone(), source: Source::File(path), layout: LARGE_LAYOUT });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

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
        write(&mut file, &document_sections(&info, &cbor, &blobs, &meshes)).unwrap();
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
        let opened = read_file(&path, &blobs, None).unwrap();
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
            let hits: &[usize] = if e.kind == KIND_GEOMETRY { &[0, 5, 9] } else if e.kind == KIND_DOCUMENT { &[0, 2] } else { &[] };
            for &i in hits {
                let at = e.offset as usize + i * size + 17;
                for b in &mut bytes[at..at + 40] {
                    *b ^= 0xA5;
                }
            }
        }
        std::fs::write(&path, &bytes).unwrap();
        let blobs = dir.join("blobs");
        let opened = read_file(&path, &blobs, None).unwrap();
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
        let opened = read_file(&path, &dir.join("blobs"), None).unwrap();
        assert!(same_json(&opened.document_json, &doc));
        assert!(opened.report.used_backup_index);
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
        let err = read_file(&path, &dir.join("blobs"), None).err().unwrap();
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
        let entries = write(&mut out, &document_sections(&info, &cbor, &b, &m)).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(&out.get_ref()[0..8], MAGIC);
    }
}
