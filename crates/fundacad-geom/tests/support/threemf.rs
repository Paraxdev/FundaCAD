//! Hand written one part 3MF zips, so the sizes they declare can differ from their data.
#![allow(dead_code)]

/// A one part 3MF zip written by hand, so the sizes it declares can differ from the data.
pub fn threemf_zip(deflated: &[u8], crc: u32, declared: u32) -> Vec<u8> {
    let name = b"3D/3dmodel.model";
    let head = |sig: u32, central: bool| {
        let mut h = sig.to_le_bytes().to_vec();
        if central {
            h.extend(20u16.to_le_bytes());
        }
        for v in [20u16, 0, 8, 0, 0x21] {
            h.extend(v.to_le_bytes());
        }
        for v in [crc, deflated.len() as u32, declared] {
            h.extend(v.to_le_bytes());
        }
        h.extend((name.len() as u16).to_le_bytes());
        h.extend(0u16.to_le_bytes());
        if central {
            h.extend([0u8; 10]);
            h.extend(0u32.to_le_bytes());
        }
        h.extend(name);
        h
    };
    let mut z = head(0x0403_4b50, false);
    z.extend(deflated);
    let cd_at = z.len() as u32;
    let cd = head(0x0201_4b50, true);
    z.extend(&cd);
    z.extend(0x0605_4b50u32.to_le_bytes());
    for v in [0u16, 0, 1, 1] {
        z.extend(v.to_le_bytes());
    }
    z.extend((cd.len() as u32).to_le_bytes());
    z.extend(cd_at.to_le_bytes());
    z.extend(0u16.to_le_bytes());
    z
}

pub fn deflate(data: &[u8], flush: flate2::FlushCompress) -> Vec<u8> {
    let mut c = flate2::Compress::new(flate2::Compression::fast(), false);
    let mut out = Vec::with_capacity(data.len() / 8 + 1024);
    c.compress_vec(data, &mut out, flush).unwrap();
    out
}

/// A part of `times` copies of `block`, deflated once and repeated, declaring its true size.
pub fn repeated_part(block: &[u8], times: usize) -> Vec<u8> {
    let one = deflate(block, flate2::FlushCompress::Sync);
    let mut data: Vec<u8> = std::iter::repeat_n(&one[..], times).flatten().copied().collect();
    data.extend([0x03, 0x00]);
    let (mut crc, mut each) = (flate2::Crc::new(), flate2::Crc::new());
    each.update(block);
    for _ in 0..times {
        crc.combine(&each);
    }
    threemf_zip(&data, crc.sum(), (block.len() * times) as u32)
}
