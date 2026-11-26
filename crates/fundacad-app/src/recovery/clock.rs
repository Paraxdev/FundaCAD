//! When the autosave writes and clears, apart from the document and the disk so each step can be tested.

use std::time::Instant;

use super::{due, warn_now};

#[cfg(test)]
mod tests;

#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Wait,
    /// Nothing is unsaved, so the snapshots go. `adopted` is a recovered slot to delete as well.
    Clear {
        adopted: Option<String>,
    },
    /// A snapshot of the document at this change count.
    Write(u64),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Wrote {
    /// `adopted` is a recovered slot this snapshot takes the place of, to delete.
    Kept {
        adopted: Option<String>,
    },
    Failed {
        warn: bool,
    },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Clock {
    /// The change count the last snapshot was taken at, None when no snapshot of this document is on disk.
    pub written: Option<u64>,
    /// The change count, and when it was first seen, so edits are timed to the poll.
    pub seen: Option<u64>,
    pub last_edit: Option<Instant>,
    pub oldest_unwritten: Option<Instant>,
    pub writing: bool,
    pub failures: u32,
    /// A crashed app's snapshot that was recovered, kept until this one writes its own or the work is saved.
    pub adopted: Option<String>,
}

impl Clock {
    pub fn next(&mut self, dirty: bool, changes: u64, now: Instant) -> Next {
        if self.writing {
            return Next::Wait;
        }
        if !dirty {
            self.seen = None;
            if self.written.is_none() && self.adopted.is_none() {
                return Next::Wait;
            }
            return Next::Clear { adopted: self.clear() };
        }
        if self.seen != Some(changes) {
            self.seen = Some(changes);
            self.last_edit = Some(now);
            self.oldest_unwritten.get_or_insert(now);
        }
        if self.written == Some(changes) {
            return Next::Wait;
        }
        let (Some(last), Some(oldest)) = (self.last_edit, self.oldest_unwritten) else { return Next::Wait };
        if !due(now, last, oldest) {
            return Next::Wait;
        }
        self.writing = true;
        Next::Write(changes)
    }

    /// Forgets every snapshot, the recovered slot it hands back is the caller's to delete.
    pub fn clear(&mut self) -> Option<String> {
        self.written = None;
        self.last_edit = None;
        self.oldest_unwritten = None;
        self.adopted.take()
    }

    pub fn wrote(&mut self, changes: u64, ok: bool) -> Wrote {
        self.writing = false;
        if ok {
            self.written = Some(changes);
            self.oldest_unwritten = None;
            self.failures = 0;
            Wrote::Kept { adopted: self.adopted.take() }
        } else {
            self.failures += 1;
            Wrote::Failed { warn: warn_now(self.failures) }
        }
    }
}
