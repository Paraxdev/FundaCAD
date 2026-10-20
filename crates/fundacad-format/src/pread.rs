//! Positioned reads, so several readers can share a file without a cursor.

use std::fs::File;
use std::io;

#[cfg(unix)]
fn read_once(f: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(f, buf, offset)
}

#[cfg(windows)]
fn read_once(f: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(f, buf, offset)
}

// Windows reports a read that starts past the end as ERROR_HANDLE_EOF.
#[cfg(windows)]
fn past_end(e: &io::Error) -> bool {
    e.raw_os_error() == Some(38)
}

#[cfg(unix)]
fn past_end(_: &io::Error) -> bool {
    false
}

/// Fill `buf` from `offset`, stopping early only at the end of the file.
/// Returns how many bytes were read.
pub fn read_at(f: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match read_once(f, &mut buf[got..], offset + got as u64) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if past_end(&e) => break,
            Err(e) => return Err(e),
        }
    }
    Ok(got)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_at_an_offset_and_stops_at_the_end() {
        let dir = std::env::temp_dir().join(format!("fundacad_pread_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.bin");
        std::fs::write(&path, (0..100u8).collect::<Vec<_>>()).unwrap();
        let f = File::open(&path).unwrap();
        let mut buf = [0u8; 10];
        assert_eq!(read_at(&f, &mut buf, 20).unwrap(), 10);
        assert_eq!(buf[0], 20);
        assert_eq!(read_at(&f, &mut buf, 95).unwrap(), 5);
        assert_eq!(&buf[..5], &[95, 96, 97, 98, 99]);
        assert_eq!(read_at(&f, &mut buf, 100).unwrap(), 0);
        assert_eq!(read_at(&f, &mut buf, 1000).unwrap(), 0);
        drop(f);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
