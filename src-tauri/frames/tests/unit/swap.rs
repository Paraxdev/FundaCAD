use fundacad_frames::{Buffers, Current, Reopen};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[test]
fn overlapping_resizes_leave_the_newest_memory_installed() {
    let b = Arc::new(Buffers::new(0u32));
    let live = Arc::new(AtomicU32::new(0));
    let first = {
        let (b, live) = (b.clone(), live.clone());
        thread::spawn(move || {
            b.swap(|g| {
                live.store(g, Ordering::SeqCst);
                // The UI thread answered, the caller is slow to store it.
                thread::sleep(Duration::from_millis(150));
                Ok(g)
            })
        })
    };
    thread::sleep(Duration::from_millis(30));
    let second = b.swap(|g| {
        live.store(g, Ordering::SeqCst);
        Ok(g)
    });
    let first = first.join().unwrap().unwrap();
    let second = second.unwrap();
    assert_ne!(first, second);
    let newest = live.load(Ordering::SeqCst);
    assert_eq!(b.mem(), newest, "the installed memory was freed by a later post");
    let slot = b.ring.begin(Duration::from_millis(100)).expect("the newest generation is usable");
    assert_eq!(slot.generation, newest);
}

#[test]
fn a_swap_after_close_posts_nothing() {
    let b = Buffers::new(0u32);
    b.swap(|g| Ok(g)).unwrap();
    let freed = AtomicU32::new(0);
    b.close(|| {
        freed.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(freed.load(Ordering::SeqCst), 1);
    assert!(b.swap(|_| panic!("posted after close")).is_err());
    assert!(b.ring.begin(Duration::from_millis(20)).is_none());
}

#[test]
fn a_late_close_leaves_the_newer_transport_open() {
    let c = Current::new();
    let (a, none) = c.replace("a");
    assert!(none.is_none());
    let (b, old) = c.replace("b");
    assert_eq!(old, Some("a"));
    assert_eq!(c.take_if(a), None);
    assert_eq!(c.with(|t| t.copied()), Some("b"));
    assert_eq!(c.take_if(b), Some("b"));
    assert_eq!(c.take(), None);
}

#[test]
fn a_released_resource_is_made_again_on_next_use() {
    let made = AtomicU32::new(0);
    let r: Reopen<u32> = Reopen::new();
    let make = || Ok(made.fetch_add(1, Ordering::SeqCst));
    let first = r.get(make).unwrap();
    assert_eq!(*r.get(|| panic!("made twice")).unwrap(), *first);
    let weak = Arc::downgrade(&first);
    drop(first);
    assert!(r.release().is_some());
    assert!(weak.upgrade().is_none(), "release kept the resource alive");
    assert!(r.current().is_none());
    assert_eq!(*r.get(make).unwrap(), 1);
    assert_eq!(made.load(Ordering::SeqCst), 2);
}

#[test]
fn a_failure_to_make_is_kept_across_release() {
    let r: Reopen<u32> = Reopen::new();
    assert_eq!(r.get(|| Err("no adapter".into())).unwrap_err(), "no adapter");
    assert!(r.release().is_none());
    assert_eq!(r.get(|| panic!("tried again")).unwrap_err(), "no adapter");
}
