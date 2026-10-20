//! Small data parallelism for the file layer, on scoped threads. Results are
//! collected by index, so what a caller builds from them never depends on the
//! thread count.

use std::sync::atomic::{AtomicUsize, Ordering};

/// `FUNDACAD_THREADS` when set, else the cores of this machine, at most 16.
pub fn threads() -> usize {
    std::env::var("FUNDACAD_THREADS")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
        .clamp(1, 16)
}

/// `f(0) .. f(n - 1)` on up to `threads` threads, in index order.
pub fn map_indexed<T: Send>(n: usize, threads: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let workers = threads.clamp(1, n.max(1));
    if workers == 1 {
        return (0..n).map(f).collect();
    }
    let next = AtomicUsize::new(0);
    let mut parts: Vec<Vec<(usize, T)>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                s.spawn(|| {
                    let mut mine = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= n {
                            break mine;
                        }
                        mine.push((i, f(i)));
                    }
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().expect("a file worker panicked")).collect()
    });
    let mut out: Vec<Option<T>> = (0..n).map(|_| None).collect();
    for (i, v) in parts.iter_mut().flat_map(std::mem::take) {
        out[i] = Some(v);
    }
    out.into_iter().map(|v| v.expect("every index ran")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn results_come_back_in_index_order_for_any_thread_count() {
        for t in [1, 2, 8, 64] {
            assert_eq!(map_indexed(100, t, |i| i * i), (0..100).map(|i| i * i).collect::<Vec<_>>());
        }
        assert!(map_indexed(0, 4, |i| i).is_empty());
    }

    #[test]
    fn the_thread_count_stays_in_bounds() {
        let n = threads();
        assert!((1..=16).contains(&n));
    }
}
