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

// The L plate of oversize_fillet.rs, its three chosen edges meet at its inside corner, so 5 is refused with 4.99.
fn l_plate_chamfer(fid: &str, height: f64, distance: f64) -> Option<f64> {
    let top = [(0.0, 0.0), (30.0, 0.0), (30.0, 10.0), (12.0, 10.0), (12.0, 24.0), (0.0, 24.0)];
    let turned: Vec<(f64, f64)> =
        top.iter().map(|&(x, y)| (7.0 + 0.8 * x - 0.6 * y, -3.0 + 0.6 * x + 0.8 * y)).collect();
    let lines: Vec<Value> = (0..turned.len())
        .map(|i| {
            let (a, b) = (turned[i], turned[(i + 1) % turned.len()]);
            json!({"type": "line", "id": format!("l{i}"), "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1})
        })
        .collect();
    let raw = json!({"parameters": {}, "features": [
        {"id": "sk", "type": "sketch", "plane": {"origin": [2, -1, 3], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
            "entities": lines},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": height, "operation": "new",
            "regions": [[9.2, -2.6, 3.0]]},
        {"id": fid, "type": "chamfer", "distance": distance, "edges": {"kind": "edge", "by": "all", "body": "body1"}},
    ]});
    let doc: fundacad_core::CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let built = crate::builder::rebuild(&doc, &raw, &crate::builder::NoWatch).unwrap();
    let said = &built.errors.first()?.message;
    said.split("fits up to ").nth(1)?.split("mm").next()?.parse().ok()
}

#[test]
fn a_rebuild_of_an_unchanged_refused_chamfer_offers_what_its_last_search_found() {
    let fid = "offer-memo";
    assert_eq!(l_plate_chamfer(fid, 10.0, 5.0), Some(4.99));
    // A changed offer read back shows the rebuild did not search again.
    for held in KERNEL_OFFERS.lock().unwrap().iter_mut().filter(|o| o.key.starts_with(fid)) {
        held.fits = Some(1.23);
    }
    let got = [l_plate_chamfer(fid, 10.0, 5.0), l_plate_chamfer(fid, 11.0, 5.0), l_plate_chamfer("other", 10.0, 5.0)];
    assert_eq!(got, [Some(1.23), Some(4.99), Some(4.99)]);
}
