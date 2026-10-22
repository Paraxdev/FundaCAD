//! Reads a 3D mouse through `spacenavd` on Linux, so no udev rule is needed and `spnavcfg` settings carry over. A
//! daemon can run without supporting the device, so until either sends the device is read too and the first is kept.

use std::io::{self, Read};
use std::time::{Duration, Instant};

pub const RECORD_BYTES: usize = 32;

/// Where the daemon listens, `/var/run` is a link to `/run` on current systems.
pub const SOCKETS: [&str; 2] = ["/var/run/spnav.sock", "/run/spnav.sock"];

/// The daemon's full deflection at default sensitivity, which the HID reports of the same device also reach.
const DAEMON_FULL_SCALE: i64 = 500;
const HID_FULL_SCALE: i64 = 350;

/// Each read while both are undecided, short so the two take turns.
pub const TURN: Duration = Duration::from_millis(50);
/// A read once one path is kept, short enough that a stop is felt within it.
pub const IDLE_READ: Duration = Duration::from_secs(1);
/// How often a device that would not open is tried again while undecided.
pub const REOPEN: Duration = Duration::from_secs(3);
/// How long the daemon is still waited for once the device has sent. Both see
/// the same touch, the daemon a moment later, as it reads the device itself.
pub const LAST_CHANCE: Duration = Duration::from_millis(30);

#[derive(Debug, PartialEq)]
pub enum Event {
    Motion { t: [f32; 3], r: [f32; 3] },
    Button { number: i32, pressed: bool },
}

/// Daemon values come from another process, so they are clamped symmetrically inside an `i16` axis, which also keeps
/// the sign flips in `decode` inside it.
fn unit(value: i32) -> f32 {
    let scaled = i64::from(value) * HID_FULL_SCALE / DAEMON_FULL_SCALE;
    scaled.clamp(-i64::from(i16::MAX), i64::from(i16::MAX)) as f32
}

/// A record is eight native endian i32: kind (0 motion, 1 press, 2 release), then x y z rx ry rz and ms, or the button.
/// The daemon swaps y and z (and ry, rz) and negates them, so its y is the lift and z the push or pull; the HID frame
/// has x right, y towards the user, z down.
pub fn decode(record: &[u8; RECORD_BYTES]) -> Option<Event> {
    let mut data = [0i32; 8];
    for (slot, bytes) in data.iter_mut().zip(record.as_chunks::<4>().0) {
        *slot = i32::from_ne_bytes(*bytes);
    }
    let [kind, a, b, c, d, e, f, _period] = data;
    match kind {
        0 => Some(Event::Motion { t: [unit(a), -unit(c), -unit(b)], r: [unit(d), -unit(f), -unit(e)] }),
        1 | 2 => Some(Event::Button { number: a, pressed: kind == 1 }),
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

/// Puts records back together across reads, so a record split over two reads,
/// or over a turn of the device, comes out whole.
#[derive(Default)]
pub struct Reader {
    record: [u8; RECORD_BYTES],
    have: usize,
}

impl Reader {
    /// One read: `Ok(None)` for a timeout or part of a record, `Err` when the
    /// daemon closed the connection or failed.
    pub fn step(&mut self, src: &mut impl Read) -> io::Result<Option<Event>> {
        match src.read(&mut self.record[self.have..]) {
            Ok(0) => Err(io::Error::new(io::ErrorKind::UnexpectedEof, "spacenavd closed the connection")),
            Ok(n) => {
                self.have += n;
                if self.have < RECORD_BYTES {
                    return Ok(None);
                }
                self.have = 0;
                Ok(decode(&self.record))
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }
}

/// Hands every record to `on_event` until `keep_going`, asked after each read, says stop (`Ok`) or the daemon closes or
/// fails (`Err`). The source needs a read timeout.
pub fn pump(mut src: impl Read, keep_going: impl Fn() -> bool, on_event: impl FnMut(Event)) -> io::Result<()> {
    pump_with(&mut Reader::default(), &mut src, keep_going, on_event)
}

fn pump_with(
    reader: &mut Reader,
    src: &mut impl Read,
    keep_going: impl Fn() -> bool,
    mut on_event: impl FnMut(Event),
) -> io::Result<()> {
    while keep_going() {
        if let Some(event) = reader.step(src)? {
            on_event(event);
        }
    }
    Ok(())
}

/// The read timeout of the daemon socket, which `serve` changes between turns.
pub trait Wait {
    fn wait_at_most(&self, time: Duration) -> io::Result<()>;
}

#[cfg(unix)]
impl Wait for std::os::unix::net::UnixStream {
    fn wait_at_most(&self, time: Duration) -> io::Result<()> {
        self.set_read_timeout(Some(time))
    }
}

/// The 3D mouse read directly, the reports a device sends and nothing else.
pub trait Device {
    /// `Ok(0)` when nothing came within `ms` milliseconds.
    fn read_timeout(&mut self, buf: &mut [u8], ms: i32) -> io::Result<usize>;
}

#[derive(Debug)]
pub enum Served<D> {
    /// Stopped (`Ok`), or the daemon closed or failed (`Err`), so the caller waits
    /// and connects again.
    Ended(io::Result<()>),
    /// The device sent first. The daemon connection is closed, and the device is
    /// handed back with that first report for the caller to read on.
    Device(D, Vec<u8>),
}

/// Streams daemon events however long it stays silent, as an idle puck sends nothing. Until either sends, the device
/// from `open_device` is read in turns with the socket, daemon first so `spnavcfg` applies; the first to send is kept,
/// so no motion arrives twice.
pub fn serve<S: Read + Wait, D: Device>(
    mut daemon: S,
    mut open_device: impl FnMut() -> Option<D>,
    keep_going: impl Fn() -> bool,
    mut on_event: impl FnMut(Event),
) -> Served<D> {
    let mut reader = Reader::default();
    let mut device = open_device();
    let mut tried = Instant::now();
    let mut waiting = None;
    let mut report = [0u8; 64];
    loop {
        if !keep_going() {
            return Served::Ended(Ok(()));
        }
        if device.is_none() && tried.elapsed() >= REOPEN {
            device = open_device();
            tried = Instant::now();
        }
        let wait = if device.is_some() { TURN } else { IDLE_READ };
        if waiting != Some(wait) {
            if let Err(e) = daemon.wait_at_most(wait) {
                return Served::Ended(Err(e));
            }
            waiting = Some(wait);
        }
        match reader.step(&mut daemon) {
            Err(e) => return Served::Ended(Err(e)),
            Ok(Some(event)) => {
                on_event(event);
                break;
            }
            Ok(None) => {}
        }
        let Some(dev) = device.as_mut() else {
            continue;
        };
        match dev.read_timeout(&mut report, TURN.as_millis() as i32) {
            Ok(0) => {}
            Ok(n) => {
                if daemon.wait_at_most(LAST_CHANCE).is_ok() {
                    if let Ok(Some(event)) = reader.step(&mut daemon) {
                        on_event(event);
                        break;
                    }
                }
                let first = report[..n].to_vec();
                return Served::Device(device.take().expect("read above"), first);
            }
            // Unplugged or gone: try it again later, the daemon may still have it.
            Err(_) => {
                device = None;
                tried = Instant::now();
            }
        }
    }
    drop(device);
    if let Err(e) = daemon.wait_at_most(IDLE_READ) {
        return Served::Ended(Err(e));
    }
    Served::Ended(pump_with(&mut reader, &mut daemon, keep_going, on_event))
}

/// Why no daemon connection was made, which decides what a user whose device is
/// plugged in but not readable is told.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum NoDaemon {
    /// No socket: spacenavd is not running.
    Absent,
    /// A socket is there but does not answer: spacenavd died or is stuck.
    Refused,
}

impl NoDaemon {
    pub fn hint(self) -> &'static str {
        match self {
            NoDaemon::Absent => "start spacenavd (sudo systemctl enable --now spacenavd) or install the udev rule",
            NoDaemon::Refused => {
                "spacenavd is not answering, restart it (sudo systemctl restart spacenavd) or install the udev rule"
            }
        }
    }
}

/// The first daemon socket of `paths` that answers, with its path.
#[cfg(unix)]
pub fn connect<P: AsRef<std::path::Path>>(
    paths: &[P],
) -> Result<(std::path::PathBuf, std::os::unix::net::UnixStream), NoDaemon> {
    let mut why = NoDaemon::Absent;
    for path in paths {
        let path = path.as_ref();
        match std::os::unix::net::UnixStream::connect(path) {
            Ok(stream) => return Ok((path.to_path_buf(), stream)),
            Err(_) if path.exists() => why = NoDaemon::Refused,
            Err(_) => {}
        }
    }
    Err(why)
}
