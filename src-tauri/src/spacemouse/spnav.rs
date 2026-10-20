//! The 3D mouse through `spacenavd`, the app's side of `fundacad_spnav`.

use std::io;
use std::sync::atomic::Ordering;

use fundacad_spnav::{apply_button, connect, serve, Device, Event, NoDaemon, Served, SOCKETS};
use hidapi::HidApi;
use tauri::{AppHandle, Emitter};

use super::{
    describe, emit_motion, open_best, publish, read_device, Blocked, Buttons, DeviceInventory,
    Opened, WANTED,
};

struct Hid(Opened);

impl Device for Hid {
    fn read_timeout(&mut self, buf: &mut [u8], ms: i32) -> io::Result<usize> {
        let n = self.0.dev.read_timeout(buf, ms).map_err(io::Error::other)?;
        // Only motion (1, 2) and button (3) reports count as the device sending,
        // so a status report at rest does not take the mouse from the daemon.
        Ok(if n > 0 && matches!(buf[0], 1..=3) {
            n
        } else {
            0
        })
    }
}

/// Streams spacenavd's events to the page until it closes or the capability is
/// turned off, or the device itself sent first and was read directly. `Err` when
/// there is no daemon to connect to.
pub fn through_daemon(app: &AppHandle, last: &mut Option<String>) -> Result<(), NoDaemon> {
    let (path, stream) = connect(&SOCKETS)?;
    let path = path.display().to_string();
    eprintln!("[spacemouse] reading through spacenavd at {path}");
    // Whatever the HID path publishes next is news again.
    *last = None;
    let mut first_try = true;
    let open_device = || {
        let api = HidApi::new().ok();
        let opened = api.as_ref().map(open_best);
        if std::mem::take(&mut first_try) {
            let note = match opened.as_ref().map(|(_, o)| o) {
                Some(Ok(o)) => Some(format!(
                    "{} is readable directly too, the first of the two to send is used",
                    o.described
                )),
                Some(Err(Blocked::Unreadable { name, detail })) => Some(format!(
                    "\"{name}\" is not readable directly ({detail}), only spacenavd can send"
                )),
                _ => None,
            };
            publish(
                app,
                DeviceInventory {
                    picked: Some(format!("spacenavd {path}")),
                    seen: api
                        .iter()
                        .flat_map(|a| a.device_list().map(describe))
                        .collect(),
                    note,
                },
            );
        }
        opened.and_then(|(_, o)| o.ok()).map(Hid)
    };
    let mut mask = 0u32;
    let served = serve(
        stream,
        open_device,
        || WANTED.load(Ordering::SeqCst),
        |event| match event {
            Event::Motion { t, r } => emit_motion(app, t, r),
            Event::Button { number, pressed } => {
                mask = apply_button(mask, number, pressed);
                let _ = app.emit("spacemouse:button", Buttons { mask });
            }
        },
    );
    match served {
        Served::Ended(Ok(())) => {}
        Served::Ended(Err(e)) => eprintln!("[spacemouse] spacenavd connection ended: {e}"),
        Served::Device(Hid(opened), first) => {
            eprintln!("[spacemouse] the device sent before spacenavd, reading it directly");
            publish(
                app,
                DeviceInventory {
                    picked: Some(opened.described.clone()),
                    seen: Vec::new(),
                    note: Some(format!(
                        "spacenavd at {path} sent nothing before the device did, so it may not support it"
                    )),
                },
            );
            if let Err(Blocked::Other(e)) = read_device(app, opened, Some(first)) {
                eprintln!("[spacemouse] {e}");
            }
        }
    }
    Ok(())
}
