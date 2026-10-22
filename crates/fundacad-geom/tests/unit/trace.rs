use fundacad_geom::trace::*;

#[test]
fn words_later_arguments_only_when_read() {
    use std::cell::Cell;
    use std::rc::Rc;
    let worded = Rc::new(Cell::new(0));
    let w = worded.clone();
    begin();
    failed_later(
        "Dropped",
        move || {
            w.set(w.get() + 1);
            "a".into()
        },
        "NotDone",
        None,
    );
    begin();
    assert_eq!(worded.get(), 0);
    let w = worded.clone();
    failed_later(
        "Read",
        move || {
            w.set(w.get() + 1);
            "b".into()
        },
        "NotDone",
        None,
    );
    let calls = take();
    assert_eq!(worded.get(), 1);
    assert_eq!(calls[0].args.as_deref(), Some("b"));
}
