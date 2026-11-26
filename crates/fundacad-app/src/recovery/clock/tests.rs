use std::time::{Duration, Instant};

use super::{Clock, Next, Wrote};

fn secs(base: Instant, s: u64) -> Instant {
    base + Duration::from_secs(s)
}

#[test]
fn a_clean_document_with_nothing_on_disk_waits_and_changes_nothing() {
    let mut c = Clock::default();
    assert_eq!(c.next(false, 4, Instant::now()), Next::Wait);
    assert_eq!(c, Clock::default());
}

#[test]
fn a_clean_document_clears_its_own_snapshot_and_hands_back_the_adopted_one() {
    let t0 = Instant::now();
    let mut own = Clock { written: Some(7), seen: Some(7), last_edit: Some(t0), ..Clock::default() };
    assert_eq!(own.next(false, 7, secs(t0, 5)), Next::Clear { adopted: None });
    assert_eq!(own, Clock::default());

    let mut adopted = Clock { adopted: Some("41-9".into()), ..Clock::default() };
    assert_eq!(adopted.next(false, 2, secs(t0, 5)), Next::Clear { adopted: Some("41-9".into()) });
    assert_eq!(adopted, Clock::default());
}

#[test]
fn an_edit_waits_until_it_has_rested_thirty_seconds() {
    let t0 = Instant::now();
    let mut c = Clock::default();
    assert_eq!(c.next(true, 3, t0), Next::Wait);
    assert_eq!(c, Clock { seen: Some(3), last_edit: Some(t0), oldest_unwritten: Some(t0), ..Clock::default() });
    assert_eq!(c.next(true, 3, secs(t0, 29)), Next::Wait);
    assert_eq!(c.next(true, 3, secs(t0, 30)), Next::Write(3));
    assert_eq!(
        c,
        Clock { seen: Some(3), last_edit: Some(t0), oldest_unwritten: Some(t0), writing: true, ..Clock::default() }
    );
}

#[test]
fn nothing_more_starts_while_a_write_runs_even_once_clean() {
    let t0 = Instant::now();
    let mut c = Clock { written: Some(1), writing: true, adopted: Some("5-5".into()), ..Clock::default() };
    let before = c.clone();
    assert_eq!(c.next(true, 9, secs(t0, 500)), Next::Wait);
    assert_eq!(c.next(false, 9, secs(t0, 500)), Next::Wait);
    assert_eq!(c, before);
}

#[test]
fn busy_editing_writes_two_minutes_after_the_oldest_unwritten_edit() {
    let t0 = Instant::now();
    let mut c = Clock::default();
    for (i, s) in (0..120).step_by(10).enumerate() {
        assert_eq!(c.next(true, 10 + i as u64, secs(t0, s)), Next::Wait, "at {s} s");
    }
    assert_eq!(c.next(true, 22, secs(t0, 120)), Next::Write(22));
    assert_eq!(c.last_edit, Some(secs(t0, 120)));
    assert_eq!(c.oldest_unwritten, Some(t0));
}

#[test]
fn a_written_change_count_is_not_written_again() {
    let t0 = Instant::now();
    let mut c = Clock::default();
    c.next(true, 6, t0);
    assert_eq!(c.next(true, 6, secs(t0, 31)), Next::Write(6));
    assert_eq!(c.wrote(6, true), Wrote::Kept { adopted: None });
    assert_eq!(
        c,
        Clock { written: Some(6), seen: Some(6), last_edit: Some(t0), oldest_unwritten: None, ..Clock::default() }
    );
    assert_eq!(c.next(true, 6, secs(t0, 900)), Next::Wait);
    assert_eq!(c.next(true, 8, secs(t0, 901)), Next::Wait);
    assert_eq!(c.next(true, 8, secs(t0, 931)), Next::Write(8));
}

#[test]
fn the_adopted_slot_goes_only_once_a_write_of_its_own_works() {
    let mut c = Clock { writing: true, adopted: Some("12-3".into()), ..Clock::default() };
    assert_eq!(c.wrote(4, false), Wrote::Failed { warn: false });
    assert_eq!(c, Clock { failures: 1, adopted: Some("12-3".into()), ..Clock::default() });
    c.writing = true;
    assert_eq!(c.wrote(5, true), Wrote::Kept { adopted: Some("12-3".into()) });
    assert_eq!(c, Clock { written: Some(5), ..Clock::default() });
}

#[test]
fn failures_are_counted_and_warned_of_once_until_a_write_works() {
    let mut c = Clock { written: Some(2), ..Clock::default() };
    let warned: Vec<bool> = (0..5)
        .map(|_| match c.wrote(3, false) {
            Wrote::Failed { warn } => warn,
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(warned, [false, false, true, false, false]);
    assert_eq!(c, Clock { written: Some(2), failures: 5, ..Clock::default() });
    assert_eq!(c.wrote(3, true), Wrote::Kept { adopted: None });
    assert_eq!(c.failures, 0);
}
