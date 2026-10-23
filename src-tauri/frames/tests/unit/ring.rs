use fundacad_frames::{FrameRing, Slot, SLOTS};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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
    // Every word, read twice with a yield between: a torn frame can have matching ends, and a texture upload takes
    // a while.
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
fn an_old_release_never_frees_a_held_slot_of_the_new_generation() {
    let ring = installed();
    let old = ring.begin(WAIT).unwrap();
    ring.publish(old);
    let g = ring.retire();
    ring.install(g);
    for _ in 0..SLOTS {
        let s = ring.begin(WAIT).unwrap();
        ring.publish(s);
    }
    ring.release(old.index, old.generation);
    assert!(ring.begin(Duration::from_millis(20)).is_none(), "an old release freed a slot the page reads");
    ring.release(old.index, g);
    assert_eq!(ring.begin(WAIT), Some(Slot { index: old.index, generation: g }));
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
