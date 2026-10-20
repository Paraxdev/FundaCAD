//! Reading a 3D mouse through `spacenavd` on Linux.
//!
//! The daemon owns the device, so no udev rule is needed and what the user set in
//! `spnavcfg` (swapped or inverted axes, dead zones) carries over. It sends fixed
//! 32 byte records over its socket: eight native-endian `i32`, the first the kind
//! (0 motion, 1 button press, 2 button release). Motion is then x y z rx ry rz and
//! the milliseconds since the last record, a button record carries its number.

use std::io::{self, Read};

pub const RECORD_BYTES: usize = 32;

/// Where the daemon listens, `/var/run` is a link to `/run` on current systems.
#[cfg(target_os = "linux")]
const SOCKETS: [&str; 2] = ["/var/run/spnav.sock", "/run/spnav.sock"];

/// What the daemon reports at full deflection with its default sensitivity, and
/// what the HID reports of the same device reach, so both paths feed the plugin
/// the same range.
const DAEMON_FULL_SCALE: i64 = 500;
const HID_FULL_SCALE: i64 = 350;

#[derive(Debug, PartialEq)]
pub enum Event {
    Motion { t: [f32; 3], r: [f32; 3] },
    Button { number: i32, pressed: bool },
}

/// A daemon value in the units of the HID path. It is input from another process,
/// so it is clamped symmetrically inside what an `i16` axis can carry, which also
/// keeps the sign flips in `decode` inside it.
fn unit(value: i32) -> f32 {
    let scaled = i64::from(value) * HID_FULL_SCALE / DAEMON_FULL_SCALE;
    scaled.clamp(-i64::from(i16::MAX), i64::from(i16::MAX)) as f32
}

/// The daemon swaps the device's y and z (and ry, rz) and then negates them, so its
/// y is the lift and its z the push or pull, while the HID report has x right, y
/// towards the user and z down. Back to that frame the two swap again and change sign.
pub fn decode(record: &[u8; RECORD_BYTES]) -> Option<Event> {
    let mut data = [0i32; 8];
    for (slot, bytes) in data.iter_mut().zip(record.chunks_exact(4)) {
        *slot = i32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    }
    let [kind, a, b, c, d, e, f, _period] = data;
    match kind {
        0 => Some(Event::Motion {
            t: [unit(a), -unit(c), -unit(b)],
            r: [unit(d), -unit(f), -unit(e)],
        }),
        1 | 2 => Some(Event::Button {
            number: a,
            pressed: kind == 1,
        }),
        _ => None,
    }
}

/// The button bitmask the HID path reports: bit n is button n.
pub fn apply_button(mask: u32, number: i32, pressed: bool) -> u32 {
    let Some(bit) = u32::try_from(number).ok().filter(|n| *n < 32) else {
        return mask;
    };
    if pressed {
        mask | (1 << bit)
    } else {
        mask & !(1 << bit)
    }
}

/// Hands every record to `on_event` until `keep_going` says stop (`Ok`) or the
/// daemon closes the connection or fails (`Err`). `keep_going` is asked after each
/// read, so the source needs a read timeout, and a record split across reads is
/// put back together.
pub fn pump(
    mut src: impl Read,
    keep_going: impl Fn() -> bool,
    mut on_event: impl FnMut(Event),
) -> io::Result<()> {
    let mut record = [0u8; RECORD_BYTES];
    let mut have = 0;
    while keep_going() {
        match src.read(&mut record[have..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "spacenavd closed the connection",
                ))
            }
            Ok(n) => {
                have += n;
                if have == RECORD_BYTES {
                    have = 0;
                    if let Some(event) = decode(&record) {
                        on_event(event);
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub use daemon::serve;

#[cfg(target_os = "linux")]
mod daemon {
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};

    use super::{apply_button, pump, Event, SOCKETS};
    use crate::spacemouse::{emit_motion, publish, Buttons, DeviceInventory, WANTED};

    /// Streams the daemon's events to the page. `false` when there is no daemon
    /// socket, so the caller falls back to the HID device, `true` once a
    /// connection has been served until it ended.
    pub fn serve(app: &AppHandle) -> bool {
        let Some((path, stream)) = SOCKETS
            .iter()
            .find_map(|p| UnixStream::connect(p).ok().map(|s| (*p, s)))
        else {
            return false;
        };
        if stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .is_err()
        {
            return false;
        }
        eprintln!("[spacemouse] reading through spacenavd at {path}");
        publish(
            app,
            DeviceInventory {
                picked: Some(format!("spacenavd {path}")),
                seen: Vec::new(),
                note: None,
            },
        );
        let mut mask = 0u32;
        let ended = pump(
            stream,
            || WANTED.load(Ordering::SeqCst),
            |event| match event {
                Event::Motion { t, r } => emit_motion(app, t, r),
                Event::Button { number, pressed } => {
                    mask = apply_button(mask, number, pressed);
                    let _ = app.emit("spacemouse:button", Buttons { mask });
                }
            },
        );
        if let Err(e) = ended {
            eprintln!("[spacemouse] spacenavd connection ended: {e}");
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(data: [i32; 8]) -> [u8; RECORD_BYTES] {
        let mut bytes = [0u8; RECORD_BYTES];
        for (chunk, value) in bytes.chunks_exact_mut(4).zip(data) {
            chunk.copy_from_slice(&value.to_ne_bytes());
        }
        bytes
    }

    #[test]
    fn motion_is_in_the_hid_frame_and_range() {
        assert_eq!(
            decode(&record([0, 500, 500, 500, 250, 250, 250, 8])),
            Some(Event::Motion {
                t: [350.0, -350.0, -350.0],
                r: [175.0, -175.0, -175.0]
            })
        );
        // The daemon swaps y and z before it sends: its y is a lift, its z a push
        // or pull, the HID report has them the other way round.
        assert_eq!(
            decode(&record([0, 0, 100, 200, 10, 20, 30, 8])),
            Some(Event::Motion {
                t: [0.0, -140.0, -70.0],
                r: [7.0, -21.0, -14.0]
            })
        );
        assert_eq!(
            decode(&record([0, 0, 0, 0, 0, 0, 0, 1200])),
            Some(Event::Motion {
                t: [0.0; 3],
                r: [0.0; 3]
            })
        );
    }

    #[test]
    fn extreme_values_stay_inside_an_i16_axis() {
        let extreme = record([
            0,
            i32::MIN,
            i32::MIN,
            i32::MAX,
            i32::MAX,
            i32::MIN,
            i32::MIN,
            -1,
        ]);
        assert_eq!(
            decode(&extreme),
            Some(Event::Motion {
                t: [-32767.0, -32767.0, 32767.0],
                r: [32767.0, 32767.0, 32767.0]
            })
        );
    }

    #[test]
    fn buttons_press_and_release_and_unknown_kinds_are_skipped() {
        assert_eq!(
            decode(&record([1, 1, 0, 0, 0, 0, 0, 0])),
            Some(Event::Button {
                number: 1,
                pressed: true
            })
        );
        assert_eq!(
            decode(&record([2, 1, 0, 0, 0, 0, 0, 0])),
            Some(Event::Button {
                number: 1,
                pressed: false
            })
        );
        assert_eq!(decode(&record([7, 500, 500, 500, 500, 500, 500, 0])), None);
    }

    #[test]
    fn the_mask_follows_presses_and_ignores_numbers_it_cannot_hold() {
        let mask = apply_button(apply_button(0, 0, true), 1, true);
        assert_eq!(mask, 0b11);
        assert_eq!(apply_button(mask, 0, false), 0b10);
        assert_eq!(apply_button(mask, 32, true), mask);
        assert_eq!(apply_button(mask, -1, true), mask);
    }

    struct Trickle<'a>(&'a [u8]);
    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.0.len().min(buf.len()).min(5);
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }

    #[test]
    fn records_split_across_reads_come_out_whole_and_the_end_is_an_error() {
        let mut bytes = Vec::new();
        bytes.extend(record([0, 100, 0, 0, 0, 0, 0, 8]));
        bytes.extend(record([1, 3, 0, 0, 0, 0, 0, 0]));
        bytes.extend([1, 2, 3]);
        let mut seen = Vec::new();
        let ended = pump(Trickle(&bytes), || true, |e| seen.push(e));
        assert_eq!(ended.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(
            seen,
            [
                Event::Motion {
                    t: [70.0, 0.0, 0.0],
                    r: [0.0; 3]
                },
                Event::Button {
                    number: 3,
                    pressed: true
                }
            ]
        );
    }

    #[test]
    fn a_stopped_reader_returns_cleanly() {
        assert!(pump(Trickle(&[]), || false, |_| {}).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_fake_daemon_socket_is_read_and_a_missing_one_is_not_connected() {
        use std::io::Write;
        use std::os::unix::net::{UnixListener, UnixStream};

        let path = std::env::temp_dir().join(format!("fundacad-spnav-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind");
        let daemon = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().expect("accept");
            conn.write_all(&record([0, 0, 500, 0, 0, 0, 0, 8]))
                .expect("write");
            conn.write_all(&record([2, 0, 0, 0, 0, 0, 0, 0]))
                .expect("write");
        });
        let stream = UnixStream::connect(&path).expect("connects to the fake daemon");
        let mut seen = Vec::new();
        let ended = pump(stream, || true, |e| seen.push(e));
        daemon.join().expect("daemon thread");
        let _ = std::fs::remove_file(&path);
        assert_eq!(ended.unwrap_err().kind(), io::ErrorKind::UnexpectedEof);
        assert_eq!(
            seen,
            [
                Event::Motion {
                    t: [0.0, 0.0, -350.0],
                    r: [0.0; 3]
                },
                Event::Button {
                    number: 0,
                    pressed: false
                }
            ]
        );
        assert!(UnixStream::connect(&path).is_err());
    }
}
