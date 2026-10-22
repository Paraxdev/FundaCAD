use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub const SLOTS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Phase {
    /// The memory behind the slot is not installed yet, or was retired.
    Gone,
    Free,
    Writing,
    /// Handed to the page, which reads it until it releases it.
    Held,
}

struct State {
    generation: u32,
    phase: [Phase; SLOTS],
    closed: bool,
}

/// Which of the three page visible buffers a frame lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Slot {
    pub index: usize,
    pub generation: u32,
}

/// Three buffers the page reads while the next frames are written. A slot is written only while the page does not hold
/// it, so with two requests in flight the page never reads a half written frame.
pub struct FrameRing {
    state: Mutex<State>,
    changed: Condvar,
}

impl Default for FrameRing {
    fn default() -> Self {
        FrameRing::new()
    }
}

impl FrameRing {
    /// No slot is usable until `install`.
    pub fn new() -> Self {
        FrameRing {
            state: Mutex::new(State { generation: 0, phase: [Phase::Gone; SLOTS], closed: false }),
            changed: Condvar::new(),
        }
    }

    pub fn generation(&self) -> u32 {
        self.state.lock().unwrap().generation
    }

    /// Waits for a slot the page does not hold. None once closed, or when the
    /// page held every slot for `timeout`, which means it went away.
    pub fn begin(&self, timeout: Duration) -> Option<Slot> {
        let end = Instant::now() + timeout;
        let mut s = self.state.lock().unwrap();
        loop {
            if s.closed {
                return None;
            }
            if let Some(i) = s.phase.iter().position(|p| *p == Phase::Free) {
                s.phase[i] = Phase::Writing;
                return Some(Slot { index: i, generation: s.generation });
            }
            let left = end.checked_duration_since(Instant::now())?;
            s = self.changed.wait_timeout(s, left).unwrap().0;
        }
    }

    pub fn publish(&self, slot: Slot) {
        self.finish(slot, Phase::Held);
    }

    pub fn abandon(&self, slot: Slot) {
        self.finish(slot, Phase::Free);
    }

    fn finish(&self, slot: Slot, to: Phase) {
        let mut s = self.state.lock().unwrap();
        if s.generation == slot.generation && s.phase[slot.index] == Phase::Writing {
            s.phase[slot.index] = to;
        }
        self.changed.notify_all();
    }

    /// The page is done reading. A release from an older generation is
    /// ignored, its buffers are gone.
    pub fn release(&self, index: usize, generation: u32) {
        let mut s = self.state.lock().unwrap();
        if index < SLOTS && generation == s.generation && s.phase[index] == Phase::Held {
            s.phase[index] = Phase::Free;
            self.changed.notify_all();
        }
    }

    /// Before the buffers are replaced (a resize): waits for running writes,
    /// then no slot is usable until `install` with the returned generation.
    pub fn retire(&self) -> u32 {
        let mut s = self.state.lock().unwrap();
        while s.phase.contains(&Phase::Writing) {
            s = self.changed.wait(s).unwrap();
        }
        s.generation = s.generation.wrapping_add(1);
        s.phase = [Phase::Gone; SLOTS];
        self.changed.notify_all();
        s.generation
    }

    /// The buffers of `generation` exist now. A stale install is ignored.
    pub fn install(&self, generation: u32) {
        let mut s = self.state.lock().unwrap();
        if s.generation == generation {
            s.phase = [Phase::Free; SLOTS];
            self.changed.notify_all();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    /// Wakes every waiting writer for good.
    pub fn close(&self) {
        let mut s = self.state.lock().unwrap();
        s.closed = true;
        self.changed.notify_all();
    }
}
