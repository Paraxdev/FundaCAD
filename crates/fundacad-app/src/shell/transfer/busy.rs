//! What ties a busy dialog to the task behind it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Set by Cancel. The task checks it between steps, since the engine only cancels a request in flight.
#[derive(Clone, Default)]
pub struct Stop(Arc<AtomicBool>);

impl Stop {
    pub fn set(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_set(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Hands out a fresh token per busy dialog, so a task ends only its own.
#[derive(Default)]
pub struct Tokens(u64);

impl Tokens {
    pub fn next(&mut self) -> u64 {
        self.0 += 1;
        self.0
    }
}

pub fn ends(open: Option<u64>, token: u64) -> bool {
    open == Some(token)
}
