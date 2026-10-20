//! Segmented deflate (docs/FUNDA-FORMAT.md, "Segmented sections").
//!
//! A big section is cut into segments of the same raw size, each compressed by
//! a fresh compressor and ended with a sync flush, the last one with a final
//! block. The concatenation is one ordinary raw deflate stream, so every reader
//! decodes it as before, while a reader that has the segment index can inflate
//! the segments apart, on all cores.

// The read side is used by the parallel open.
#![allow(dead_code)]

use std::io::Write;

use flate2::write::DeflateEncoder;
use flate2::{Compression, Decompress, FlushDecompress, Status};

pub const DEFAULT_SEGMENT_RAW: usize = 1 << 20;
const MAGIC: &[u8; 4] = b"FSEG";
const VERSION: u16 = 1;
const MAX_SEGMENT_RAW: u64 = 64 << 20;
pub const MAX_INDEX_RAW: u64 = 16 << 20;

/// One segment of a section: its compressed and its raw length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    pub stored: u32,
    pub raw: u32,
}

/// Compress one segment. A segment that is not the last ends byte aligned on
/// an empty stored block, so the next one can follow it in the same stream.
pub fn compress(raw: &[u8], last: bool) -> std::io::Result<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::with_capacity(raw.len() / 2 + 64), Compression::default());
    enc.write_all(raw)?;
    if last {
        return enc.finish();
    }
    enc.flush()?;
    // Dropping the encoder would finish the stream into the taken-from Vec,
    // which is thrown away with it.
    Ok(std::mem::take(enc.get_mut()))
}

/// Inflate one segment alone. None unless it gives exactly `raw_len` bytes and
/// uses every one of its stored bytes.
pub fn inflate(stored: &[u8], raw_len: usize) -> Option<Vec<u8>> {
    let mut d = Decompress::new(false);
    let mut out = Vec::with_capacity(raw_len + 1);
    loop {
        let (was_in, was_out) = (d.total_in(), d.total_out());
        let at = d.total_in() as usize;
        let status = d.decompress_vec(&stored[at..], &mut out, FlushDecompress::Sync).ok()?;
        if status == Status::StreamEnd || out.len() > raw_len {
            break;
        }
        if d.total_in() == was_in && d.total_out() == was_out {
            break;
        }
    }
    (out.len() == raw_len && d.total_in() as usize == stored.len()).then_some(out)
}

/// What the index says about one section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub kind: u8,
    pub codec: u8,
    pub raw_hash: [u8; 16],
    pub stored_len: u64,
    pub crc_table_crc: u32,
    pub segments: Vec<Segment>,
}

pub fn encode(rows: &[Row]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
    for r in rows {
        out.push(r.kind);
        out.push(r.codec);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(r.segments.len() as u32).to_le_bytes());
        out.extend_from_slice(&r.raw_hash);
        out.extend_from_slice(&r.stored_len.to_le_bytes());
        out.extend_from_slice(&r.crc_table_crc.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        for s in &r.segments {
            out.extend_from_slice(&s.stored.to_le_bytes());
            out.extend_from_slice(&s.raw.to_le_bytes());
        }
    }
    out
}

/// The rows of an index, or nothing for an index of another version or a
/// damaged one. Rows are not checked against any section here, see `matches`.
pub fn decode(bytes: &[u8]) -> Vec<Row> {
    decode_inner(bytes).unwrap_or_default()
}

fn decode_inner(b: &[u8]) -> Option<Vec<Row>> {
    let mut at = 0usize;
    let mut take = |n: usize| -> Option<&[u8]> {
        let s = b.get(at..at.checked_add(n)?)?;
        at += n;
        Some(s)
    };
    if take(4)? != MAGIC || u16::from_le_bytes(take(2)?.try_into().ok()?) != VERSION {
        return None;
    }
    take(2)?;
    let count = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
    let mut rows = Vec::new();
    for _ in 0..count {
        let kind = take(1)?[0];
        let codec = take(1)?[0];
        take(2)?;
        let n = u32::from_le_bytes(take(4)?.try_into().ok()?) as usize;
        let raw_hash: [u8; 16] = take(16)?.try_into().ok()?;
        let stored_len = u64::from_le_bytes(take(8)?.try_into().ok()?);
        let crc_table_crc = u32::from_le_bytes(take(4)?.try_into().ok()?);
        take(4)?;
        let body = take(n.checked_mul(8)?)?;
        let segments = body
            .chunks_exact(8)
            .map(|c| Segment { stored: u32::from_le_bytes(c[0..4].try_into().unwrap()), raw: u32::from_le_bytes(c[4..8].try_into().unwrap()) })
            .collect();
        rows.push(Row { kind, codec, raw_hash, stored_len, crc_table_crc, segments });
    }
    Some(rows)
}

/// Whether a row describes this very section: an older writer may have carried
/// the index over a section it encoded again, so a row that does not fit is
/// ignored and the section is read as one stream.
pub fn matches(row: &Row, kind: u8, codec: u8, raw_hash: &[u8; 16], stored_len: u64, raw_len: u64, crc_table_crc: u32) -> bool {
    let n = row.segments.len() as u64;
    if row.kind != kind || row.codec != codec || codec != crate::fnda::CODEC_DEFLATE {
        return false;
    }
    if &row.raw_hash != raw_hash || row.stored_len != stored_len || row.crc_table_crc != crc_table_crc {
        return false;
    }
    if n < 2 || n > raw_len / 1024 + 1 {
        return false;
    }
    if row.segments.iter().any(|s| s.stored == 0 || s.raw == 0 || s.raw as u64 > MAX_SEGMENT_RAW) {
        return false;
    }
    let stored: u64 = row.segments.iter().map(|s| s.stored as u64).sum();
    let raw: u64 = row.segments.iter().map(|s| s.raw as u64).sum();
    stored == stored_len && raw == raw_len
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn data(n: usize) -> Vec<u8> {
        (0..n as u32).map(|i| ((i.wrapping_mul(2654435761) >> 13) as u8) & 0x3f).collect()
    }

    #[test]
    fn segments_concatenate_into_one_stream_and_inflate_alone() {
        let raw = data(300_000);
        let seg = 64 << 10;
        let pieces: Vec<&[u8]> = raw.chunks(seg).collect();
        let stored: Vec<Vec<u8>> =
            pieces.iter().enumerate().map(|(i, p)| compress(p, i == pieces.len() - 1).unwrap()).collect();
        let all = stored.concat();
        let mut whole = Vec::new();
        flate2::read::DeflateDecoder::new(&all[..]).read_to_end(&mut whole).unwrap();
        assert_eq!(whole, raw);
        for (p, s) in pieces.iter().zip(&stored) {
            assert_eq!(inflate(s, p.len()).as_deref(), Some(&p[..]));
            assert!(inflate(s, p.len() - 1).is_none());
            assert!(inflate(s, p.len() + 1).is_none());
        }
    }

    #[test]
    fn an_index_round_trips_and_rejects_other_versions() {
        let row = Row {
            kind: 2,
            codec: 1,
            raw_hash: [7; 16],
            stored_len: 30,
            crc_table_crc: 99,
            segments: vec![Segment { stored: 10, raw: 2048 }, Segment { stored: 20, raw: 100 }],
        };
        let bytes = encode(std::slice::from_ref(&row));
        assert_eq!(decode(&bytes), vec![row.clone()]);
        assert!(matches(&row, 2, 1, &[7; 16], 30, 2148, 99));
        assert!(!matches(&row, 2, 1, &[7; 16], 30, 2149, 99));
        assert!(!matches(&row, 2, 1, &[7; 16], 30, 2148, 98));
        let mut v2 = bytes.clone();
        v2[4] = 2;
        assert!(decode(&v2).is_empty());
        assert!(decode(&bytes[..bytes.len() - 1]).is_empty());
        assert!(decode(b"nope").is_empty());
    }
}
