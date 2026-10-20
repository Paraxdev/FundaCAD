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
use std::sync::atomic::{AtomicUsize, Ordering};

use blake2::digest::consts::U16;
use blake2::{Blake2b, Digest};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use reed_solomon_erasure::galois_8::ReedSolomon;

use crate::{par, pread, segments};

pub const MAGIC: &[u8; 8] = b"FUNDACAD";
pub const TAIL_MAGIC: &[u8; 8] = b"FNDATAIL";
pub const TABLE_MAGIC: &[u8; 4] = b"FTBL";
pub const MAJOR: u16 = 2;
pub const MINOR: u16 = 1;
pub const HEADER_LEN: u64 = 64;

pub const KIND_INFO: u8 = 0;
pub const KIND_DOCUMENT: u8 = 1;
pub const KIND_GEOMETRY: u8 = 2;
pub const KIND_MESH: u8 = 3;
/// Where the segments of the big sections start, see `segments`.
pub const KIND_SEGMENTS: u8 = 4;

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
const MIN_SHARD: u32 = 64;

/// A section smaller than one full group gets smaller and fewer data shards, so
/// a 70 KB part is not padded out to a 2 MB group. The parity count stays.
pub fn fit_layout(most: Layout, stored_len: u64) -> Layout {
    let k_max = most.data_shards as u64;
    let shard = stored_len.div_ceil(k_max).clamp(MIN_SHARD as u64, most.shard_size as u64);
    let k = stored_len.div_ceil(shard).clamp(1, k_max);
    Layout { shard_size: shard as u32, data_shards: k as u16, parity_shards: most.parity_shards }
}

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

/// How a file is written. Only the speed depends on `threads`, never the bytes.
#[derive(Clone, Copy, Debug)]
pub struct WriteOptions {
    /// raw bytes per segment of a big section
    pub segment_raw: usize,
    pub threads: usize,
}

impl Default for WriteOptions {
    fn default() -> Self {
        WriteOptions { segment_raw: segments::DEFAULT_SEGMENT_RAW, threads: par::threads() }
    }
}

/// Write a complete file to `out`. Sections are written in order, then the
/// segment index of the big ones; the header is filled in last.
pub fn write<W: Write + Seek>(out: &mut W, sections: &[SectionSpec]) -> Result<Vec<Entry>, String> {
    write_with(out, sections, &WriteOptions::default())
}

pub fn write_with<W: Write + Seek>(out: &mut W, sections: &[SectionSpec], o: &WriteOptions) -> Result<Vec<Entry>, String> {
    out.write_all(&[0u8; HEADER_LEN as usize]).map_err(io)?;
    let mut entries = Vec::with_capacity(sections.len() + 1);
    let mut rows = Vec::new();
    // An index is never carried: it would describe the sections of another write.
    for s in sections.iter().filter(|s| s.kind != KIND_SEGMENTS) {
        let (entry, row) = write_section(out, s, o)?;
        entries.push(entry);
        rows.extend(row);
    }
    if !rows.is_empty() {
        let index = segments::encode(&rows);
        let spec = SectionSpec { kind: KIND_SEGMENTS, name: "segments".into(), source: Source::Bytes(&index), layout: SMALL_LAYOUT };
        entries.push(write_section(out, &spec, o)?.0);
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

/// A section's raw bytes, from memory or read from its file a window at a time.
enum RawFeed<'a> {
    Bytes(&'a [u8]),
    File(BufReader<File>, u64),
}

impl<'a> RawFeed<'a> {
    fn open(source: &Source<'a>) -> Result<Self, String> {
        Ok(match source {
            Source::Bytes(b) => RawFeed::Bytes(b),
            Source::File(p) => {
                let f = File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
                let len = f.metadata().map_err(io)?.len();
                RawFeed::File(BufReader::with_capacity(1 << 20, f), len)
            }
        })
    }

    fn len(&self) -> u64 {
        match self {
            RawFeed::Bytes(b) => b.len() as u64,
            RawFeed::File(_, len) => *len,
        }
    }

    /// Up to `n` bytes at `at`, `at` being where the previous call stopped.
    fn next<'b>(&'b mut self, at: u64, n: usize, buf: &'b mut Vec<u8>) -> Result<&'b [u8], String> {
        match self {
            RawFeed::Bytes(b) => {
                let from = (at as usize).min(b.len());
                Ok(&b[from..(from + n).min(b.len())])
            }
            RawFeed::File(f, _) => {
                buf.resize(n, 0);
                let mut got = 0;
                while got < n {
                    match f.read(&mut buf[got..]).map_err(io)? {
                        0 => break,
                        k => got += k,
                    }
                }
                buf.truncate(got);
                Ok(&buf[..])
            }
        }
    }
}

/// A section of at least two segments is compressed in segments, on all
/// threads, and described by a row of the segment index.
fn write_section<W: Write + Seek>(out: &mut W, spec: &SectionSpec, o: &WriteOptions) -> Result<(Entry, Option<segments::Row>), String> {
    let mut hasher = Blake2b128::new();
    let mut feed = RawFeed::open(&spec.source)?;
    let total = feed.len();
    let seg = o.segment_raw.max(1024);
    let segmented = total >= 2 * seg as u64;
    let mut segs: Vec<segments::Segment> = Vec::new();
    let mut raw_len = 0u64;
    let mut buf = Vec::new();
    let stored: Vec<u8> = if segmented {
        let window = seg * 4 * o.threads.max(1);
        let mut stored = Vec::with_capacity((total / 2) as usize);
        while raw_len < total {
            let want = window.min((total - raw_len) as usize);
            let chunk = feed.next(raw_len, want, &mut buf)?;
            if chunk.len() != want {
                return Err(format!("{} changed while it was being saved", spec.name));
            }
            hasher.update(chunk);
            let ends = raw_len + want as u64 == total;
            let pieces: Vec<&[u8]> = chunk.chunks(seg).collect();
            let last = pieces.len() - 1;
            let packed = par::map_indexed(pieces.len(), o.threads, |i| segments::compress(pieces[i], ends && i == last));
            for (piece, s) in pieces.iter().zip(packed) {
                let s = s.map_err(io)?;
                segs.push(segments::Segment { stored: s.len() as u32, raw: piece.len() as u32 });
                stored.extend_from_slice(&s);
            }
            raw_len += want as u64;
        }
        stored
    } else {
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
        loop {
            let chunk = feed.next(raw_len, 1 << 20, &mut buf)?;
            if chunk.is_empty() {
                break;
            }
            hasher.update(chunk);
            enc.write_all(chunk).map_err(io)?;
            raw_len += chunk.len() as u64;
        }
        enc.finish().map_err(io)?
    };
    let mut raw_hash = [0u8; 16];
    raw_hash.copy_from_slice(&hasher.finalize());

    let layout = fit_layout(spec.layout, stored.len() as u64);
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
    let mut crc_table: Vec<u8> = Vec::new();
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
            crc_table.extend_from_slice(&crc32fast::hash(shard).to_le_bytes());
            out.write_all(shard).map_err(io)?;
        }
    }
    out.write_all(&crc_table).map_err(io)?;
    let row = segmented.then(|| segments::Row {
        kind: entry.kind,
        codec: entry.codec,
        raw_hash,
        stored_len: entry.stored_len,
        crc_table_crc: crc32fast::hash(&crc_table),
        segments: segs,
    });
    Ok((entry, row))
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

/// A section's CRC table and the CRC-32 of its bytes, which the segment index
/// records. A table cut short leaves its missing entries at zero, so those
/// shards read as damaged and parity takes over.
fn read_crcs(file: &File, entry: &Entry) -> Result<(Vec<u32>, u32), String> {
    let len = file.metadata().map_err(io)?.len();
    let count = entry.groups() * entry.shards_per_group();
    let group_bytes = entry.layout.shard_size as u64 * entry.shards_per_group();
    // Declared sizes larger than the file itself can only come from a hostile
    // table, and would otherwise size the buffers below.
    if entry.stored_len > len || count.saturating_mul(4) > len || group_bytes > len {
        return Err(DAMAGED.to_string());
    }
    let mut raw = vec![0u8; (count * 4) as usize];
    let _ = pread::read_at(file, &mut raw, entry.crc_table_offset());
    let crcs = raw.chunks(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
    Ok((crcs, crc32fast::hash(&raw)))
}

fn rs_of(entry: &Entry) -> Result<ReedSolomon, String> {
    ReedSolomon::new(entry.layout.data_shards as usize, entry.layout.parity_shards as usize).map_err(|_| DAMAGED.to_string())
}

/// The stored bytes of group `g`, repaired, and how many data shards that took.
/// The data shards come in one read; the parity shards are read only when one
/// of them fails its CRC.
fn load_group(file: &File, entry: &Entry, rs: &ReedSolomon, crcs: &[u32], g: u64) -> std::io::Result<(Vec<u8>, u64)> {
    let l = entry.layout;
    let size = l.shard_size as usize;
    let (k, m) = (l.data_shards as usize, l.parity_shards as usize);
    let base = entry.offset + g * (k + m) as u64 * size as u64;
    let first = g as usize * (k + m);
    let good = |i: usize, shard: &[u8]| shard.len() == size && crcs.get(first + i).is_some_and(|c| *c == crc32fast::hash(shard));

    let mut data = vec![0u8; k * size];
    let got = pread::read_at(file, &mut data, base)?;
    data.truncate(got);
    let bad: Vec<bool> = (0..k).map(|i| !good(i, data.get(i * size..(i + 1) * size).unwrap_or(&[]))).collect();
    let repaired = bad.iter().filter(|b| **b).count() as u64;
    if repaired > 0 {
        let mut parity = vec![0u8; m * size];
        let got = pread::read_at(file, &mut parity, base + (k * size) as u64)?;
        parity.truncate(got);
        let mut shards: Vec<Option<Vec<u8>>> = (0..k)
            .map(|i| (!bad[i]).then(|| data[i * size..(i + 1) * size].to_vec()))
            .chain((0..m).map(|i| parity.get(i * size..(i + 1) * size).filter(|s| good(k + i, s)).map(<[u8]>::to_vec)))
            .collect();
        rs.reconstruct_data(&mut shards).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, DAMAGED))?;
        data = shards.into_iter().take(k).flat_map(|s| s.expect("reconstructed")).collect();
    }
    let keep = (entry.stored_len - (g * (k * size) as u64)).min(data.len() as u64);
    data.truncate(keep as usize);
    Ok((data, repaired))
}

/// Reads a section's stored bytes, repairing each group as it is reached.
struct SectionReader<'a> {
    file: &'a File,
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
    fn new(file: &'a File, entry: &Entry) -> Result<Self, String> {
        let (crcs, _) = read_crcs(file, entry)?;
        Self::with_crcs(file, entry, crcs)
    }

    fn with_crcs(file: &'a File, entry: &Entry, crcs: Vec<u32>) -> Result<Self, String> {
        Ok(Self { file, entry: entry.clone(), rs: rs_of(entry)?, crcs, group: 0, buf: Vec::new(), pos: 0, remaining: entry.stored_len, repaired: 0 })
    }

    fn next_group(&mut self) -> std::io::Result<()> {
        let (buf, repaired) = load_group(self.file, &self.entry, &self.rs, &self.crcs, self.group)?;
        self.remaining -= buf.len() as u64;
        self.buf = buf;
        self.repaired += repaired;
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
            self.next_group()?;
            if self.buf.is_empty() {
                return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, DAMAGED));
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Stream a section's raw bytes into `sink`, repaired and verified.
fn read_section<S: Write>(file: &File, entry: &Entry, sink: &mut S, report: &mut RepairReport) -> Result<(), String> {
    check_raw_len(entry)?;
    let reader = SectionReader::new(file, entry)?;
    decode_section(reader, entry, sink, report)
}

fn check_raw_len(entry: &Entry) -> Result<(), String> {
    if entry.raw_len > MAX_RAW {
        return Err(format!("This document expands to more than {} GiB and was refused.", MAX_RAW >> 30));
    }
    Ok(())
}

fn decode_section<S: Write>(mut reader: SectionReader, entry: &Entry, sink: &mut S, report: &mut RepairReport) -> Result<(), String> {
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

/// A section of a kind this version does not read, copied out on open so a save
/// can write it back unchanged (docs/FUNDA-FORMAT.md, "Files from a newer version").
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Carried {
    pub kind: u8,
    pub name: String,
    /// `raw_hash` in hex, also the file name in the carry folder
    pub hash: String,
}

/// Only a codec this version can decode can be verified and written back.
pub fn carries(e: &Entry) -> bool {
    e.kind > KIND_SEGMENTS && matches!(e.codec, CODEC_RAW | CODEC_DEFLATE)
}

pub struct Opened {
    pub document_json: String,
    pub entries: Vec<Entry>,
    pub report: RepairReport,
    pub carried: Vec<Carried>,
}

/// How a file is read. Only the speed depends on `threads`, never the result.
#[derive(Clone, Copy, Debug)]
pub struct ReadOptions {
    pub threads: usize,
}

impl Default for ReadOptions {
    fn default() -> Self {
        ReadOptions { threads: par::threads() }
    }
}

/// Open a file: the document as JSON, with every geometry blob and cached mesh
/// extracted into its store, each verified before it is published under its hash.
/// With `carry_dir`, sections of a kind this version does not read land there too.
pub fn read_file(path: &Path, blob_dir: &Path, mesh_dir: Option<&Path>, carry_dir: Option<&Path>) -> Result<Opened, String> {
    read_file_with(path, blob_dir, mesh_dir, carry_dir, &ReadOptions::default())
}

enum Role {
    Geometry,
    Mesh,
    Carried(usize),
}

struct Job<'a> {
    entry: &'a Entry,
    dest: PathBuf,
    role: Role,
    rows: Vec<&'a segments::Row>,
}

/// Sections the segment index describes are decoded one at a time on all
/// threads; the others are extracted side by side, one per thread.
pub fn read_file_with(path: &Path, blob_dir: &Path, mesh_dir: Option<&Path>, carry_dir: Option<&Path>, o: &ReadOptions) -> Result<Opened, String> {
    let mut f = File::open(path).map_err(io)?;
    let mut report = RepairReport::default();
    let entries = read_index(&mut f, &mut report)?;
    let doc = entries.iter().find(|e| e.kind == KIND_DOCUMENT).ok_or_else(|| DAMAGED.to_string())?;
    let mut cbor = Vec::new();
    read_section(&f, doc, &mut cbor, &mut report)?;
    let document_json = cbor_to_json(&cbor)?;
    let rows = segment_rows(&f, &entries, &mut report);
    let rows_of = |e: &Entry| -> Vec<&segments::Row> {
        rows.iter().filter(|r| r.kind == e.kind && r.raw_hash == e.raw_hash && r.stored_len == e.stored_len).collect()
    };

    let mut jobs = Vec::new();
    std::fs::create_dir_all(blob_dir).map_err(io)?;
    for e in entries.iter().filter(|e| e.kind == KIND_GEOMETRY) {
        let hash = hex(&e.raw_hash);
        if e.name != hash {
            return Err(DAMAGED.to_string());
        }
        let dest = blob_dir.join(format!("{hash}.bbrep"));
        if !published(&dest, e.raw_len) {
            jobs.push(Job { entry: e, dest, role: Role::Geometry, rows: rows_of(e) });
        }
    }
    if let Some(dir) = mesh_dir {
        std::fs::create_dir_all(dir).map_err(io)?;
        for e in entries.iter().filter(|e| e.kind == KIND_MESH && safe_key(&e.name)) {
            jobs.push(Job { entry: e, dest: dir.join(format!("{}.bin", e.name)), role: Role::Mesh, rows: rows_of(e) });
        }
    }
    let mut carried: Vec<(Carried, bool)> = Vec::new();
    if let Some(dir) = carry_dir {
        std::fs::create_dir_all(dir).map_err(io)?;
        for e in entries.iter().filter(|e| carries(e)) {
            let hash = hex(&e.raw_hash);
            let dest = dir.join(format!("{hash}.bin"));
            let have = published(&dest, e.raw_len);
            if !have {
                jobs.push(Job { entry: e, dest, role: Role::Carried(carried.len()), rows: rows_of(e) });
            }
            carried.push((Carried { kind: e.kind, name: e.name.clone(), hash }, have));
        }
    }

    let mut results: Vec<Option<Result<RepairReport, String>>> = jobs.iter().map(|_| None).collect();
    let (big, small): (Vec<usize>, Vec<usize>) = (0..jobs.len()).partition(|&i| !jobs[i].rows.is_empty());
    for &i in &big {
        results[i] = Some(extract(&f, jobs[i].entry, &jobs[i].dest, &jobs[i].rows, o.threads));
    }
    let done = par::map_indexed(small.len(), o.threads, |n| {
        let j = &jobs[small[n]];
        extract(&f, j.entry, &j.dest, &[], 1)
    });
    for (n, r) in done.into_iter().enumerate() {
        results[small[n]] = Some(r);
    }
    for (job, r) in jobs.iter().zip(results) {
        match (r.expect("every job ran"), &job.role) {
            (Ok(r), role) => {
                report.repaired_shards += r.repaired_shards;
                if let Role::Carried(i) = role {
                    carried[*i].1 = true;
                }
            }
            (Err(err), Role::Geometry) => return Err(err),
            // A cached mesh that fails costs a re-tessellation, and a section
            // this version does not read never blocks the open.
            (Err(_), Role::Mesh | Role::Carried(_)) => {}
        }
    }
    let carried = carried.into_iter().filter(|(_, ok)| *ok).map(|(c, _)| c).collect();
    Ok(Opened { document_json, entries, report, carried })
}

/// The rows of the file's segment index, none when it has none or it cannot be read.
fn segment_rows(f: &File, entries: &[Entry], report: &mut RepairReport) -> Vec<segments::Row> {
    let Some(e) = entries.iter().find(|e| e.kind == KIND_SEGMENTS && e.raw_len <= segments::MAX_INDEX_RAW) else {
        return Vec::new();
    };
    let mut bytes = Vec::new();
    let mut mine = RepairReport::default();
    if read_section(f, e, &mut bytes, &mut mine).is_err() {
        return Vec::new();
    }
    report.repaired_shards += mine.repaired_shards;
    segments::decode(&bytes)
}

/// A blob already in a store is trusted by its name only when it is whole.
fn published(dest: &Path, raw_len: u64) -> bool {
    std::fs::metadata(dest).is_ok_and(|m| m.is_file() && m.len() == raw_len)
}

fn safe_key(key: &str) -> bool {
    !key.is_empty() && !key.contains("..") && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

static TMP_SERIAL: AtomicUsize = AtomicUsize::new(0);

/// Decode one section into `dest`, through a temporary name of its own so two
/// opens of the same file never write into each other. Every thread reads
/// through the one handle the open started with: a save that renames a new file
/// over the path meanwhile must not mix its sections into this read.
fn extract(file: &File, e: &Entry, dest: &Path, rows: &[&segments::Row], threads: usize) -> Result<RepairReport, String> {
    check_raw_len(e)?;
    let mut tmp = dest.as_os_str().to_os_string();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), TMP_SERIAL.fetch_add(1, Ordering::Relaxed)));
    let tmp = PathBuf::from(tmp);
    let report = match extract_to(file, e, &tmp, rows, threads) {
        Ok(r) => r,
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(err);
        }
    };
    match std::fs::rename(&tmp, dest) {
        Ok(()) => Ok(report),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            // Another open published the same verified bytes first and holds them open.
            if published(dest, e.raw_len) { Ok(report) } else { Err(io(err)) }
        }
    }
}

fn extract_to(file: &File, e: &Entry, tmp: &Path, rows: &[&segments::Row], threads: usize) -> Result<RepairReport, String> {
    let (crcs, table_crc) = read_crcs(file, e)?;
    let finish = |out: BufWriter<File>| -> Result<(), String> { out.into_inner().map_err(|e| e.to_string())?.sync_all().map_err(io) };
    if let Some(row) = rows.iter().find(|r| segments::matches(r, e.kind, e.codec, &e.raw_hash, e.stored_len, e.raw_len, table_crc)) {
        let mut out = BufWriter::new(File::create(tmp).map_err(io)?);
        if let Some(report) = read_segmented(file, e, row, &crcs, threads, &mut out)? {
            finish(out)?;
            return Ok(report);
        }
    }
    let mut report = RepairReport::default();
    let mut out = BufWriter::new(File::create(tmp).map_err(io)?);
    decode_section(SectionReader::with_crcs(file, e, crcs)?, e, &mut out, &mut report)?;
    finish(out)?;
    Ok(report)
}

/// Decode a section by the segments its index row names: groups are read and
/// repaired a window at a time on all threads, the segments that end inside
/// the window are inflated on all threads, then hashed and written in order.
/// None when a segment or the whole does not come out as the row promised, so
/// the caller reads the section as one stream instead. Damage beyond the
/// parity is an error either way.
fn read_segmented<W: Write>(file: &File, e: &Entry, row: &segments::Row, crcs: &[u32], threads: usize, out: &mut W) -> Result<Option<RepairReport>, String> {
    let rs = rs_of(e)?;
    let groups = e.groups();
    let window = 2 * threads.max(1) as u64;
    let mut report = RepairReport::default();
    let mut hasher = Blake2b128::new();
    let mut pending: Vec<u8> = Vec::new();
    let (mut seg, mut g) = (0usize, 0u64);
    while g < groups {
        let n = window.min(groups - g);
        let loaded = par::map_indexed(n as usize, threads, |i| load_group(file, e, &rs, crcs, g + i as u64));
        for l in loaded {
            let (bytes, repaired) = l.map_err(|_| DAMAGED.to_string())?;
            report.repaired_shards += repaired;
            pending.extend_from_slice(&bytes);
        }
        g += n;
        let first = seg;
        let mut spans = Vec::new();
        let mut end = 0usize;
        while let Some(s) = row.segments.get(seg).filter(|s| end + s.stored as usize <= pending.len()) {
            spans.push((end, end + s.stored as usize, s.raw as usize));
            end += s.stored as usize;
            seg += 1;
        }
        let decoded = par::map_indexed(seg - first, threads, |i| {
            let (a, b, raw) = spans[i];
            segments::inflate(&pending[a..b], raw)
        });
        for d in decoded {
            let Some(d) = d else { return Ok(None) };
            hasher.update(&d);
            out.write_all(&d).map_err(io)?;
        }
        pending.drain(..end);
    }
    let whole = seg == row.segments.len() && pending.is_empty() && hasher.finalize().as_slice() == e.raw_hash;
    Ok(whole.then_some(report))
}

/// The raw bytes of the first section of `kind`, None when the file has none.
/// Reads that one section only, so the geometry of a large file costs nothing.
pub fn read_section_of_kind(path: &Path, kind: u8) -> Result<Option<Vec<u8>>, String> {
    let mut f = File::open(path).map_err(io)?;
    let mut report = RepairReport::default();
    let entries = read_index(&mut f, &mut report)?;
    let Some(entry) = entries.iter().find(|e| e.kind == kind) else { return Ok(None) };
    let mut out = Vec::new();
    read_section(&f, entry, &mut out, &mut report)?;
    Ok(Some(out))
}

/// Check every section of a file without extracting anything.
pub fn verify(path: &Path) -> Result<RepairReport, String> {
    let mut f = File::open(path).map_err(io)?;
    let mut report = RepairReport::default();
    let entries = read_index(&mut f, &mut report)?;
    for e in entries.iter().filter(|e| e.kind <= KIND_SEGMENTS || carries(e)) {
        read_section(&f, e, &mut std::io::sink(), &mut report)?;
    }
    Ok(report)
}

/// Sections for a document and the geometry it references.
pub fn document_sections<'a>(
    info_cbor: &'a [u8],
    document_cbor: &'a [u8],
    blobs: &'a BTreeMap<String, PathBuf>,
    meshes: &'a BTreeMap<String, PathBuf>,
    carried: &'a [(Carried, PathBuf)],
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
    for (c, path) in carried.iter().filter(|(c, _)| c.kind > KIND_SEGMENTS) {
        out.push(SectionSpec { kind: c.kind, name: c.name.clone(), source: Source::File(path), layout: LARGE_LAYOUT });
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
    fn a_small_section_is_fitted_instead_of_padded_to_a_group() {
        let dir = tmpdir("fitted");
        let (path, _, geometry) = sample(&dir);
        let entries = read_index(&mut File::open(&path).unwrap(), &mut RepairReport::default()).unwrap();
        let geom = entries.iter().find(|e| e.kind == KIND_GEOMETRY).unwrap();
        assert_eq!(geom.layout.parity_shards, LARGE_LAYOUT.parity_shards);
        assert!(std::fs::metadata(&path).unwrap().len() < geometry.len() as u64 * 2);
        assert_eq!(fit_layout(LARGE_LAYOUT, 1 << 30), LARGE_LAYOUT);
        assert_eq!(fit_layout(SMALL_LAYOUT, 0), Layout { shard_size: MIN_SHARD, data_shards: 1, parity_shards: 4 });
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
        sections.push(SectionSpec { kind: 9, name: "futureIndex".into(), source: Source::Bytes(&payload), layout: SMALL_LAYOUT });
        let path = dir.join("future.fundab");
        write(&mut File::create(&path).unwrap(), &sections).unwrap();
        (path, payload)
    }

    fn index_of(path: &Path) -> Vec<Entry> {
        read_index(&mut File::open(path).unwrap(), &mut RepairReport::default()).unwrap()
    }

    fn set_codec(path: &Path, kind: u8, codec: u8) {
        let mut bytes = std::fs::read(path).unwrap();
        let table_a = parse_header(&bytes[0..HEADER_LEN as usize], MAGIC).unwrap().table_a;
        let mut entries = index_of(path);
        for e in entries.iter_mut().filter(|e| e.kind == kind) {
            e.codec = codec;
        }
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
    fn a_section_in_an_unknown_codec_is_skipped() {
        let dir = tmpdir("codec");
        let (path, _) = future_file(&dir);
        set_codec(&path, 9, 7);
        let carry = dir.join("sections");
        let opened = read_file(&path, &dir.join("blobs"), None, Some(&carry)).unwrap();
        assert!(same_json(&opened.document_json, r#"{"version":11,"features":[]}"#));
        assert!(opened.carried.is_empty());
        assert_eq!(std::fs::read_dir(&carry).unwrap().count(), 0);
        assert!(verify(&path).is_ok());
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
                if i % 7 == 0 { b' ' } else { b'0' + (x % 10) as u8 }
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
        write_with(&mut File::create(&path).unwrap(), &document_sections(&info, &cbor, &blobs, &BTreeMap::new(), &[]), o).unwrap();
        (path, hash)
    }

    fn stored_bytes(path: &Path, e: &Entry) -> Vec<u8> {
        let f = File::open(path).unwrap();
        let mut out = Vec::new();
        SectionReader::new(&f, e).unwrap().read_to_end(&mut out).unwrap();
        out
    }

    fn crc_table_crc(path: &Path, e: &Entry) -> u32 {
        let bytes = std::fs::read(path).unwrap();
        let at = e.crc_table_offset() as usize;
        crc32fast::hash(&bytes[at..at + (e.groups() * e.shards_per_group() * 4) as usize])
    }

    fn index_rows(path: &Path) -> Vec<segments::Row> {
        read_section_of_kind(path, KIND_SEGMENTS).unwrap().map(|b| segments::decode(&b)).unwrap_or_default()
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
    fn the_segmented_stream_is_one_deflate_stream_and_each_segment_stands_alone() {
        let dir = tmpdir("segstream");
        let geometry = big_blob(3 << 20);
        let (path, _) = write_blob(&dir, "seg", &geometry, &opts(4));
        let geom = index_of(&path).into_iter().find(|e| e.kind == KIND_GEOMETRY).unwrap();
        let stored = stored_bytes(&path, &geom);
        let mut whole = Vec::new();
        DeflateDecoder::new(&stored[..]).read_to_end(&mut whole).unwrap();
        assert_eq!(whole, geometry);

        let rows = index_rows(&path);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert!(segments::matches(row, geom.kind, geom.codec, &geom.raw_hash, geom.stored_len, geom.raw_len, crc_table_crc(&path, &geom)));
        assert_eq!(row.segments.len(), (3 << 20) / SEG);
        let (mut s_at, mut r_at) = (0usize, 0usize);
        for s in &row.segments {
            let part = &stored[s_at..s_at + s.stored as usize];
            assert_eq!(segments::inflate(part, s.raw as usize).as_deref(), Some(&geometry[r_at..r_at + s.raw as usize]));
            s_at += s.stored as usize;
            r_at += s.raw as usize;
        }
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
    fn segments_cost_almost_nothing_in_size() {
        let dir = tmpdir("segsize");
        let geometry = big_blob(4 << 20);
        let (seg, _) = write_blob(&dir, "seg", &geometry, &WriteOptions::default());
        let (one, _) = write_blob(&dir, "one", &geometry, &WriteOptions { segment_raw: 8 << 20, threads: 1 });
        let stored = |p: &Path| index_of(p).into_iter().find(|e| e.kind == KIND_GEOMETRY).unwrap().stored_len as f64;
        assert!(index_rows(&one).is_empty());
        assert!(stored(&seg) / stored(&one) < 1.005, "{} vs {}", stored(&seg), stored(&one));
    }

    #[test]
    fn a_section_below_two_segments_is_one_stream_without_an_index() {
        let dir = tmpdir("segsmall");
        let geometry = big_blob(2 * SEG - 1);
        let (path, _) = write_blob(&dir, "small", &geometry, &opts(4));
        assert!(index_of(&path).iter().all(|e| e.kind != KIND_SEGMENTS));
        let (path, _) = write_blob(&dir, "two", &big_blob(2 * SEG), &opts(4));
        assert_eq!(index_rows(&path)[0].segments.len(), 2);
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
        sections.push(SectionSpec { kind: KIND_SEGMENTS, name: "segments".into(), source: Source::Bytes(&old), layout: SMALL_LAYOUT });
        let again = dir.join("again.fundab");
        write_with(&mut File::create(&again).unwrap(), &sections, &opts(2)).unwrap();
        assert_eq!(index_of(&again).iter().filter(|e| e.kind == KIND_SEGMENTS).count(), 1);
        let opened = read_file(&again, &dir.join("blobs"), None, Some(&dir.join("carry"))).unwrap();
        assert!(opened.carried.is_empty());
    }
}

#[cfg(test)]
#[path = "fnda_read_tests.rs"]
mod read_tests;

#[cfg(test)]
#[path = "fnda_open_tests.rs"]
mod open_tests;
