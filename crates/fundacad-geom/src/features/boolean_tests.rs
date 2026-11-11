use super::*;
use crate::kernel::KernelError;
use std::cell::Cell;

#[test]
fn a_sliced_retry_the_kernel_refuses_is_not_a_miss() {
    let body = kernel::make_box(10.0, 10.0, 10.0).unwrap();
    let halves = || vec![body.clone(), body.clone()];
    let refuse = |_: &Shape, _: &Shape| Err(KernelError("BOPAlgo_ImpossibleResult".into()));
    let untouched = |a: &Shape, _: &Shape| Ok(a.clone());
    let got = sliced(&body, [halves(), halves()], &|_| true, &refuse);
    assert_eq!(got.err().map(|e| e.0).as_deref(), Some("BOPAlgo_ImpossibleResult"));
    // A slicing that ran and changed nothing is the tool not reaching,
    // whatever an earlier one came to.
    let asked = Cell::new(0);
    let refused_once = |a: &Shape, b: &Shape| {
        asked.set(asked.get() + 1);
        if asked.get() == 1 {
            refuse(a, b)
        } else {
            untouched(a, b)
        }
    };
    assert!(matches!(sliced(&body, [halves(), halves()], &|_| false, &refused_once), Ok(None)));
    assert!(matches!(sliced(&body, [halves(), halves()], &|_| true, &untouched), Ok(Some(_))));
}

// A body of 7 x 9 x 11 whose slicing "removes" 100 mm3 for every mm a piece is wide: the fake boolean hands back
// a box that much lower, so the volume left is 693 minus the removal.
fn body() -> Shape {
    kernel::make_box(7.0, 9.0, 11.0).unwrap()
}

fn taking(removed: f64) -> Vec<Shape> {
    let piece = kernel::make_box(removed.max(1e-3) / 63.0, 1.0, 1.0).unwrap();
    vec![piece.clone(), piece]
}

fn lower(_: &Shape, piece: &Shape) -> KResult<Shape> {
    let width = kernel::bbox(piece).map(|b| b[3] - b[0]).unwrap();
    kernel::make_box(7.0, 9.0, 11.0 - width)
}

fn run(attempts: Vec<Vec<Shape>>) -> (Option<SlicedCut>, usize) {
    let drawn = Cell::new(0);
    let lazily = attempts.into_iter().inspect(|_| drawn.set(drawn.get() + 1));
    let got = sliced_cut(&body(), lazily, &lower, &vol).unwrap();
    (got, drawn.get())
}

fn left(c: &SlicedCut) -> f64 {
    vol(&c.shape)
}

#[test]
fn a_cut_keeps_the_largest_slicing_once_another_agrees() {
    let (got, drawn) = run(vec![taking(21.0), taking(30.0), taking(30.0), taking(45.0)]);
    let c = got.unwrap();
    assert!(!c.doubtful);
    assert_eq!(c.pieces, 2);
    assert!((left(&c) - (693.0 - 30.0)).abs() < 1e-6, "{}", left(&c));
    assert_eq!(drawn, 3, "no slicing is run once one is confirmed");
}

#[test]
fn a_cut_no_slicing_confirms_is_doubtful_and_keeps_the_largest() {
    let (got, drawn) = run(vec![taking(21.0), taking(30.0), taking(39.0)]);
    let c = got.unwrap();
    assert!(c.doubtful);
    assert!((left(&c) - (693.0 - 39.0)).abs() < 1e-6, "{}", left(&c));
    assert_eq!(drawn, 3);
}

#[test]
fn two_slicings_agree_within_two_percent_and_no_closer() {
    let (got, _) = run(vec![taking(63.0), taking(63.0 * 0.98 + 0.5)]);
    assert!(!got.unwrap().doubtful);
    let (got, _) = run(vec![taking(63.0), taking(63.0 * 0.98 - 0.5)]);
    assert!(got.unwrap().doubtful);
}

#[test]
fn a_slicing_that_removes_nothing_disagrees_with_one_that_does() {
    let (got, _) = run(vec![taking(0.0), taking(42.0)]);
    let c = got.unwrap();
    assert!(c.doubtful);
    assert!((left(&c) - (693.0 - 42.0)).abs() < 1e-6);
}

#[test]
fn a_cut_only_one_slicing_could_make_has_nothing_to_doubt() {
    let (got, _) = run(vec![taking(42.0), vec![body()]]);
    assert!(!got.unwrap().doubtful);
    let (got, _) = run(vec![taking(0.0), taking(0.0)]);
    assert!(got.is_none());
}

#[test]
fn a_slicing_the_kernel_refuses_does_not_hide_one_that_ran() {
    let tried = Cell::new(0);
    let boolean = |a: &Shape, p: &Shape| {
        tried.set(tried.get() + 1);
        if tried.get() <= 1 {
            Err(KernelError("BOPAlgo_ImpossibleResult".into()))
        } else {
            lower(a, p)
        }
    };
    let got = sliced_cut(&body(), [taking(42.0), taking(42.0)], &boolean, &vol).unwrap();
    assert!(got.is_some());
    let refuse = |_: &Shape, _: &Shape| Err(KernelError("BOPAlgo_ImpossibleResult".into()));
    assert!(sliced_cut(&body(), [taking(42.0)], &refuse, &vol).is_err());
}

#[test]
fn a_tool_is_sliced_across_the_axis_asked_for() {
    let tool = kernel::make_box(5.0, 3.0, 9.0).unwrap();
    let across = |rank| {
        in_slices(&tool, 2, rank)
            .iter()
            .map(|p| kernel::bbox(p).map(|b| [b[3] - b[0], b[4] - b[1], b[5] - b[2]]).unwrap())
            .collect::<Vec<_>>()
    };
    let near = |got: Vec<[f64; 3]>, want: [f64; 3]| {
        got.len() == 2 && got.iter().all(|g| g.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-6))
    };
    assert!(near(across(0), [5.0, 3.0, 4.5]));
    assert!(near(across(1), [2.5, 3.0, 9.0]));
    assert!(near(across(2), [5.0, 1.5, 9.0]));
}

fn kept(got: Option<SlicedCut>) -> Option<(f64, bool)> {
    got.map(|c| ((left(&c) * 1e6).round() / 1e6, c.doubtful))
}

#[test]
fn a_slicing_that_cannot_be_made_does_not_stop_the_next_axis() {
    let (got, drawn) = run(vec![vec![body()], taking(30.0), taking(30.0)]);
    assert_eq!((kept(got), drawn), (Some((663.0, false)), 3));
    let (got, drawn) = run(vec![taking(30.0), vec![body()], taking(45.0)]);
    assert_eq!((kept(got), drawn), (Some((648.0, true)), 3));
}
