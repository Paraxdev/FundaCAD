//! The FSD_BinaryFile header of an OCCT XBF document, read only far enough to see
//! whether its user info lists other documents (a START_REF block).

use std::io::Read;

const HEADER_CAP: u64 = 1 << 20;
const MAX_ENTRIES: i32 = 1 << 16;
const MAX_STRING: i32 = 1 << 16;
const REF_START: &[u8] = b"START_REF";

struct Header<R: Read> {
    file: R,
    big_endian: bool,
}

impl<R: Read> Header<R> {
    fn int(&mut self) -> Option<i32> {
        let mut b = [0u8; 4];
        self.file.read_exact(&mut b).ok()?;
        Some(if self.big_endian { i32::from_be_bytes(b) } else { i32::from_le_bytes(b) })
    }

    fn bytes(&mut self, unit: usize) -> Option<Vec<u8>> {
        let n = self.int()?;
        if !(0..=MAX_STRING).contains(&n) {
            return None;
        }
        let mut v = vec![0u8; n as usize * unit];
        self.file.read_exact(&mut v).ok()?;
        Some(v)
    }
}

/// Whether the document names other documents to load, `None` when the header cannot be read in either byte order.
pub fn lists_references(file: impl Read) -> Option<bool> {
    let mut head = Vec::new();
    file.take(HEADER_CAP).read_to_end(&mut head).ok()?;
    read(Header { file: &head[..], big_endian: false }).or_else(|| read(Header { file: &head[..], big_endian: true }))
}

fn read(mut h: Header<&[u8]>) -> Option<bool> {
    let mut magic = [0u8; 7];
    h.file.read_exact(&mut magic).ok()?;
    if &magic != b"BINFILE" {
        return None;
    }
    for _ in 0..13 {
        h.int()?;
    }
    h.int()?;
    for unit in [1, 1, 1, 1, 2, 1, 2] {
        h.bytes(unit)?;
    }
    let entries = h.int()?;
    if !(0..=MAX_ENTRIES).contains(&entries) {
        return None;
    }
    for _ in 0..entries {
        if h.bytes(1)? == REF_START {
            return Some(true);
        }
    }
    Some(false)
}
