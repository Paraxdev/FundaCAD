use fundacad_geom::heartbeat::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[test]
fn beats_while_the_work_runs_and_only_under_a_hook() {
    let n = Arc::new(AtomicUsize::new(0));
    let seen = n.clone();
    let wait = || std::thread::sleep(Duration::from_millis(700));
    while_running(Duration::from_secs(5), wait);
    assert_eq!(n.load(Ordering::Relaxed), 0);
    {
        let _g = install(Some(Arc::new(move || {
            seen.fetch_add(1, Ordering::Relaxed);
        })));
        while_running(Duration::from_secs(5), wait);
    }
    assert!(n.load(Ordering::Relaxed) >= 2);
    let before = n.load(Ordering::Relaxed);
    while_running(Duration::from_secs(5), wait);
    assert_eq!(n.load(Ordering::Relaxed), before);
}

#[test]
fn stops_beating_at_its_deadline() {
    let n = Arc::new(AtomicUsize::new(0));
    let seen = n.clone();
    let _g = install(Some(Arc::new(move || {
        seen.fetch_add(1, Ordering::Relaxed);
    })));
    while_running(Duration::from_millis(300), || std::thread::sleep(Duration::from_millis(1200)));
    assert!(n.load(Ordering::Relaxed) <= 2);
}
