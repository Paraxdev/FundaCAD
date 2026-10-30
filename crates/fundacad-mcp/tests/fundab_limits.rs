//! A .fundab whose table fields disagree with its bytes is refused without large allocations, overflow or deep
//! recursion. The allocator here records the largest single request made on the calling thread.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::io::Write;
use std::path::Path;

struct Peak;

thread_local! {
    static LARGEST: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = LARGEST.try_with(|c| c.set(c.get().max(layout.size())));
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _ = LARGEST.try_with(|c| c.set(c.get().max(new_size)));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: Peak = Peak;

fn largest_allocation_during<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.with(|c| c.set(0));
    let out = f();
    (out, LARGEST.with(Cell::get))
}

struct Section {
    kind: u8,
    codec: u8,
    name: String,
    stored_bytes: Vec<u8>,
    rawlen: u64,
    off: Option<u64>,
    stored: Option<u64>,
    shard: u32,
    k: u16,
    m: u16,
}

impl Section {
    fn new(kind: u8, codec: u8, stored_bytes: Vec<u8>, rawlen: u64) -> Self {
        let shard = stored_bytes.len().max(1) as u32;
        Section { kind, codec, name: String::new(), stored_bytes, rawlen, off: None, stored: None, shard, k: 1, m: 0 }
    }
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn write_raw(path: &Path, sections: &[Section]) {
    let mut body = vec![0u8; 64];
    let mut table: Vec<u8> = b"FTBL".to_vec();
    table.extend_from_slice(&(sections.len() as u32).to_le_bytes());
    for s in sections {
        let off = body.len() as u64;
        body.extend_from_slice(&s.stored_bytes);
        table.push(s.kind);
        table.push(s.codec);
        table.extend_from_slice(&(s.name.len() as u16).to_le_bytes());
        table.extend_from_slice(s.name.as_bytes());
        table.extend_from_slice(&s.off.unwrap_or(off).to_le_bytes());
        table.extend_from_slice(&s.stored.unwrap_or(s.stored_bytes.len() as u64).to_le_bytes());
        table.extend_from_slice(&s.rawlen.to_le_bytes());
        let digest = fundacad_mcp::docfile::hash(&s.stored_bytes);
        let digest: Vec<u8> = (0..16).map(|i| u8::from_str_radix(&digest[2 * i..2 * i + 2], 16).unwrap()).collect();
        table.extend_from_slice(if s.codec == 0 { &digest } else { &[0u8; 16] });
        table.extend_from_slice(&s.shard.to_le_bytes());
        table.extend_from_slice(&s.k.to_le_bytes());
        table.extend_from_slice(&s.m.to_le_bytes());
    }
    let ta = body.len();
    body.extend_from_slice(&table);
    let mut head = vec![0u8; 64];
    head[..8].copy_from_slice(b"FUNDACAD");
    head[8..10].copy_from_slice(&2u16.to_le_bytes());
    head[16..24].copy_from_slice(&(ta as u64).to_le_bytes());
    head[24..32].copy_from_slice(&(ta as u64).to_le_bytes());
    head[32..40].copy_from_slice(&(table.len() as u64).to_le_bytes());
    head[40..44].copy_from_slice(&crc32(&table).to_le_bytes());
    let crc = crc32(&head[..56]);
    head[56..60].copy_from_slice(&crc.to_le_bytes());
    body[..64].copy_from_slice(&head);
    std::fs::write(path, &body).unwrap();
}

fn deflated_zeros(len: usize) -> Vec<u8> {
    let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
    let chunk = vec![0u8; 1 << 20];
    for _ in 0..len / chunk.len() {
        e.write_all(&chunk).unwrap();
    }
    e.finish().unwrap()
}

#[test]
fn a_section_that_inflates_past_its_declared_size_is_refused_without_inflating_it_all() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("part.fundab");
    write_raw(&path, &[Section::new(1, 1, deflated_zeros(256 << 20), 64)]);
    let (out, largest) = largest_allocation_during(|| fundacad_mcp::docfile::read_document(&path));
    assert!(out.is_err());
    assert!(largest < 32 << 20, "the reader asked for {largest} bytes at once");
}

#[test]
fn geometry_sections_together_past_the_limit_are_refused_before_reading() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("part.fundab");
    let each = 3u64 << 30;
    let sections: Vec<Section> = (0..4).map(|_| Section::new(2, 0, vec![0u8; 16], each)).collect();
    write_raw(&path, &sections);
    let e = fundacad_mcp::docfile::read_document(&path).unwrap_err();
    assert!(e.0.contains("8 GiB"), "{}", e.0);
}

fn set_table_offset(path: &Path, at: u64) {
    let mut raw = std::fs::read(path).unwrap();
    raw[16..24].copy_from_slice(&at.to_le_bytes());
    raw[24..32].copy_from_slice(&at.to_le_bytes());
    let crc = crc32(&raw[..56]);
    raw[56..60].copy_from_slice(&crc.to_le_bytes());
    std::fs::write(path, &raw).unwrap();
}

#[test]
fn a_table_offset_past_the_address_space_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("part.fundab");
    write_raw(&path, &[Section::new(1, 0, vec![0xA0], 1)]);
    set_table_offset(&path, u64::MAX - 8);
    assert!(fundacad_mcp::docfile::read_document(&path).is_err());
}

#[test]
fn a_section_stored_size_larger_than_the_file_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("part.fundab");
    for stored in [u64::MAX, 1 << 40, 4096] {
        let mut s = Section::new(1, 0, vec![0xA0], 1);
        s.stored = Some(stored);
        write_raw(&path, &[s]);
        let (out, largest) = largest_allocation_during(|| fundacad_mcp::docfile::read_document(&path));
        assert!(out.is_err(), "stored {stored}");
        assert!(largest < 1 << 20, "stored {stored}: the reader asked for {largest} bytes at once");
    }
}

#[test]
fn a_section_offset_past_the_address_space_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("part.fundab");
    let mut s = Section::new(1, 0, vec![0xA0], 1);
    s.off = Some(u64::MAX);
    write_raw(&path, &[s]);
    assert!(fundacad_mcp::docfile::read_document(&path).is_err());
}

#[test]
fn a_cbor_string_longer_than_its_section_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("part.fundab");
    let doc = [0x7B, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
    write_raw(&path, &[Section::new(1, 0, doc.to_vec(), doc.len() as u64)]);
    assert!(fundacad_mcp::docfile::read_document(&path).is_err());
}

fn reads_document_holding(nested: &[u8], times: usize) -> bool {
    let mut doc = vec![0xA2, 0x68];
    doc.extend_from_slice(b"features");
    doc.extend_from_slice(&[0x80, 0x61, b'x']);
    for _ in 0..times {
        doc.extend_from_slice(nested);
    }
    doc.push(0xA0);
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("part.fundab");
    let len = doc.len() as u64;
    write_raw(&path, &[Section::new(1, 0, doc, len)]);
    std::thread::Builder::new()
        .stack_size(8 << 20)
        .spawn(move || fundacad_mcp::docfile::read_document(&path).is_ok())
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn a_document_nested_past_the_depth_limit_is_refused() {
    for nested in [&[0x81u8][..], &[0xC0], &[0xA1, 0x60]] {
        assert!(!reads_document_holding(nested, 1_000_000), "{nested:x?}");
        assert!(!reads_document_holding(nested, 200), "{nested:x?}");
    }
}

#[test]
fn a_document_nested_within_the_depth_limit_still_reads() {
    for nested in [&[0x81u8][..], &[0xC0], &[0xA1, 0x60]] {
        assert!(reads_document_holding(nested, 100), "{nested:x?}");
    }
}
