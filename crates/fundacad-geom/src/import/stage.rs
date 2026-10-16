//! Which stage a running import is in, for the engine's `importing` frames.
//! A no-op unless the job installed a hook, as the engine's import op does.

use std::cell::RefCell;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

pub use fundacad_protocol::import_stage::{BUILD, READ, STORE, TRANSFER, WALK};
use opencascade::progress::Progress;

pub type Hook = Arc<dyn Fn(i64, i64, i64) + Send + Sync>;

thread_local! {
    static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
}

/// Restores the hook the thread had before `install`.
pub struct Installed(Option<Hook>);

impl Drop for Installed {
    fn drop(&mut self) {
        let prev = self.0.take();
        HOOK.with(|h| *h.borrow_mut() = prev);
    }
}

pub fn install(hook: Option<Hook>) -> Installed {
    Installed(HOOK.with(|h| std::mem::replace(&mut *h.borrow_mut(), hook)))
}

fn current() -> Option<Hook> {
    HOOK.with(|h| h.borrow().clone())
}

/// `done` of `total`, or a total of -1 when the stage has no fraction.
pub fn report(stage: i64, done: i64, total: i64) {
    if let Some(h) = current() {
        h(stage, done, total);
    }
}

const PER_MILLE: i64 = 1000;
// The XCAF readers give the transfer 19 of 20 units and the product walk the last.
const TRANSFER_END: f64 = 0.95;

/// What one sample of an XCAF read's indicator says. Before the first poll the
/// reader is still parsing the file, which runs outside any progress range.
pub fn of_xcaf_read(position: f64, checks: u64) -> (i64, i64, i64) {
    if checks == 0 && position <= 0.0 {
        return (READ, -1, -1);
    }
    if position < TRANSFER_END {
        let done = (position / TRANSFER_END * PER_MILLE as f64) as i64;
        return (TRANSFER, done.clamp(0, PER_MILLE), PER_MILLE);
    }
    (WALK, -1, -1)
}

/// Run an XCAF read, sampling `progress` from a side thread every quarter
/// second into the stage hook. The sampler only reads the indicator, which
/// OCCT allows from another thread.
pub fn sampling_xcaf_read<T>(progress: &Progress, read: impl FnOnce() -> T) -> T {
    let Some(hook) = current() else {
        return read();
    };
    let (done, wait) = mpsc::channel::<()>();
    std::thread::scope(|s| {
        s.spawn(move || {
            let mut last = (READ, -1, -1);
            loop {
                let mut now = of_xcaf_read(progress.position(), progress.break_checks());
                // A new root range starts at 0, a sample must not walk back.
                if now.0 < last.0 || (now.0 == last.0 && now.1 < last.1) {
                    now = last;
                }
                hook(now.0, now.1, now.2);
                last = now;
                match wait.recv_timeout(Duration::from_millis(250)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    _ => return,
                }
            }
        });
        let out = read();
        let _ = done.send(());
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_xcaf_sample_maps_to_parse_transfer_then_walk() {
        assert_eq!(of_xcaf_read(0.0, 0), (READ, -1, -1));
        assert_eq!(of_xcaf_read(0.0, 3), (TRANSFER, 0, 1000));
        assert_eq!(of_xcaf_read(0.475, 9), (TRANSFER, 500, 1000));
        assert_eq!(of_xcaf_read(0.95, 9), (WALK, -1, -1));
        assert_eq!(of_xcaf_read(1.0, 9), (WALK, -1, -1));
    }

    #[test]
    fn nothing_installed_reports_nowhere() {
        report(READ, -1, -1);
        let p = Progress::new(|| false);
        assert_eq!(sampling_xcaf_read(&p, || 7), 7);
    }
}
