use super::busy::{ends, Stop, Tokens};

#[test]
fn stop_is_shared_by_clones() {
    let stop = Stop::default();
    let task = stop.clone();
    assert!(!task.is_set());
    stop.set();
    assert!(task.is_set());
}

#[test]
fn tokens_are_unique() {
    let mut t = Tokens::default();
    let (a, b) = (t.next(), t.next());
    assert_ne!(a, b);
}

#[test]
fn a_task_ends_only_its_own_busy() {
    let mut t = Tokens::default();
    let (old, new) = (t.next(), t.next());
    assert!(ends(Some(new), new));
    assert!(!ends(Some(new), old));
    assert!(!ends(None, new));
}
