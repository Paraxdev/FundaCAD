use super::*;

use crate::kernel::{self, BoolKind, Kind};

const AT: [f64; 3] = [3.25, -6.5, 2.75];

// Tipped about a slanted axis and moved off the origin, so no edge lies along an axis.
fn placed(s: &Shape) -> Shape {
    let tipped = kernel::rotated_about(s, [0.4, -0.3, 0.2], [0.3, 0.8, 0.52], 27.0).unwrap();
    kernel::translated(&tipped, AT).unwrap()
}

fn unchanged(r: FResult) -> bool {
    matches!(r, Err(Fail::Value { code: Some(BLEND_CHANGED_NOTHING), .. }))
}

#[test]
fn a_blend_that_hands_the_body_back_is_refused() {
    let body = placed(&kernel::make_box(10.0, 7.0, 9.0).unwrap());
    let edges = kernel::subshapes(&body, Kind::Edge);
    let (rounded, _) = ops::fillet(&body, &edges[..3], &[0.8; 3]).unwrap();
    let afters = [
        body.clone(),
        kernel::copy(&body).unwrap(),
        placed(&kernel::make_box(10.0, 7.0, 9.0 + 1e-9).unwrap()),
        placed(&kernel::make_box(10.0, 7.0, 9.0 + 1e-6).unwrap()),
        rounded,
    ];
    let refused: Vec<bool> = afters.iter().map(|a| unchanged(refuse_unchanged(&body, a, "Chamfer", "Box"))).collect();
    assert_eq!(refused, [true, true, true, false, false]);
}

#[test]
fn edges_the_blend_handed_back_are_still_sharp() {
    let body = placed(&kernel::make_box(9.0, 6.0, 4.0).unwrap());
    let edges = kernel::subshapes(&body, Kind::Edge);
    assert_eq!(still_sharp(&kernel::copy(&body).unwrap(), &edges).len(), 12);
    let (all, _) = ops::fillet(&body, &edges, &[0.8; 12]).unwrap();
    assert!(still_sharp(&all, &edges).is_empty());
    let short: Vec<Shape> = edges.iter().filter(|e| (kernel::length(e) - 4.0).abs() < 1e-6).cloned().collect();
    let (four, _) = ops::fillet(&body, &short, &[0.8; 4]).unwrap();
    let mut left: Vec<f64> = still_sharp(&four, &edges).iter().map(|e| kernel::length(e).round()).collect();
    left.sort_by(f64::total_cmp);
    assert_eq!(left, [6.0, 6.0, 6.0, 6.0, 9.0, 9.0, 9.0, 9.0]);
}

// An edge of the result that runs through the asked edge's midpoint still counts as that edge while it keeps
// more than half its length.
#[test]
fn a_piece_of_an_edge_is_still_sharp_while_it_keeps_over_half() {
    let asked = placed(&kernel::make_box(4.0, 5.0, 10.0).unwrap());
    let long: Vec<Shape> =
        kernel::subshapes(&asked, Kind::Edge).into_iter().filter(|e| kernel::length(e) > 9.0).take(1).collect();
    let sharp: Vec<bool> = [2.9, 4.9, 5.0, 5.1, 7.0, 13.0, 15.1]
        .iter()
        .map(|&h| !still_sharp(&placed(&kernel::make_box(4.0, 5.0, h).unwrap()), &long).is_empty())
        .collect();
    assert_eq!(sharp, [false, false, false, true, true, true, false]);
}

#[test]
fn a_blend_that_fills_a_cavity_does_not_keep_the_voids() {
    let outer = placed(&kernel::make_box(12.0, 9.0, 7.0).unwrap());
    let hollow = |at: [f64; 3]| placed(&kernel::translated(&kernel::make_box(3.0, 2.0, 2.0).unwrap(), at).unwrap());
    let (c1, c2) = (hollow([-2.5, 1.5, 0.5]), hollow([2.75, -1.75, -1.0]));
    let one = kernel::boolean_op(&outer, &[&c1], BoolKind::Cut).unwrap();
    let two = kernel::boolean_op(&outer, &[&c1, &c2], BoolKind::Cut).unwrap();
    assert_eq!([kernel::void_count(&outer), kernel::void_count(&one), kernel::void_count(&two)], [0, 1, 2]);
    let pairs = [(&two, &one), (&one, &outer), (&two, &kernel::copy(&two).unwrap()), (&one, &two), (&outer, &outer)];
    let kept: Vec<bool> = pairs.iter().map(|(b, a)| keeps_voids(b, a)).collect();
    assert_eq!(kept, [false, false, true, true, true]);
}

#[test]
fn a_drag_that_fell_back_asks_the_kernel_again_below_that_size() {
    let key = "test-fell-back|body1|Fillet|[]".to_owned();
    assert!(!fell_back_before(&key, 43.7));
    remember_fell_back(key.clone(), 43.7);
    assert!(fell_back_before(&key, 43.7));
    assert!(fell_back_before(&key, 50.0));
    assert!(!fell_back_before(&key, 3.0));
    remember_fell_back(key.clone(), 37.0);
    assert!(fell_back_before(&key, 40.0));
    assert!(!fell_back_before(&key, 36.0));
}

#[test]
fn kernel_sentence_drops_the_max_fillet_tail() {
    assert_eq!(
        kernel_sentence("Failed creating a fillet with radius of 5, try a smaller value or use max_fillet() to find the largest valid fillet radius"),
        "Failed creating a fillet with radius of 5, try a smaller value"
    );
    assert_eq!(kernel_sentence("x, or use max_fillet() y. z"), "x. z");
}
