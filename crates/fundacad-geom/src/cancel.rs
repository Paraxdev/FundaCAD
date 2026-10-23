//! Cancel checks inside one feature. The builder only checks between features, so a long fillet could run for
//! seconds after the user moved on. A feature asks here between kernel calls and, through [`progress`], inside them.

use fundacad_protocol::CancelToken;
use opencascade::progress::Progress;
use std::cell::RefCell;

thread_local! {
    static TOKEN: RefCell<Option<CancelToken>> = const { RefCell::new(None) };
}

/// Restores the token the thread had before `install`.
pub struct Installed(Option<CancelToken>);

impl Drop for Installed {
    fn drop(&mut self) {
        let prev = self.0.take();
        TOKEN.with(|t| *t.borrow_mut() = prev);
    }
}

/// Make `token` the cancel for work on this thread until the guard drops.
pub fn install(token: Option<CancelToken>) -> Installed {
    Installed(TOKEN.with(|t| std::mem::replace(&mut *t.borrow_mut(), token)))
}

/// The token installed on this thread, for work this thread hands to others.
pub fn token() -> Option<CancelToken> {
    TOKEN.with(|t| t.borrow().clone())
}

pub fn requested() -> bool {
    TOKEN.with(|t| t.borrow().as_ref().is_some_and(CancelToken::is_cancelled))
}

/// An indicator OCCT polls, from any thread, that says stop once the job is
/// cancelled. Never stops without an installed token.
pub fn progress() -> Progress {
    let token = TOKEN.with(|t| t.borrow().clone());
    Progress::new(move || token.as_ref().is_some_and(CancelToken::is_cancelled))
}

/// [`progress`] that also beats the job's heartbeat each time OCCT polls it,
/// for a long kernel call with nothing else to show it is alive.
pub fn progress_beating() -> Progress {
    let token = TOKEN.with(|t| t.borrow().clone());
    let beat = crate::heartbeat::current();
    Progress::new(move || {
        if let Some(b) = &beat {
            b();
        }
        token.as_ref().is_some_and(CancelToken::is_cancelled)
    })
}
