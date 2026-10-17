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

/// The bookkeeping of three buffers the page reads while the next frames are
/// written. A slot is written only while the page does not hold it, so with
/// two requests in flight the page never reads a half written frame. The
/// memory itself belongs to the transport.
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

    /// The frame in `slot` is complete and goes to the page.
    pub fn publish(&self, slot: Slot) {
        self.finish(slot, Phase::Held);
    }

    /// Writing `slot` failed, nothing goes to the page.
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

    /// Wakes every waiting writer for good.
    pub fn close(&self) {
        let mut s = self.state.lock().unwrap();
        s.closed = true;
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;

    const WORDS: usize = 1920 * 1080 / 16;
    const FRAMES: u32 = 3000;
    const WAIT: Duration = Duration::from_secs(10);

    // Atomics stand in for the shared sections so a torn read is observable
    // without undefined behaviour.
    struct Mem(Vec<Vec<AtomicU32>>);

    impl Mem {
        fn new() -> Arc<Mem> {
            Arc::new(Mem((0..SLOTS).map(|_| (0..WORDS).map(|_| AtomicU32::new(0)).collect()).collect()))
        }
        fn write(&self, i: usize, seq: u32) {
            for w in &self.0[i] {
                w.store(seq, Ordering::Relaxed);
            }
        }
        // Every word, not only both ends: a torn frame can have matching ends.
        // Read twice with a yield between, as a texture upload takes a while,
        // so a slot written under the reader is caught reliably.
        fn intact(&self, i: usize, seq: u32) -> bool {
            let once = || self.0[i].iter().all(|w| w.load(Ordering::Relaxed) == seq);
            let first = once();
            thread::yield_now();
            first && once()
        }
    }

    // The page loop: two requests in flight, reads one frame while the next is
    // written, releases a slot only after reading it.
    fn page<F>(mem: Arc<Mem>, serve: F, release: impl Fn(usize, u32)) -> u32
    where
        F: Fn(u32) -> (usize, u32) + Send + Sync + 'static,
    {
        let serve = Arc::new(serve);
        let (tx, rx) = mpsc::channel::<thread::JoinHandle<(usize, u32, u32)>>();
        let req = |seq: u32| {
            let s = serve.clone();
            thread::spawn(move || {
                let (i, g) = s(seq);
                (i, g, seq)
            })
        };
        tx.send(req(1)).unwrap();
        tx.send(req(2)).unwrap();
        let mut bad = 0;
        let mut next = 3;
        while let Ok(h) = rx.try_recv() {
            let (i, g, seq) = h.join().unwrap();
            if next <= FRAMES {
                tx.send(req(next)).unwrap();
                next += 1;
            }
            bad += u32::from(!mem.intact(i, seq));
            release(i, g);
        }
        bad
    }

    fn installed() -> Arc<FrameRing> {
        let ring = Arc::new(FrameRing::new());
        let g = ring.retire();
        ring.install(g);
        ring
    }

    #[test]
    fn two_in_flight_never_reads_a_mismatched_frame() {
        let ring = installed();
        let mem = Mem::new();
        let (r, m) = (ring.clone(), mem.clone());
        let bad = page(
            mem,
            move |seq| {
                let slot = r.begin(WAIT).expect("a slot");
                m.write(slot.index, seq);
                r.publish(slot);
                (slot.index, slot.generation)
            },
            |i, g| ring.release(i, g),
        );
        assert_eq!(bad, 0, "torn or stale frames");
    }

    // Negative control: slot = seq % 2 writes frame seq+1 into the slot the
    // page is still reading, which the reader above has to catch.
    #[test]
    fn modulo_two_slots_does_tear() {
        let mem = Mem::new();
        let m = mem.clone();
        let bad = page(
            mem,
            move |seq| {
                let i = (seq % 2) as usize;
                m.write(i, seq);
                (i, 0)
            },
            |_, _| {},
        );
        assert!(bad > 0, "the control should catch torn frames");
        eprintln!("modulo 2 control: {bad} bad of {FRAMES}");
    }

    #[test]
    fn resize_ignores_old_releases_and_frees_every_slot() {
        let ring = installed();
        let a = ring.begin(WAIT).unwrap();
        ring.publish(a);
        let b = ring.begin(WAIT).unwrap();
        ring.publish(b);
        let c = ring.begin(WAIT).unwrap();
        ring.publish(c);
        let distinct: std::collections::BTreeSet<_> = [a.index, b.index, c.index].into_iter().collect();
        assert_eq!(distinct.len(), SLOTS);
        assert!(ring.begin(Duration::from_millis(20)).is_none(), "the page holds every slot");

        let g = ring.retire();
        assert!(ring.begin(Duration::from_millis(20)).is_none(), "nothing is usable before install");
        ring.install(g);
        ring.release(a.index, a.generation);
        let slots: Vec<Slot> = (0..SLOTS).map(|_| ring.begin(WAIT).unwrap()).collect();
        assert!(slots.iter().all(|s| s.generation == g));
        let distinct: std::collections::BTreeSet<_> = slots.iter().map(|s| s.index).collect();
        assert_eq!(distinct.len(), SLOTS);
        assert!(ring.begin(Duration::from_millis(20)).is_none(), "an old release freed nothing");
    }

    #[test]
    fn retire_waits_for_a_running_write() {
        let ring = installed();
        let slot = ring.begin(WAIT).unwrap();
        let r = ring.clone();
        let t = thread::spawn(move || r.retire());
        thread::sleep(Duration::from_millis(30));
        assert!(!t.is_finished(), "retire returned while a write ran into the old buffers");
        ring.publish(slot);
        let g = t.join().unwrap();
        assert_eq!(g, slot.generation + 1);
    }

    #[test]
    fn close_wakes_a_waiting_writer() {
        let ring = installed();
        for _ in 0..SLOTS {
            let s = ring.begin(WAIT).unwrap();
            ring.publish(s);
        }
        let r = ring.clone();
        let t = thread::spawn(move || r.begin(WAIT));
        thread::sleep(Duration::from_millis(30));
        ring.close();
        assert!(t.join().unwrap().is_none());
    }
}
