use fundacad_geom::select::eval::*;
use fundacad_geom::select::Tuning;
use serde_json::{json, Value};

#[test]
fn selector_v2_checks_pass_under_the_shipped_tuning() {
    selector_v2_checks(Tuning::shipped()).unwrap();
}

fn approx(a: &Value, b: f64) -> bool {
    (a.as_f64().unwrap_or(f64::NAN) - b).abs() <= 1e-9
}

#[test]
fn invalid_leaves_numerator_and_denominator() {
    use Outcome::*;
    let out = aggregate(&[
        ("concentric", Survive),
        ("concentric", Survive),
        ("concentric", Miss),
        ("mirrored_twin", Survive),
        ("mirrored_twin", Invalid),
        ("boolean_stack", Miss),
    ]);
    assert!(approx(&out["v2_rate"], 0.6));
    assert!(approx(&out["concentric"], 0.666667));
    assert!(approx(&out["mirrored_twin"], 1.0));
    assert!(approx(&out["boolean_stack"], 0.0));
    assert!(approx(&out["moved_sketch"], 0.0));
    assert_eq!(out["invalid_count"], json!(1.0));
}

#[test]
fn all_invalid_is_zero_not_a_crash() {
    let out = aggregate(&[("concentric", Outcome::Invalid), ("concentric", Outcome::Invalid)]);
    assert!(approx(&out["v2_rate"], 0.0));
    assert!(approx(&out["concentric"], 0.0));
    assert_eq!(out["invalid_count"], json!(2.0));
}

#[test]
fn rounding_six_places_and_the_extremes() {
    use Outcome::*;
    let out = aggregate(&[("concentric", Survive), ("concentric", Miss), ("concentric", Miss)]);
    assert!(approx(&out["concentric"], 0.333333));
    assert!(approx(&out["v2_rate"], 0.333333));
    assert!(approx(&aggregate(&[("moved_sketch", Survive)])["v2_rate"], 1.0));
    assert!(approx(&aggregate(&[("moved_sketch", Miss)])["v2_rate"], 0.0));
}
