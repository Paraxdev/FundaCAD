use super::toast::{Kind, Toasts};

#[test]
fn toasts_keep_the_newest_four_and_dismiss_by_id() {
    let mut t = Toasts::default();
    let ids: Vec<u64> = (0..5).map(|i| t.push(Kind::Info, format!("n{i}"))).collect();
    let shown: Vec<&str> = t.shown().iter().map(|t| t.text.as_str()).collect();
    assert_eq!(shown, ["n1", "n2", "n3", "n4"]);
    t.dismiss(ids[2]);
    assert_eq!(t.shown().len(), 3);
    t.dismiss(ids[0]);
    assert_eq!(t.shown().len(), 3);
    let e = t.push(Kind::Error, "bad");
    assert_eq!(t.shown().last().map(|t| (t.id, t.kind)), Some((e, Kind::Error)));
}
