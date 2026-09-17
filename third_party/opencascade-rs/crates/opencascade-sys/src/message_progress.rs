//! A `Message_ProgressIndicator` whose `UserBreak` asks a Rust closure, so a
//! long OCCT operation can be cancelled from another thread.

pub use inner::*;

/// Called from OCCT worker threads during parallel algorithms.
pub struct CancelCheck(pub Box<dyn Fn() -> bool + Send + Sync>);

impl CancelCheck {
    fn is_cancelled(&self) -> bool {
        (self.0)()
    }
}

#[cxx::bridge]
mod inner {
    extern "Rust" {
        type CancelCheck;
        fn is_cancelled(self: &CancelCheck) -> bool;
    }

    unsafe extern "C++" {
        include!("opencascade-sys/include/message_progress.hxx");

        type Message_ProgressRange = crate::message::Message_ProgressRange;

        type FcProgress;

        /// `check` must outlive the indicator and every range it hands out.
        pub unsafe fn FcProgress_new(check: *const CancelCheck) -> UniquePtr<FcProgress>;
        /// Resets the position to 0 and returns the root range.
        pub fn FcProgress_start(progress: &FcProgress) -> UniquePtr<Message_ProgressRange>;
        pub fn FcProgress_position(progress: &FcProgress) -> f64;
        /// How many times OCCT asked whether to stop.
        pub fn FcProgress_break_checks(progress: &FcProgress) -> u64;
    }
}
