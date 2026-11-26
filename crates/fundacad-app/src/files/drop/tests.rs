use std::path::PathBuf;

use super::{leftovers, plan, Plan};

fn paths(names: &[&str]) -> Vec<PathBuf> {
    names.iter().map(PathBuf::from).collect()
}

#[test]
fn nothing_dropped_opens_nothing_and_says_nothing() {
    let p = plan(&[]);
    assert_eq!(p, Plan::default());
    assert_eq!(leftovers(&p), None);
}

#[test]
fn one_document_opens() {
    for name in ["D:/w/Lid v2.funda", "D:/w/arm.FUNDAB", "C:/scan/part.stl"] {
        let p = plan(&paths(&[name]));
        assert_eq!(p, Plan { open: Some(PathBuf::from(name)), skipped: vec![], rejected: vec![] }, "{name}");
        assert_eq!(leftovers(&p), None);
    }
}

#[test]
fn the_first_document_opens_and_the_rest_are_named() {
    let p = plan(&paths(&["E:/a/notes.txt", "E:/a/one.funda", "E:/a/two.stl", "E:/a/README", "E:/a/three.fundab"]));
    assert_eq!(
        p,
        Plan {
            open: Some(PathBuf::from("E:/a/one.funda")),
            skipped: paths(&["E:/a/two.stl", "E:/a/three.fundab"]),
            rejected: paths(&["E:/a/notes.txt", "E:/a/README"]),
        }
    );
    assert_eq!(
        leftovers(&p).as_deref(),
        Some("FundaCAD cannot open notes.txt, README. Only one document opens at a time, so two.stl, three.fundab stayed closed.")
    );
}

#[test]
fn only_unreadable_files_open_nothing() {
    let p = plan(&paths(&["F:/m/bracket.step", "F:/m/funda"]));
    assert_eq!(p.open, None);
    assert_eq!(leftovers(&p).as_deref(), Some("FundaCAD cannot open bracket.step, funda."));
}

mod window {
    use std::cell::RefCell;
    use std::path::PathBuf;
    use std::rc::Rc;

    use gpui::{
        div, point, px, Context, ExternalPaths, FileDropEvent, InteractiveElement as _, IntoElement,
        ParentElement as _, Render, Styled as _, TestAppContext, Window,
    };

    use super::super::layer;

    type Got = Rc<RefCell<Vec<Vec<PathBuf>>>>;

    struct Bench(Got);

    impl Render for Bench {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let t = crate::theme::state(cx).theme().clone();
            let got = self.0.clone();
            div()
                .size_full()
                .child(div().id("panel").absolute().left(px(40.)).top(px(30.)).w(px(220.)).h(px(310.)).occlude())
                .child(layer(&t, move |p, _, _| got.borrow_mut().push(p.paths().to_vec())))
        }
    }

    fn drop_at(x: f32, y: f32, names: &[&str]) -> Vec<Vec<PathBuf>> {
        let mut app = TestAppContext::single();
        app.update(|cx| crate::theme::init(crate::theme::Settings::default(), vec![], cx));
        let got = Got::default();
        let bench = got.clone();
        let (_view, cx) = app.add_window_view(move |_, _| Bench(bench));
        cx.run_until_parked();
        let position = point(px(x), px(y));
        let paths = ExternalPaths(names.iter().map(PathBuf::from).collect());
        cx.simulate_event(FileDropEvent::Entered { position, paths });
        cx.simulate_event(FileDropEvent::Pending { position });
        cx.simulate_event(FileDropEvent::Submit { position });
        got.take()
    }

    #[test]
    fn a_drop_over_a_panel_that_occludes_is_taken() {
        assert_eq!(drop_at(97., 141., &["D:/w/lid.funda", "D:/w/a.txt"]), [paths(&["D:/w/lid.funda", "D:/w/a.txt"])]);
    }

    #[test]
    fn a_drop_beside_the_panels_is_taken() {
        assert_eq!(drop_at(415., 87., &["C:/scan/part.stl"]), [paths(&["C:/scan/part.stl"])]);
    }

    fn paths(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }
}
