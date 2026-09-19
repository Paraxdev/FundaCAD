//! Proof of life from inside one long kernel call, the Rust side of
//! progress.py `progress_tick` while solid_ops.py `_run_offset_child` waits.
//!
//! The engine reaps a job whose beats stop. A single whole-body offset can run
//! longer than that budget without being wedged, so it beats from a side thread
//! while it works, for at most its own deadline, after which the beats stop and
//! the supervisor decides.

use std::cell::RefCell;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub type Beat = Arc<dyn Fn() + Send + Sync>;

thread_local! {
    static HOOK: RefCell<Option<Beat>> = const { RefCell::new(None) };
}

/// Restores the hook the thread had before `install`.
pub struct Installed(Option<Beat>);

impl Drop for Installed {
    fn drop(&mut self) {
        let prev = self.0.take();
        HOOK.with(|h| *h.borrow_mut() = prev);
    }
}

/// Make `beat` the hook for work on this thread until the guard drops.
pub fn install(beat: Option<Beat>) -> Installed {
    Installed(HOOK.with(|h| std::mem::replace(&mut *h.borrow_mut(), beat)))
}

/// The hook installed on this thread, for a kernel call that beats from the
/// threads it polls on.
pub fn current() -> Option<Beat> {
    HOOK.with(|h| h.borrow().clone())
}

/// Beat once, for a loop over many small pieces of work.
pub fn beat() {
    if let Some(b) = current() {
        b();
    }
}

/// Run `f`, beating every quarter second for up to `limit` while it runs.
pub fn while_running<T>(limit: Duration, f: impl FnOnce() -> T) -> T {
    let Some(beat) = HOOK.with(|h| h.borrow().clone()) else {
        return f();
    };
    let (done, wait) = mpsc::channel::<()>();
    std::thread::scope(|s| {
        s.spawn(move || {
            let until = Instant::now() + limit;
            while Instant::now() < until {
                match wait.recv_timeout(Duration::from_millis(250)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => beat(),
                    _ => return,
                }
            }
        });
        let out = f();
        let _ = done.send(());
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn beats_while_the_work_runs_and_only_under_a_hook() {
        let n = Arc::new(AtomicUsize::new(0));
        let seen = n.clone();
        let wait = || std::thread::sleep(Duration::from_millis(700));
        while_running(Duration::from_secs(5), wait);
        assert_eq!(n.load(Ordering::Relaxed), 0);
        {
            let _g = install(Some(Arc::new(move || {
                seen.fetch_add(1, Ordering::Relaxed);
            })));
            while_running(Duration::from_secs(5), wait);
        }
        assert!(n.load(Ordering::Relaxed) >= 2);
        let before = n.load(Ordering::Relaxed);
        while_running(Duration::from_secs(5), wait);
        assert_eq!(n.load(Ordering::Relaxed), before);
    }

    #[test]
    fn stops_beating_at_its_deadline() {
        let n = Arc::new(AtomicUsize::new(0));
        let seen = n.clone();
        let _g = install(Some(Arc::new(move || {
            seen.fetch_add(1, Ordering::Relaxed);
        })));
        while_running(Duration::from_millis(300), || std::thread::sleep(Duration::from_millis(1200)));
        assert!(n.load(Ordering::Relaxed) <= 2);
    }
}
