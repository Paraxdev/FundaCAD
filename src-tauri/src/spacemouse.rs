//! Native SpaceMouse reader, since WebKitGTK has no WebHID: reports become `spacemouse:motion` and `spacemouse:button`.
//! Linux reads spacenavd first (see `spnav`); without it the udev rule must target hidraw, see
//! packaging/99-spacemouse.rules. FUNDACAD_SPACEMOUSE_DEBUG=1 logs raw reports (the old SINDRICAD_ spelling still
//! works).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use hidapi::{DeviceInfo, HidApi};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "linux")]
mod spnav;

// 3Dconnexion vendor ids: 0x256f (current 3Dconnexion), 0x046d (older Logitech-branded)
const VENDORS: [u16; 2] = [0x256f, 0x046d];

// Generic Desktop / Multi-axis Controller is the spec's 6DOF signal, so it finds any 3D mouse, unlike an id allowlist.
// Measured: SpaceNavigator 046d:c626 enumerates as usage 1/8, mice as 1/2, keyboards as 1/6.
const USAGE_PAGE_GENERIC_DESKTOP: u16 = 0x01;
const USAGE_MULTI_AXIS: u16 = 0x08;
const USAGE_MOUSE: u16 = 0x02;
const USAGE_KEYBOARD: u16 = 0x06;

/// Higher is better, `None` never opens it. 0x046d is Logitech's, shared with their mice, so a vendor match whose known
/// usage is not multi axis is refused, and one without usage info must prove itself in `stream()` from the report
/// descriptor. Ranking rather than an id list keeps unlisted models working.
fn rank(vendor_id: u16, usage_page: u16, usage: u16) -> Option<i32> {
    let multi_axis = usage_page == USAGE_PAGE_GENERIC_DESKTOP && usage == USAGE_MULTI_AXIS;
    let vendor = VENDORS.contains(&vendor_id);
    // A usage that positively says "mouse"/"keyboard" is a definitive NO even
    // under a matching vendor id, that is exactly the Logitech collision.
    let decoy = usage_page == USAGE_PAGE_GENERIC_DESKTOP && matches!(usage, USAGE_MOUSE | USAGE_KEYBOARD);
    if decoy {
        return None;
    }
    // usage_page 0: the platform did not populate usage, so keep the vendor fallback and let stream() confirm it.
    let usage_known = usage_page != 0;
    match (multi_axis, vendor, usage_known) {
        (true, true, _) => Some(3),      // a 3D mouse from a vendor we know
        (true, false, _) => Some(2),     // a 3D mouse from a vendor we don't
        (false, true, false) => Some(1), // vendor match, usage unknown, UNPROVEN
        _ => None,
    }
}

/// Scores at or below this were matched on vendor id alone and have NOT proven
/// they are 6DOF controllers. `stream()` makes them prove it before streaming.
const UNPROVEN: i32 = 1;

fn rank_device(d: &DeviceInfo) -> Option<i32> {
    rank(d.vendor_id(), d.usage_page(), d.usage())
}

/// The device describing itself, the only evidence that settles the vendor collision when enumeration has no usage.
/// Walks HID short items (a prefix byte with tag, type and size, then 0, 1, 2 or 4 bytes) for a Multi-axis Usage.
fn declares_multi_axis(desc: &[u8]) -> bool {
    const ITEM_USAGE_PAGE: u8 = 0x04; // 0b0000_01_00
    const ITEM_USAGE: u8 = 0x08; // 0b0000_10_00
    const LONG_ITEM: u8 = 0xfe;

    let mut page: u16 = 0;
    let mut i = 0usize;
    while i < desc.len() {
        let prefix = desc[i];
        if prefix == LONG_ITEM {
            // [0xfe, dataSize, tag, data...], nothing we need, step over it.
            let size = match desc.get(i + 1) {
                Some(&n) => n as usize,
                None => return false,
            };
            i += 3 + size;
            continue;
        }
        let size = match prefix & 0x03 {
            3 => 4, // a size field of 3 means FOUR bytes, not three
            n => n as usize,
        };
        if i + 1 + size > desc.len() {
            return false; // truncated descriptor, do not guess
        }
        let mut value: u32 = 0;
        for (k, &b) in desc[i + 1..i + 1 + size].iter().enumerate() {
            value |= (b as u32) << (8 * k); // HID data is little-endian
        }
        match prefix & 0xfc {
            ITEM_USAGE_PAGE => page = value as u16,
            ITEM_USAGE => {
                // A 4-byte usage is "extended": it carries its own page in the
                // high half and ignores the current one.
                let (p, u) = if size == 4 { ((value >> 16) as u16, value as u16) } else { (page, value as u16) };
                if p == USAGE_PAGE_GENERIC_DESKTOP && u == USAGE_MULTI_AXIS {
                    return true;
                }
            }
            _ => {}
        }
        i += 1 + size;
    }
    false
}

/// One line per HID interface for the bug report, vid:pid, usage, product.
fn describe(d: &DeviceInfo) -> String {
    format!(
        "{:04x}:{:04x} usage {}/{} {:?}",
        d.vendor_id(),
        d.product_id(),
        d.usage_page(),
        d.usage(),
        d.product_string().unwrap_or("?")
    )
}

#[derive(Clone, Serialize)]
struct Motion {
    tx: f32,
    ty: f32,
    tz: f32,
    rx: f32,
    ry: f32,
    rz: f32,
}

#[derive(Clone, Serialize)]
struct Buttons {
    mask: u32,
}

/// Whether the reader should be running. Written by the commands below,
/// read by the thread between reports.
static WANTED: AtomicBool = AtomicBool::new(false);
/// Separate from WANTED: a thread takes a moment to notice it was stopped, and conflating the two leads to two readers
/// on one device.
static ALIVE: Mutex<bool> = Mutex::new(false);

fn alive() -> std::sync::MutexGuard<'static, bool> {
    ALIVE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Called by the frontend only when the capability is on: one that is off must not hold the HID device open, which on
/// Linux can lock out other programs. Idempotent while a reader is alive.
#[tauri::command]
pub fn spacemouse_start(app: AppHandle) {
    WANTED.store(true, Ordering::SeqCst);
    let mut is_alive = alive();
    if *is_alive {
        return;
    }
    *is_alive = true;
    drop(is_alive);
    start(app);
}

/// Takes effect within about a second: the read below times out each second and checks the flag.
#[tauri::command]
pub fn spacemouse_stop() {
    WANTED.store(false, Ordering::SeqCst);
}

/// A background thread that streams from the first 3Dconnexion device, reconnects every 3 s while it is missing, and
/// returns when the capability is turned off.
fn start(app: AppHandle) {
    thread::spawn(move || {
        // Warn about a plugged in but unreadable device once per run, as the loop retries every 3 s forever.
        let mut warned = false;
        // The HID inventory is published whenever it CHANGES, see stream().
        let mut last_inventory: Option<String> = None;
        while WANTED.load(Ordering::SeqCst) {
            // A connected spacenavd is never a reason to warn, it may be holding
            // an idle device that is simply not readable directly.
            match through_daemon(&app, &mut last_inventory) {
                Ok(()) => warned = false,
                Err(hint) => match stream(&app, &mut last_inventory) {
                    Ok(()) => warned = false,    // clean disconnect: a later failure is news again
                    Err(Blocked::NoDevice) => {} // nothing plugged in, normal, stay quiet
                    Err(Blocked::Unreadable { name, detail }) => {
                        eprintln!("[spacemouse] found \"{name}\" but could not open it: {detail}");
                        if !warned {
                            warned = true;
                            let hint = hint.map(str::to_string);
                            let _ = app.emit("spacemouse:blocked", DeviceBlocked { name, detail, hint });
                        }
                    }
                    Err(Blocked::Other(e)) => eprintln!("[spacemouse] {e}"),
                },
            }
            // The retry wait, in slices, so turning the capability off is felt
            // in a fraction of a second rather than after three of them.
            for _ in 0..30 {
                if !WANTED.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
        // Taken before the flag is cleared and checked again under it, or a start arriving while this thread winds down
        // would see ALIVE true, not spawn, and leave nothing reading.
        let mut is_alive = alive();
        if WANTED.load(Ordering::SeqCst) {
            drop(is_alive);
            start(app);
            return;
        }
        *is_alive = false;
        eprintln!("[spacemouse] reader stopped");
    });
}

/// Reads through spacenavd while it is connected. `Err` when there is no daemon,
/// with what to tell a user whose device cannot be read directly either.
#[cfg(target_os = "linux")]
fn through_daemon(app: &AppHandle, last: &mut Option<String>) -> Result<(), Option<&'static str>> {
    spnav::through_daemon(app, last).map_err(|no_daemon| Some(no_daemon.hint()))
}

#[cfg(not(target_os = "linux"))]
fn through_daemon(_app: &AppHandle, _last: &mut Option<String>) -> Result<(), Option<&'static str>> {
    Err(None)
}

/// Why the reader isn't running. Only `Unreadable` is worth telling the user
/// about: the device IS there and the fix is theirs to apply.
enum Blocked {
    NoDevice,
    Unreadable { name: String, detail: String },
    Other(String),
}

#[derive(Clone, Serialize)]
struct DeviceBlocked {
    name: String,
    detail: String,
    /// What the user can do about it, when this platform knows better than the
    /// page's own text.
    hint: Option<String>,
}

/// Every HID interface seen and the one chosen, a silent bug report breadcrumb. `NoDevice` is quiet, so this is how a
/// device that enumerates under an id we do not match becomes visible.
#[derive(Clone, Serialize)]
pub struct DeviceInventory {
    picked: Option<String>,
    seen: Vec<String>,
    /// Why the best candidate was NOT used, when that happened.
    note: Option<String>,
}

/// Kept for the frontend to ask for: the first pass emits long before the page listens, and Tauri does not replay
/// events to late listeners.
#[derive(Default)]
pub struct Inventory(std::sync::Mutex<Option<DeviceInventory>>);

/// The frontend's pull of the above, called once the page is actually listening.
#[tauri::command]
pub fn spacemouse_inventory(state: tauri::State<'_, Inventory>) -> Option<DeviceInventory> {
    state.0.lock().ok().and_then(|held| held.clone())
}

/// Publish the inventory both ways: stored for whoever asks later, emitted for
/// whoever is already listening.
fn publish(app: &AppHandle, inventory: DeviceInventory) {
    if let Some(state) = app.try_state::<Inventory>() {
        if let Ok(mut held) = state.0.lock() {
            *held = Some(inventory.clone());
        }
    }
    let _ = app.emit("spacemouse:devices", inventory);
}

/// Did the device confirm, in its own report descriptor, that it is 6DOF?
enum Proof {
    Yes,
    No,
    /// The platform would not give us the descriptor, so this proves nothing.
    Unavailable(String),
}

fn proves_multi_axis(dev: &hidapi::HidDevice) -> Proof {
    let mut buf = [0u8; 4096]; // HID caps a report descriptor well below this
    match dev.get_report_descriptor(&mut buf) {
        Ok(n) if declares_multi_axis(&buf[..n]) => Proof::Yes,
        Ok(_) => Proof::No,
        Err(e) => Proof::Unavailable(e.to_string()),
    }
}

/// A device that opened and is a 3D mouse, ready to read.
struct Opened {
    dev: hidapi::HidDevice,
    vid: u16,
    pid: u16,
    name: String,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    described: String,
}

fn stream(app: &AppHandle, last: &mut Option<String>) -> Result<(), Blocked> {
    let api = HidApi::new().map_err(|e| Blocked::Other(e.to_string()))?;
    let (inventory, opened) = open_best(&api);
    publish_on_change(app, last, inventory);
    read_device(app, opened?, None)
}

/// Picks and opens the best device, with the inventory of what was seen.
fn open_best(api: &HidApi) -> (DeviceInventory, Result<Opened, Blocked>) {
    // Take the best and never fall through to a lower ranked one: on Linux a failed open means a missing udev rule, and
    // opening another Logitech device instead is the bug this avoids.
    let mut ranked: Vec<(i32, &DeviceInfo)> =
        api.device_list().filter_map(|d| rank_device(d).map(|s| (s, d))).collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));

    // Open and VERIFY before publishing the inventory, so it records what
    // actually happened rather than what we were about to try.
    let mut note: Option<String> = None;
    let mut chosen: Option<(&DeviceInfo, hidapi::HidDevice)> = None;
    let mut blocked: Option<Blocked> = None;

    if let Some(&(score, info)) = ranked.first() {
        let name = info.product_string().unwrap_or("SpaceMouse").to_string();
        // Enumeration needs only the USB node, opening needs the root only hidraw node, so listed but unopenable means
        // a missing udev rule or spacenavd holding the device.
        match api.open_path(info.path()) {
            Err(e) => blocked = Some(Blocked::Unreadable { name, detail: e.to_string() }),
            Ok(dev) => {
                if score > UNPROVEN {
                    chosen = Some((info, dev)); // it declared Multi-axis during enumeration
                } else {
                    match proves_multi_axis(&dev) {
                        Proof::Yes => chosen = Some((info, dev)),
                        Proof::No => {
                            note = Some(format!(
                                "ignoring {}, matched only on vendor id, and its report \
                                 descriptor declares no multi-axis usage, so it is an \
                                 ordinary HID device rather than a 3D mouse",
                                describe(info)
                            ));
                        }
                        Proof::Unavailable(why) => {
                            // Cannot tell: keep working as before rather than regress a device, but say so, since this
                            // path can still misfire.
                            note = Some(format!(
                                "streaming {} on its vendor id alone, the report \
                                 descriptor was unavailable ({why})",
                                describe(info)
                            ));
                            chosen = Some((info, dev));
                        }
                    }
                }
            }
        }
    }

    let inventory = DeviceInventory {
        picked: chosen.as_ref().map(|(info, _)| describe(info)),
        seen: api.device_list().map(describe).collect(),
        note,
    };
    let opened = match (blocked, chosen) {
        (Some(b), _) => Err(b),
        (None, None) => Err(Blocked::NoDevice),
        (None, Some((info, dev))) => Ok(Opened {
            dev,
            vid: info.vendor_id(),
            pid: info.product_id(),
            name: info.product_string().unwrap_or("SpaceMouse").to_string(),
            described: describe(info),
        }),
    };
    (inventory, opened)
}

fn publish_on_change(app: &AppHandle, last: &mut Option<String>, inventory: DeviceInventory) {
    // Publish on change: a device plugged in later is news, while the no device case retries every 3 s and must not
    // spam.
    let fingerprint = format!("{:?}|{:?}|{}", inventory.picked, inventory.note, inventory.seen.len());
    if last.as_deref() != Some(fingerprint.as_str()) {
        *last = Some(fingerprint);
        if let Some(n) = &inventory.note {
            eprintln!("[spacemouse] {n}");
        }
        publish(app, inventory);
    }
}

/// Streams the device's reports to the page, `first` before any it reads.
fn read_device(app: &AppHandle, opened: Opened, first: Option<Vec<u8>>) -> Result<(), Blocked> {
    let debug =
        std::env::var("FUNDACAD_SPACEMOUSE_DEBUG").is_ok() || std::env::var("SINDRICAD_SPACEMOUSE_DEBUG").is_ok();
    let Opened { dev, vid, pid, name, .. } = opened;
    eprintln!("[spacemouse] connected {vid:04x}:{pid:04x} \"{name}\"");

    // Older devices split translation and rotation across report ids 1 and 2, so the latest of each makes a full
    // vector.
    let mut t = [0f32; 3];
    let mut r = [0f32; 3];
    let mut buf = [0u8; 64];
    let mut first = first;
    loop {
        if !WANTED.load(Ordering::SeqCst) {
            return Ok(()); // turned off: close the device and let the thread end
        }
        let n = match first.take() {
            Some(report) => {
                let n = report.len().min(buf.len());
                buf[..n].copy_from_slice(&report[..n]);
                n
            }
            // A read failure after a successful open is an unplug or a transport
            // hiccup, not a permissions problem, reconnect quietly.
            None => dev.read_timeout(&mut buf, 1000).map_err(|e| Blocked::Other(e.to_string()))?,
        };
        if n == 0 {
            continue; // timeout, device idle, loop and read again
        }
        if debug {
            eprintln!("[spacemouse] report {:?}", &buf[..n]);
        }
        // signed 16-bit little-endian axis at byte offset i
        let axis = |i: usize| -> f32 {
            if i + 1 < n {
                i16::from_le_bytes([buf[i], buf[i + 1]]) as f32
            } else {
                0.0
            }
        };
        match buf[0] {
            1 => {
                t = [axis(1), axis(3), axis(5)];
                if n >= 13 {
                    r = [axis(7), axis(9), axis(11)]; // device packs rotation in the same report
                }
                emit_motion(app, t, r);
            }
            2 => {
                r = [axis(1), axis(3), axis(5)];
                emit_motion(app, t, r);
            }
            3 => {
                let mut mask = 0u32;
                for k in 1..n.min(5) {
                    mask |= (buf[k] as u32) << (8 * (k - 1));
                }
                let _ = app.emit("spacemouse:button", Buttons { mask });
            }
            _ => {}
        }
    }
}

fn emit_motion(app: &AppHandle, t: [f32; 3], r: [f32; 3]) {
    let _ = app.emit("spacemouse:motion", Motion { tx: t[0], ty: t[1], tz: t[2], rx: r[0], ry: r[1], rz: r[2] });
}

#[cfg(test)]
mod tests {
    use super::*;

    // Real ids, read off this developer's machine with a hidapi enumeration probe.
    const SPACENAV: u16 = 0x046d; // 046d:c626 "SpaceNavigator", enumerates usage 1/8
    const LOGI: u16 = 0x046d; // ...the SAME vendor id as every Logitech mouse
    const CONNEXION: u16 = 0x256f;
    const UNKNOWN: u16 = 0x3367;

    #[test]
    fn multi_axis_is_preferred_over_everything() {
        let spacenav = rank(SPACENAV, 0x01, 0x08).unwrap();
        assert!(spacenav > rank(LOGI, 0x00, 0x00).unwrap());
        assert!(spacenav > UNPROVEN, "a declared 6DOF device needs no further proof");
    }

    // Vendor 0x046d is Logitech's, so a plain vendor match could feed a mouse's reports through as 6DOF.
    #[test]
    fn logitech_mouse_and_keyboard_are_never_opened() {
        assert_eq!(rank(LOGI, 0x01, 0x02), None, "a Logitech mouse");
        assert_eq!(rank(LOGI, 0x01, 0x06), None, "a Logitech keyboard");
    }

    // A collection that says it is not 6DOF has nothing to fall back for, so it must not be opened.
    #[test]
    fn a_known_non_multi_axis_usage_is_rejected_even_from_our_vendors() {
        assert_eq!(rank(LOGI, 0xff00, 0x01), None, "Logitech HID++ collection");
        assert_eq!(rank(CONNEXION, 0xff00, 0x01), None, "3Dconnexion vendor collection");
        assert_eq!(rank(LOGI, 0x0c, 0x01), None, "consumer control collection");
    }

    // Ranking, not filtering: a model whose product id we never listed must still
    // work, or we'd regress testers with a SpaceMouse Pro/Enterprise/Wireless.
    #[test]
    fn an_unknown_vendors_3d_mouse_is_still_accepted() {
        assert!(rank(UNKNOWN, 0x01, 0x08).is_some());
    }

    // Without usage info the vendor fallback stays, but only as UNPROVEN, for stream() to check against the descriptor.
    #[test]
    fn vendor_match_survives_when_usage_is_unpopulated() {
        assert_eq!(rank(CONNEXION, 0x00, 0x00), Some(UNPROVEN));
        assert_eq!(rank(UNKNOWN, 0x00, 0x00), None);
    }

    #[test]
    fn unrelated_hardware_is_ignored() {
        assert_eq!(rank(0x1b1c, 0x0c, 0x01), None, "Corsair consumer control");
        assert_eq!(rank(0x3434, 0x01, 0x06), None, "Keychron keyboard");
    }

    // When enumeration gives no usage, the device's own report descriptor decides.

    // Generic Desktop / Multi-axis Controller, the opening of every 3D mouse's
    // descriptor.
    const SPACEMOUSE_DESC: &[u8] = &[
        0x05, 0x01, // Usage Page (Generic Desktop)
        0x09, 0x08, // Usage (Multi-axis Controller)
        0xa1, 0x01, // Collection (Application)
        0xa1, 0x00, //   Collection (Physical)
        0x85, 0x01, //     Report ID (1)
        0x09, 0x30, //     Usage (X)
        0x09, 0x31, //     Usage (Y)
        0xc0, 0xc0,
    ];

    // A bog-standard boot mouse, what an MX Anywhere 3s presents.
    const MOUSE_DESC: &[u8] = &[
        0x05, 0x01, // Usage Page (Generic Desktop)
        0x09, 0x02, // Usage (Mouse)
        0xa1, 0x01, // Collection (Application)
        0x09, 0x01, //   Usage (Pointer)
        0xa1, 0x00, //   Collection (Physical)
        0x05, 0x09, //     Usage Page (Button)
        0x19, 0x01, //     Usage Minimum (1)
        0x29, 0x03, //     Usage Maximum (3)
        0x05, 0x01, //     Usage Page (Generic Desktop)
        0x09, 0x30, //     Usage (X)
        0x09, 0x31, //     Usage (Y)
        0x09, 0x38, //     Usage (Wheel)
        0xc0, 0xc0,
    ];

    #[test]
    fn a_3d_mouse_descriptor_is_recognised() {
        assert!(declares_multi_axis(SPACEMOUSE_DESC));
    }

    #[test]
    fn a_mouse_descriptor_is_not() {
        assert!(!declares_multi_axis(MOUSE_DESC));
    }

    // Usage 0x08 is Multi-axis only under Generic Desktop; under the Button page it is button 8.
    #[test]
    fn usage_8_on_another_page_is_not_multi_axis() {
        assert!(!declares_multi_axis(&[0x05, 0x09, 0x09, 0x08]));
    }

    // A 4-byte usage carries its own page in the high half and ignores the
    // current one.
    #[test]
    fn an_extended_usage_carries_its_own_page() {
        assert!(declares_multi_axis(&[0x0b, 0x08, 0x00, 0x01, 0x00]));
        assert!(!declares_multi_axis(&[0x0b, 0x08, 0x00, 0x09, 0x00]));
    }

    // Never guess from a descriptor we could not read to the end.
    #[test]
    fn a_truncated_descriptor_proves_nothing() {
        assert!(!declares_multi_axis(&[0x05]));
        assert!(!declares_multi_axis(&[0x05, 0x01, 0x09]));
        assert!(!declares_multi_axis(&[]));
        assert!(!declares_multi_axis(&[0xfe])); // long item with no length byte
    }

    // The size field encodes 4 bytes as 3; reading it literally would desync the
    // walk and miss everything after the first long value.
    #[test]
    fn a_four_byte_item_does_not_desync_the_walk() {
        let desc = &[
            0x27, 0xff, 0xff, 0x00, 0x00, // Logical Maximum, 4 bytes
            0x05, 0x01, 0x09, 0x08, // ...then the usage that matters
        ];
        assert!(declares_multi_axis(desc));
    }
}
