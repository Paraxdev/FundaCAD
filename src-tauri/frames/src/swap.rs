use std::sync::{Arc, Mutex};

use crate::ring::FrameRing;

/// A ring and its slot memory, replaced one resize at a time, since posting new memory frees the old one and two
/// overlapping resizes could otherwise leave freed memory installed.
pub struct Buffers<M> {
    pub ring: FrameRing,
    mem: Mutex<M>,
    swapping: Mutex<()>,
}

impl<M: Copy> Buffers<M> {
    pub fn new(empty: M) -> Self {
        Buffers { ring: FrameRing::new(), mem: Mutex::new(empty), swapping: Mutex::new(()) }
    }

    /// Stable while the caller writes a slot it began: a swap retires the
    /// ring first, which waits for running writes.
    pub fn mem(&self) -> M {
        *self.mem.lock().unwrap()
    }

    /// `post` frees the old memory and makes the new one for the generation
    /// it is given. Returns that generation.
    pub fn swap(&self, post: impl FnOnce(u32) -> Result<M, String>) -> Result<u32, String> {
        let _one = self.swapping.lock().unwrap();
        if self.ring.is_closed() {
            return Err("the frame transport is closed".into());
        }
        let generation = self.ring.retire();
        let mem = post(generation)?;
        *self.mem.lock().unwrap() = mem;
        self.ring.install(generation);
        Ok(generation)
    }

    /// After this no swap posts again and no slot is handed out; `free`
    /// frees the memory once no write runs into it.
    pub fn close(&self, free: impl FnOnce()) {
        let _one = self.swapping.lock().unwrap();
        self.ring.close();
        self.ring.retire();
        free();
    }
}

/// The one open transport, named by an id so a late close of an earlier one
/// leaves a newer one alone.
pub struct Current<T> {
    inner: Mutex<(u64, Option<T>)>,
}

impl<T> Default for Current<T> {
    fn default() -> Self {
        Current::new()
    }
}

impl<T> Current<T> {
    pub const fn new() -> Self {
        Current { inner: Mutex::new((0, None)) }
    }

    /// Returns the new id and whatever was open before, for the caller to close.
    pub fn replace(&self, t: T) -> (u64, Option<T>) {
        let mut g = self.inner.lock().unwrap();
        g.0 += 1;
        (g.0, g.1.replace(t))
    }

    pub fn take(&self) -> Option<T> {
        self.inner.lock().unwrap().1.take()
    }

    /// Only the transport `id` names, if it is still the open one.
    pub fn take_if(&self, id: u64) -> Option<T> {
        let mut g = self.inner.lock().unwrap();
        if g.0 == id {
            g.1.take()
        } else {
            None
        }
    }

    pub fn with<R>(&self, f: impl FnOnce(Option<&T>) -> R) -> R {
        f(self.inner.lock().unwrap().1.as_ref())
    }
}

/// A resource made on first use and dropped on release, so an idle viewer
/// frees the device and its buffers. A failure to make it is kept: the
/// machine does not grow a GPU between two clicks.
pub struct Reopen<T> {
    inner: Mutex<Made<T>>,
}

enum Made<T> {
    Empty,
    Ready(Arc<T>),
    Failed(String),
}

impl<T> Default for Reopen<T> {
    fn default() -> Self {
        Reopen::new()
    }
}

impl<T> Reopen<T> {
    pub const fn new() -> Self {
        Reopen { inner: Mutex::new(Made::Empty) }
    }

    pub fn get(&self, make: impl FnOnce() -> Result<T, String>) -> Result<Arc<T>, String> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match &*g {
            Made::Ready(t) => return Ok(t.clone()),
            Made::Failed(e) => return Err(e.clone()),
            Made::Empty => {}
        }
        match make() {
            Ok(t) => {
                let t = Arc::new(t);
                *g = Made::Ready(t.clone());
                Ok(t)
            }
            Err(e) => {
                *g = Made::Failed(e.clone());
                Err(e)
            }
        }
    }

    pub fn current(&self) -> Option<Arc<T>> {
        match &*self.inner.lock().unwrap_or_else(|p| p.into_inner()) {
            Made::Ready(t) => Some(t.clone()),
            _ => None,
        }
    }

    /// The caller's handle and any transport still holding one keep it alive
    /// until they drop theirs.
    pub fn release(&self) -> Option<Arc<T>> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        match std::mem::replace(&mut *g, Made::Empty) {
            Made::Ready(t) => Some(t),
            other => {
                *g = other;
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
