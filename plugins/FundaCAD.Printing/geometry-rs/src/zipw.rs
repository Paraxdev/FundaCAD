//! A deflated zip written through `output::write` as it is made, so a large
//! assembly's mesh XML is never held whole, as zipfile streams it in Python.

use miniz_oxide::deflate::core::{compress, create_comp_flags_from_zip_params, CompressorOxide, TDEFLFlush, TDEFLStatus};

use crate::fundacad::plugin::output;

const LEVEL: i32 = 6;
const BUF: usize = 1 << 16;

struct Central {
    name: String,
    crc: u32,
    csize: u64,
    usize_: u64,
    offset: u64,
}

struct Open {
    name: String,
    offset: u64,
    crc: crc32fast::Hasher,
    csize: u64,
    usize_: u64,
    deflate: Box<CompressorOxide>,
}

pub struct ZipOut {
    at: u64,
    done: Vec<Central>,
    open: Option<Open>,
    out: Vec<u8>,
}

fn u16le(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}

fn u32le(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

impl ZipOut {
    pub fn new() -> ZipOut {
        ZipOut {
            at: 0,
            done: Vec::new(),
            open: None,
            out: Vec::new(),
        }
    }

    fn emit(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.at += bytes.len() as u64;
        self.out.extend_from_slice(bytes);
        if self.out.len() >= BUF {
            self.flush()?;
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), String> {
        if !self.out.is_empty() {
            output::write(&self.out)?;
            self.out.clear();
        }
        Ok(())
    }

    /// Start a streamed entry: sizes and CRC follow in a data descriptor.
    pub fn begin(&mut self, name: &str) -> Result<(), String> {
        let mut h = Vec::new();
        u32le(&mut h, 0x0403_4b50);
        u16le(&mut h, 20);
        u16le(&mut h, 0x0808);
        u16le(&mut h, 8);
        u16le(&mut h, 0);
        u16le(&mut h, 0x21);
        u32le(&mut h, 0);
        u32le(&mut h, 0);
        u32le(&mut h, 0);
        u16le(&mut h, name.len() as u16);
        u16le(&mut h, 0);
        h.extend_from_slice(name.as_bytes());
        let offset = self.at;
        self.emit(&h)?;
        let mut deflate = Box::new(CompressorOxide::new(create_comp_flags_from_zip_params(LEVEL, -15, 0)));
        deflate.reset();
        self.open = Some(Open {
            name: name.to_string(),
            offset,
            crc: crc32fast::Hasher::new(),
            csize: 0,
            usize_: 0,
            deflate,
        });
        Ok(())
    }

    fn pump(&mut self, mut input: &[u8], flush: TDEFLFlush) -> Result<(), String> {
        let mut buf = vec![0u8; BUF];
        loop {
            let open = self.open.as_mut().ok_or("no zip entry is open")?;
            let (status, used, made) = compress(&mut open.deflate, input, &mut buf, flush);
            open.csize += made as u64;
            input = &input[used..];
            let chunk = buf[..made].to_vec();
            self.emit(&chunk)?;
            match status {
                TDEFLStatus::Done => return Ok(()),
                TDEFLStatus::Okay => {
                    if input.is_empty() && made < buf.len() && !matches!(flush, TDEFLFlush::Finish) {
                        return Ok(());
                    }
                }
                _ => return Err("the zip writer could not deflate".into()),
            }
        }
    }

    pub fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        let open = self.open.as_mut().ok_or("no zip entry is open")?;
        open.crc.update(bytes);
        open.usize_ += bytes.len() as u64;
        self.pump(bytes, TDEFLFlush::None)
    }

    pub fn end(&mut self) -> Result<(), String> {
        self.pump(&[], TDEFLFlush::Finish)?;
        let open = self.open.take().ok_or("no zip entry is open")?;
        let crc = open.crc.finalize();
        let mut d = Vec::new();
        u32le(&mut d, 0x0807_4b50);
        u32le(&mut d, crc);
        u32le(&mut d, open.csize as u32);
        u32le(&mut d, open.usize_ as u32);
        self.emit(&d)?;
        self.done.push(Central {
            name: open.name,
            crc,
            csize: open.csize,
            usize_: open.usize_,
            offset: open.offset,
        });
        Ok(())
    }

    pub fn entry(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.begin(name)?;
        self.write(bytes)?;
        self.end()
    }

    pub fn finish(mut self) -> Result<(), String> {
        if self.at > u32::MAX as u64 {
            return Err("the project is too large for a zip without ZIP64".into());
        }
        let start = self.at;
        let mut cd = Vec::new();
        for c in &self.done {
            u32le(&mut cd, 0x0201_4b50);
            u16le(&mut cd, 20);
            u16le(&mut cd, 20);
            u16le(&mut cd, 0x0808);
            u16le(&mut cd, 8);
            u16le(&mut cd, 0);
            u16le(&mut cd, 0x21);
            u32le(&mut cd, c.crc);
            u32le(&mut cd, c.csize as u32);
            u32le(&mut cd, c.usize_ as u32);
            u16le(&mut cd, c.name.len() as u16);
            u16le(&mut cd, 0);
            u16le(&mut cd, 0);
            u16le(&mut cd, 0);
            u16le(&mut cd, 0);
            u32le(&mut cd, 0o600 << 16);
            u32le(&mut cd, c.offset as u32);
            cd.extend_from_slice(c.name.as_bytes());
        }
        let size = cd.len() as u32;
        u32le(&mut cd, 0x0605_4b50);
        u16le(&mut cd, 0);
        u16le(&mut cd, 0);
        u16le(&mut cd, self.done.len() as u16);
        u16le(&mut cd, self.done.len() as u16);
        u32le(&mut cd, size);
        u32le(&mut cd, start as u32);
        u16le(&mut cd, 0);
        self.emit(&cd)?;
        self.flush()
    }
}
