use glam::Vec2;
use serde_json::{json, Value};

use super::*;

fn scrub(grab_signed: f64, grab_proj: f64, proj: f64, step: f64, limit: f64) -> f64 {
    scrub_signed(&Scrub { grab_signed, grab_proj, proj, step, limit })
}

#[test]
fn each_treatment_names_its_field_and_letter() {
    assert_eq!((Treatment::Fillet.field(), Treatment::Fillet.letter()), ("radius", "R"));
    assert_eq!((Treatment::Chamfer.field(), Treatment::Chamfer.letter()), ("distance", "D"));
    assert_eq!(Treatment::Fillet.other().other(), Treatment::Fillet);
    assert_eq!(Treatment::Chamfer.label(), "Chamfer");
}

#[test]
fn the_drag_is_capped_at_half_the_diagonal() {
    assert!((drag_limit(Some(100.0)) - 50.0).abs() < 1e-9);
    assert_eq!(drag_limit(None), f64::INFINITY);
    assert_eq!(drag_limit(Some(0.0)), f64::INFINITY);
    assert_eq!(drag_limit(Some(f64::NAN)), f64::INFINITY);
    assert!(drag_limit(Some(0.0001)) >= MIN_EDGE_VALUE);
    assert!(drag_limit(Some(3f64.sqrt() * 40.0)) >= 20.0);
}

#[test]
fn the_range_keeps_the_largest_built_and_smallest_refused() {
    let r = BlendRange::default().note(2.0, true).note(5.0, false).note(3.0, true).note(4.0, false);
    assert_eq!(r, BlendRange { built: Some(3.0), refused: Some(4.0) });
    let same = BlendRange::default().note(3.0, true).note(3.0, false);
    assert_eq!(same.built, None);
    let late = BlendRange::default().note(3.0, false).note(4.0, true);
    assert_eq!(late.built, None);
    assert_eq!(BlendRange::default().note(f64::NAN, false).note(-1.0, true), BlendRange::default());
}

#[test]
fn the_verdict_refuses_past_a_refusal_without_asking() {
    let r = BlendRange::default().note(2.0, true).note(5.0, false);
    assert_eq!(BlendRange::default().verdict(1.0), Verdict::Unknown);
    assert_eq!(r.verdict(5.0), Verdict::Refused);
    assert_eq!(r.verdict(9.0), Verdict::Refused);
    assert_eq!(r.verdict(5.0 - 1e-12), Verdict::Refused);
    assert_eq!(r.verdict(4.0), Verdict::Unknown);
    assert_eq!(r.verdict(1.5), Verdict::Builds);
    assert_eq!(r.verdict(0.0), Verdict::Unknown);
}

#[test]
fn a_refused_drag_commits_what_is_shown_or_nothing() {
    assert_eq!(commit_decision(5.0, Verdict::Refused, false, Some(2.0), false), Commit::Commit { value: 2.0, unverified: false });
    assert_eq!(commit_decision(5.0, Verdict::Refused, false, None, false), Commit::Cancel);
    assert_eq!(commit_decision(5.0, Verdict::Refused, false, Some(2.0), true), Commit::Stay);
    assert_eq!(commit_decision(2.0, Verdict::Unknown, true, Some(2.0), false), Commit::Commit { value: 2.0, unverified: false });
    assert_eq!(commit_decision(3.0, Verdict::Unknown, false, Some(2.0), false), Commit::Commit { value: 3.0, unverified: true });
    assert_eq!(commit_decision(1.0, Verdict::Builds, false, Some(2.0), false), Commit::Commit { value: 1.0, unverified: false });
}

#[test]
fn a_too_large_blend_says_what_it_fits_up_to() {
    let one = refusal_reason(Treatment::Fillet, 1, Some("blendTooLarge"), "Fillet failed. It fits up to 4.99mm");
    assert_eq!(one, "Radius too large for the faces around this edge, it fits up to 4.99 mm");
    let older = refusal_reason(Treatment::Chamfer, 2, None, "use a smaller value");
    assert_eq!(older, "Distance too large for the faces around these edges");
    let pair = refusal_reason(
        Treatment::Chamfer,
        1,
        Some("blendTooLarge"),
        "It fits up to 3.99mm with distance 2 at 9.97mm",
    );
    assert_eq!(pair, "Distance too large for the faces around this edge, it fits up to 3.99 mm with distance 2 at 9.97 mm");
}

#[test]
fn other_refusals_never_say_go_smaller() {
    let smooth = refusal_reason(Treatment::Fillet, 1, Some("edgeAlreadySmooth"), "x");
    assert_eq!(smooth, "This edge is already smooth, there is no corner to round");
    assert!(refusal_reason(Treatment::Chamfer, 2, Some("edgeIsSeam"), "x").starts_with("These edges are a seam"));
    assert!(refusal_reason(Treatment::Fillet, 1, Some("blendHasNoEnd"), "x").starts_with("No fillet size works"));
    assert_eq!(refusal_reason(Treatment::Chamfer, 1, Some("blendFoldsOver"), "x"), "At this size the chamfer folds back over the model");
    assert_eq!(refusal_reason(Treatment::Fillet, 1, None, "Fillet failed on f3: the faces do not meet"), "the faces do not meet");
}

#[test]
fn a_chosen_value_is_floored_and_held_in_bounds() {
    let b = value_bounds(Some(100.0));
    assert_eq!(clamp_value(0.0, b), MIN_EDGE_VALUE);
    assert_eq!(clamp_value(80.0, b), 50.0);
    assert_eq!(clamp_value(f64::NAN, b), MIN_EDGE_VALUE);
    let tiny = value_bounds(Some(1e-6));
    assert!(tiny.max >= tiny.min);
}

#[test]
fn the_scrub_is_relative_to_the_grab_and_snapped() {
    assert_eq!(scrub(2.0, 10.0, 10.0, 0.5, 50.0), 2.0);
    assert_eq!(scrub(2.0, 10.0, 11.0, 0.5, 50.0), 3.0);
    assert_eq!(scrub(0.0, 0.0, 1.26, 0.5, 50.0), 1.5);
    assert_eq!(scrub(0.0, 0.0, 0.3, 0.1, 50.0), 0.3);
}

#[test]
fn the_scrub_passes_through_zero_with_a_dead_zone() {
    assert_eq!(scrub(1.0, 0.0, -3.0, 0.5, 50.0), -2.0);
    assert_eq!(scrub(0.0, 0.0, 0.4, 0.5, 50.0), 0.0);
    assert_eq!(scrub(0.0, 0.0, -0.4, 0.5, 50.0), 0.0);
    assert_eq!(scrub(0.0, 0.0, 99.0, 0.5, 5.0), 5.0);
    assert_eq!(scrub(0.0, 0.0, -99.0, 0.5, 5.0), -5.0);
    assert_eq!(scrub(0.0, 0.0, 120.0, 0.5, 5.0), scrub(0.0, 0.0, 99.0, 0.5, 5.0));
    assert_eq!(scrub(0.0, f64::NAN, 1.0, 0.5, 5.0), 0.0);
}

#[test]
fn the_side_of_the_origin_picks_the_treatment() {
    assert_eq!(treatment_at(Treatment::Fillet, 2.0), (Treatment::Fillet, 2.0));
    assert_eq!(treatment_at(Treatment::Fillet, -2.0), (Treatment::Chamfer, 2.0));
    assert_eq!(treatment_at(Treatment::Chamfer, 0.0).1, 0.0);
    let b = value_bounds(Some(10.0));
    assert_eq!(switch_treatment(Treatment::Fillet, 3.0, b), (Treatment::Chamfer, 3.0));
    assert_eq!(switch_treatment(Treatment::Chamfer, 30.0, b), (Treatment::Fillet, 5.0));
    assert_eq!(seed_value(Treatment::Fillet, b), 2.0);
    assert_eq!(seed_value(Treatment::Chamfer, value_bounds(Some(1.0))), 0.5);
}

#[test]
fn the_step_is_a_round_number_of_about_ten_pixels() {
    assert_eq!(snap_step(0.1, false), 1.0);
    assert_eq!(snap_step(0.03, false), 0.5);
    assert!((snap_step(0.03, true) - 0.05).abs() < 1e-12);
    assert_eq!(snap_step(0.5, false), 5.0);
}

#[test]
fn the_swipe_is_measured_across_the_edge() {
    let o = Vec2::ZERO;
    assert_eq!(swipe_offset_px(o, Vec2::new(40.0, 0.0), Vec2::new(0.0, 1.0), Vec2::new(25.0, 10.0)), 10.0);
    assert_eq!(swipe_offset_px(o, Vec2::new(40.0, 0.0), Vec2::new(0.0, -1.0), Vec2::new(25.0, 10.0)), -10.0);
    assert_eq!(swipe_offset_px(o, Vec2::new(1.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(7.0, 3.0)), 7.0);
    assert_eq!(swipe_offset_px(o, Vec2::ZERO, Vec2::ZERO, Vec2::new(7.0, 3.0)), 0.0);
}

#[test]
fn the_gate_warns_then_refuses() {
    assert_eq!(edge_gate(1), Gate::Go);
    assert_eq!(edge_gate(EDGE_WARN), Gate::Go);
    assert_eq!(edge_gate(EDGE_WARN + 1), Gate::Warn);
    assert_eq!(edge_gate(EDGE_CAP), Gate::Warn);
    assert_eq!(edge_gate(EDGE_CAP + 1), Gate::Refuse);
}

fn blend(radius: f64, id: &str) -> Value {
    json!({"id": id, "type": "fillet", "radius": radius, "edges": [{"kind": "edge", "by": "nearest", "point": [0, 0, 5]}]})
}

#[test]
fn a_preview_is_keyed_by_all_but_its_id() {
    assert_eq!(feature_key(&blend(1.0, "a")), feature_key(&blend(1.0, "b")));
    assert_ne!(feature_key(&blend(1.0, "a")), feature_key(&blend(2.0, "a")));
}

#[test]
fn a_refusal_holds_the_last_size_that_built() {
    let mut o = Outcomes::default();
    o.note(Some(&blend(1.0, "f9")), Reply::Built);
    o.note(Some(&blend(3.0, "f9")), Reply::Refused("too large".into()));
    assert_eq!(o.shown, Some(blend(1.0, "f9")));
    assert_eq!(o.verdict(&feature_key(&blend(1.0, "f9"))), Verdict::Builds);
    assert_eq!(o.verdict(&feature_key(&blend(3.0, "f9"))), Verdict::Refused);
    assert_eq!(o.verdict(&feature_key(&blend(2.0, "f9"))), Verdict::Unknown);
    assert_eq!(o.shown_for(&blend(2.0, "f9"), &["radius"]), Some(&blend(1.0, "f9")));
    assert_eq!(o.shown_for(&json!({"id": "f9", "type": "chamfer"}), &["radius"]), None);
}

#[test]
fn a_failed_build_says_nothing_and_no_preview_shows_nothing() {
    let mut o = Outcomes::default();
    o.note(Some(&blend(1.0, "f9")), Reply::Failed);
    assert_eq!(o.verdict(&feature_key(&blend(1.0, "f9"))), Verdict::Unknown);
    o.note(Some(&blend(1.0, "f9")), Reply::Built);
    o.note(None, Reply::Built);
    assert_eq!(o.shown, None);
}

#[test]
fn a_refusal_stays_up_until_a_value_builds() {
    let mut o = Outcomes::default();
    let (big, less) = (feature_key(&blend(3.0, "f9")), feature_key(&blend(2.5, "f9")));
    o.note(Some(&blend(3.0, "f9")), Reply::Refused("too large".into()));
    assert!(o.refresh(Some(&big)));
    assert!(!o.refresh(Some(&less)));
    assert_eq!(o.refusal.as_deref(), Some("too large"));
    o.note(Some(&blend(2.5, "f9")), Reply::Built);
    assert!(o.refresh(Some(&less)));
    assert_eq!(o.refusal, None);
    o.refresh(Some(&big));
    assert!(o.refresh(None));
    assert_eq!(o.refusal, None);
}

#[test]
fn it_is_settled_once_that_very_preview_is_on_screen() {
    let mut o = Outcomes::default();
    o.note(Some(&blend(1.0, "f9")), Reply::Built);
    assert!(o.settled(&feature_key(&blend(1.0, "f9"))));
    assert!(!o.settled(&feature_key(&blend(2.0, "f9"))));
    o.forget();
    assert!(!o.settled(&feature_key(&blend(1.0, "f9"))));
}
