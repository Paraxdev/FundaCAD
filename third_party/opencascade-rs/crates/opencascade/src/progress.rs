//! Progress and cancellation for long OpenCASCADE operations.

use cxx::UniquePtr;
use opencascade_sys as ffi;
use std::{
    marker::PhantomData,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

/// A progress indicator that stops an operation once `is_cancelled` says so.
pub struct Progress {
    inner: UniquePtr<ffi::message_progress::FcProgress>,
    // Boxed so the address the indicator holds stays put, and declared after
    // `inner` so it is dropped after the indicator.
    check: Box<ffi::message_progress::CancelCheck>,
}

// The indicator is thread safe by OCCT's contract and the check is Send + Sync.
unsafe impl Send for Progress {}
unsafe impl Sync for Progress {}

/// The range an operation reports into, borrowed from its [`Progress`].
pub struct ProgressRange<'a> {
    pub(crate) inner: UniquePtr<ffi::message::Message_ProgressRange>,
    _progress: PhantomData<&'a Progress>,
}

impl Progress {
    pub fn new(is_cancelled: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        let check = Box::new(ffi::message_progress::CancelCheck(Box::new(is_cancelled)));
        let inner = unsafe { ffi::message_progress::FcProgress_new(&*check) };
        Self { inner, check }
    }

    pub fn from_flag(flag: Arc<AtomicBool>) -> Self {
        Self::new(move || flag.load(Ordering::Relaxed))
    }

    /// Resets the position and starts a new root range.
    pub fn start(&self) -> ProgressRange<'_> {
        ProgressRange {
            inner: ffi::message_progress::FcProgress_start(&self.inner),
            _progress: PhantomData,
        }
    }

    /// 0 to 1 over the last started range.
    pub fn position(&self) -> f64 {
        ffi::message_progress::FcProgress_position(&self.inner)
    }

    pub fn break_checks(&self) -> u64 {
        ffi::message_progress::FcProgress_break_checks(&self.inner)
    }

    pub fn is_cancelled(&self) -> bool {
        (self.check.0)()
    }
}

impl ProgressRange<'static> {
    /// A range bound to no indicator: nothing reported, never cancelled.
    pub fn detached() -> Self {
        Self { inner: ffi::message::Message_ProgressRange_new(), _progress: PhantomData }
    }
}
