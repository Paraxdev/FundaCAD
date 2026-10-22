use fundacad_geom::cancel::*;
use fundacad_protocol::CancelToken;

#[test]
fn a_cancel_reaches_work_on_the_thread_it_was_installed_on() {
    let token = CancelToken::new();
    let guard = install(Some(token.clone()));
    let p = progress();
    assert!(!requested() && !p.is_cancelled());
    token.cancel();
    assert!(requested() && p.is_cancelled());
    drop(guard);
    assert!(!requested());
}

#[test]
fn nothing_installed_never_stops() {
    assert!(!requested());
    assert!(!progress().is_cancelled());
}
