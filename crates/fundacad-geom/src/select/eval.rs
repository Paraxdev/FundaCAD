//! The selector survival eval, sidecar/tools/eval_selector_survival.py over the
//! frozen corpus of sidecar/tools/gen_selector_corpus.py, scored by this engine.
//!
//! Each case rebuilds its mutated part, checks the frozen key still names one
//! entity (else the case is invalid and counts nowhere), resolves the stored
//! `by:"match"` selector and scores survival when the resolved entity's key is
//! the frozen one. The metric JSON has the Python's keys and arithmetic.

use opencascade::primitives::Shape;
use serde_json::{json, Map, Value};

use super::entity::{edges_of, faces_of, py_round, EdgeEnt, FaceEnt};
use super::{Resolver, Tuning};
use crate::builder::{FResult, Fail};
use crate::kernel::{self, BoolKind};

pub const CATEGORIES: [&str; 6] = [
    "concentric",
    "mirrored_twin",
    "boolean_stack",
    "moved_sketch",
    "dimension_change",
    "added_feature",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Survive,
    Miss,
    Invalid,
}

fn p(params: &Value, key: &str) -> FResult<f64> {
    params
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| Fail::Missing(key.to_owned()))
}

/// `gen_selector_corpus.build_part`.
pub fn build_part(spec: &Value) -> FResult<Shape> {
    let params = spec
        .get("params")
        .ok_or_else(|| Fail::Missing("params".into()))?;
    match spec.get("archetype").and_then(Value::as_str) {
        Some("box") => {
            let part = kernel::make_box(p(params, "w")?, p(params, "d")?, p(params, "h")?)?;
            match params.get("pos").and_then(Value::as_array) {
                Some(pos) if !pos.is_empty() => {
                    let c = |i: usize| pos.get(i).and_then(Value::as_f64).unwrap_or(0.0);
                    Ok(kernel::translated(&part, [c(0), c(1), c(2)])?)
                }
                _ => Ok(part),
            }
        }
        Some("pipe") => {
            let h = p(params, "h")?;
            let outer = kernel::make_cylinder(p(params, "R")?, h)?;
            let inner = kernel::make_cylinder(p(params, "r")?, h)?;
            Ok(kernel::boolean_op(&outer, &[&inner], BoolKind::Cut)?)
        }
        Some("box_holes") => {
            let h = p(params, "h")?;
            let mut part = kernel::make_box(p(params, "w")?, p(params, "d")?, h)?;
            let holes = params
                .get("holes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for hole in holes {
                let n = |i: usize| hole.get(i).and_then(Value::as_f64).unwrap_or(0.0);
                let cyl = kernel::make_cylinder(n(2), h * 3.0)?;
                let tool = kernel::translated(&cyl, [n(0), n(1), 0.0])?;
                part = kernel::boolean_op(&part, &[&tool], BoolKind::Cut)?;
            }
            Ok(part)
        }
        other => Err(Fail::msg(format!(
            "unknown archetype: {}",
            other.unwrap_or("None")
        ))),
    }
}

fn rnd3(v: glam::DVec3) -> Value {
    json!([py_round(v.x, 4), py_round(v.y, 4), py_round(v.z, 4)])
}

/// `gen_selector_corpus.edge_key`: circles by centre and radius, else midpoint and length.
pub fn edge_key(e: &EdgeEnt) -> Value {
    let curve = e.curve_name();
    if curve == "circle" {
        return json!([
            "edge",
            "circle",
            e.centre().map_or(Value::Null, rnd3),
            e.radius().map_or(Value::Null, |r| json!(py_round(r, 4)))
        ]);
    }
    json!(["edge", curve, rnd3(e.mid), py_round(e.length, 4)])
}

/// `gen_selector_corpus.face_key`.
pub fn face_key(f: &FaceEnt) -> Value {
    json!([
        "face",
        f.surface_name(),
        rnd3(f.centroid()),
        py_round(f.area, 4),
        f.radius.map_or(Value::Null, |r| json!(py_round(r, 4)))
    ])
}

/// Python `==` between two decoded JSON values: numbers by value.
pub fn py_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| py_eq(p, q))
        }
        _ => a == b,
    }
}

/// `score_case`. A case that cannot be built is invalid, not a miss.
pub fn score_case(case: &Value, tuning: &Tuning) -> (Outcome, Option<String>) {
    match try_score(case, tuning) {
        Ok(o) => (o, None),
        Err(e) => (Outcome::Invalid, Some(format!("{e:?}"))),
    }
}

fn try_score(case: &Value, tuning: &Tuning) -> FResult<Outcome> {
    let kind = case.get("kind").and_then(Value::as_str).unwrap_or("");
    let expected = case
        .get("expected_key")
        .ok_or_else(|| Fail::Missing("expected_key".into()))?;
    let selector = case
        .get("selector")
        .ok_or_else(|| Fail::Missing("selector".into()))?;
    let part = build_part(case.get("mutated_spec").unwrap_or(&Value::Null))?;
    let mut r = Resolver::new(None, None).with_tuning(tuning);
    if kind == "edge" {
        let matching = edges_of(&part)?
            .iter()
            .filter(|e| py_eq(&edge_key(e), expected))
            .count();
        if matching != 1 {
            return Ok(Outcome::Invalid);
        }
        let got = r.edges(&part, selector)?;
        Ok(match got.first() {
            Some(e) if py_eq(&edge_key(&EdgeEnt::new(e.clone())?), expected) => Outcome::Survive,
            _ => Outcome::Miss,
        })
    } else {
        let matching = faces_of(&part)?
            .iter()
            .filter(|f| py_eq(&face_key(f), expected))
            .count();
        if matching != 1 {
            return Ok(Outcome::Invalid);
        }
        let got = r.faces(&part, selector)?;
        Ok(match got.first() {
            Some(f) if py_eq(&face_key(&FaceEnt::new(f.clone())?), expected) => Outcome::Survive,
            _ => Outcome::Miss,
        })
    }
}

fn rate(num: usize, den: usize) -> f64 {
    if den == 0 {
        0.0
    } else {
        py_round(num as f64 / den as f64, 6)
    }
}

/// `aggregate`: invalid cases leave numerator and denominator alike, an empty
/// denominator rates 0.0. `tests_pass` is added by the caller.
pub fn aggregate(outcomes: &[(&str, Outcome)]) -> Map<String, Value> {
    let mut survive = [0usize; 6];
    let mut valid = [0usize; 6];
    let mut invalid = 0usize;
    for (cat, o) in outcomes {
        if *o == Outcome::Invalid {
            invalid += 1;
            continue;
        }
        let Some(i) = CATEGORIES.iter().position(|c| c == cat) else {
            continue;
        };
        valid[i] += 1;
        if *o == Outcome::Survive {
            survive[i] += 1;
        }
    }
    let mut out = Map::new();
    out.insert(
        "v2_rate".into(),
        json!(rate(survive.iter().sum(), valid.iter().sum())),
    );
    for (i, c) in CATEGORIES.iter().enumerate() {
        out.insert((*c).into(), json!(rate(survive[i], valid[i])));
    }
    out.insert("invalid_count".into(), json!(invalid as f64));
    out
}

/// Every case of a corpus scored: the metric map, then (category, survived, valid).
pub fn run(
    corpus: &Value,
    tuning: &Tuning,
    mut log: impl FnMut(&str),
) -> (Map<String, Value>, Vec<(String, usize, usize)>) {
    let cases = corpus
        .get("cases")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut outcomes = Vec::new();
    for case in &cases {
        let (o, err) = score_case(case, tuning);
        if let Some(err) = err {
            log(&format!(
                "  case {} raised: {err}",
                case.get("id").and_then(Value::as_str).unwrap_or("?")
            ));
        }
        if o == Outcome::Miss {
            log(&format!(
                "  case {} missed",
                case.get("id").and_then(Value::as_str).unwrap_or("?")
            ));
        }
        outcomes.push((
            case.get("category").and_then(Value::as_str).unwrap_or(""),
            o,
        ));
    }
    let metrics = aggregate(&outcomes);
    let counts = CATEGORIES
        .iter()
        .map(|c| {
            let of = |pred: fn(Outcome) -> bool| {
                outcomes
                    .iter()
                    .filter(|(cat, o)| cat == c && pred(*o))
                    .count()
            };
            (
                (*c).to_owned(),
                of(|o| o == Outcome::Survive),
                of(|o| o != Outcome::Invalid),
            )
        })
        .collect();
    (metrics, counts)
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

fn ensure(ok: bool, what: &str) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(what.to_owned())
    }
}

fn kerr(e: impl std::fmt::Debug) -> String {
    format!("{e:?}")
}

fn cut(a: &Shape, b: &Shape) -> Result<Shape, String> {
    kernel::boolean_op(a, &[b], BoolKind::Cut).map_err(kerr)
}

fn ents_edges(part: &Shape) -> Result<Vec<EdgeEnt>, String> {
    edges_of(part).map_err(kerr)
}

fn top_circles(part: &Shape, z: f64) -> Result<Vec<EdgeEnt>, String> {
    Ok(ents_edges(part)?
        .into_iter()
        .filter(|e| e.curve_name() == "circle" && close(e.mid.z, z, 0.05))
        .collect())
}

fn radius_of(shapes: &[Shape], i: usize) -> Result<f64, String> {
    let s = shapes.get(i).ok_or("nothing resolved")?;
    EdgeEnt::new(s.clone())
        .map_err(kerr)?
        .radius()
        .ok_or_else(|| "not a circle".into())
}

/// sidecar/tests/test_selector_v2.py, the eval's `tests_pass` guardrail, run on
/// this engine under the tuning being scored.
pub fn selector_v2_checks(tuning: &Tuning) -> Result<(), String> {
    use super::{edge_fingerprint_with, face_fingerprint};
    let r = || Resolver::new(None, None).with_tuning(tuning);
    let boxed = kernel::make_box(20.0, 20.0, 10.0).map_err(kerr)?;

    let x_edges = r()
        .edges(&boxed, &json!({"kind": "edge", "by": "axis", "axis": "X"}))
        .map_err(kerr)?;
    ensure(x_edges.len() == 4, "axis X grabs all 4 X edges")?;
    let target = ents_edges(&boxed)?
        .into_iter()
        .find(|e| {
            e.curve_name() == "line"
                && e.dir().x.abs() > 0.99
                && close(e.mid.y, 10.0, 1e-3)
                && close(e.mid.z, 5.0, 1e-3)
        })
        .ok_or("no top front X edge")?;
    let fp = edge_fingerprint_with(tuning, &target.shape, &boxed).map_err(kerr)?;
    let got = r()
        .edges(&boxed, &json!({"kind": "edge", "by": "match", "fp": fp}))
        .map_err(kerr)?;
    ensure(got.len() == 1, "match picks exactly one edge")?;
    let m = EdgeEnt::new(got[0].clone()).map_err(kerr)?.mid;
    ensure(
        close(m.y, 10.0, 1e-3) && close(m.z, 5.0, 1e-3),
        "match picks the right X edge",
    )?;

    let faces = faces_of(&boxed).map_err(kerr)?;
    let top = faces
        .iter()
        .max_by(|a, b| a.centroid().z.total_cmp(&b.centroid().z))
        .ok_or("no faces")?;
    let (c, n) = (top.centroid(), top.normal());
    let face_fp = json!({"centroid": [c.x, c.y, c.z], "normal": [n.x, n.y, n.z], "area": top.area});
    let got = r()
        .edges(
            &boxed,
            &json!({"kind": "edge", "by": "ofFace", "face": face_fp}),
        )
        .map_err(kerr)?;
    ensure(got.len() == 4, "ofFace(top) is 4 edges")?;
    for e in &got {
        ensure(
            close(EdgeEnt::new(e.clone()).map_err(kerr)?.mid.z, 5.0, 1e-3),
            "ofFace edges lie on the top face",
        )?;
    }

    let tube = cut(
        &kernel::make_cylinder(10.0, 10.0).map_err(kerr)?,
        &kernel::make_cylinder(5.0, 10.0).map_err(kerr)?,
    )?;
    let rims = top_circles(&tube, 5.0)?;
    ensure(rims.len() == 2, "a pipe has 2 concentric top circles")?;
    let by_r = |want_outer: bool| {
        rims.iter()
            .max_by(|a, b| {
                let o = a
                    .radius()
                    .unwrap_or(0.0)
                    .total_cmp(&b.radius().unwrap_or(0.0));
                if want_outer {
                    o
                } else {
                    o.reverse()
                }
            })
            .map(|e| e.shape.clone())
    };
    let (outer, inner) = (by_r(true).ok_or("no rim")?, by_r(false).ok_or("no rim")?);
    let fo = edge_fingerprint_with(tuning, &outer, &tube).map_err(kerr)?;
    let fi = edge_fingerprint_with(tuning, &inner, &tube).map_err(kerr)?;
    let go = r()
        .edges(&tube, &json!({"kind": "edge", "by": "match", "fp": fo}))
        .map_err(kerr)?;
    let gi = r()
        .edges(&tube, &json!({"kind": "edge", "by": "match", "fp": fi}))
        .map_err(kerr)?;
    ensure(
        close(radius_of(&go, 0)?, 10.0, 0.05),
        "match picks the r=10 circle",
    )?;
    ensure(
        close(radius_of(&gi, 0)?, 5.0, 0.05),
        "match picks the r=5 circle",
    )?;
    let both = r()
        .edges(
            &tube,
            &json!([{"kind": "edge", "by": "match", "fp": fo}, {"kind": "edge", "by": "match", "fp": fi}]),
        )
        .map_err(kerr)?;
    let mut radii: Vec<f64> = (0..both.len())
        .map(|i| radius_of(&both, i))
        .collect::<Result<_, _>>()?;
    radii.sort_by(f64::total_cmp);
    ensure(
        radii.len() == 2 && close(radii[0], 5.0, 0.05) && close(radii[1], 10.0, 0.05),
        "concentric de-dup keeps both",
    )?;

    let pipe = cut(
        &kernel::make_cylinder(20.0, 12.0).map_err(kerr)?,
        &kernel::make_cylinder(10.0, 12.0).map_err(kerr)?,
    )?;
    let rims = top_circles(&pipe, 6.0)?;
    let outer = rims
        .iter()
        .max_by(|a, b| {
            a.radius()
                .unwrap_or(0.0)
                .total_cmp(&b.radius().unwrap_or(0.0))
        })
        .ok_or("no rim")?;
    let fp = edge_fingerprint_with(tuning, &outer.shape, &pipe).map_err(kerr)?;
    ensure(
        fp["radius_group"] == json!(2) && fp["radius_rank"] == json!(1),
        "outer rim fp is rank 1 of 2",
    )?;
    let scaled = cut(
        &kernel::make_cylinder(34.0, 12.0).map_err(kerr)?,
        &kernel::make_cylinder(17.0, 12.0).map_err(kerr)?,
    )?;
    let got = r()
        .edges(&scaled, &json!({"kind": "edge", "by": "match", "fp": fp}))
        .map_err(kerr)?;
    ensure(
        got.len() == 1 && close(radius_of(&got, 0)?, 34.0, 0.1),
        "scaled match keeps the outer rim",
    )?;

    let holed = cut(
        &kernel::make_box(40.0, 40.0, 10.0).map_err(kerr)?,
        &kernel::make_cylinder(5.0, 30.0).map_err(kerr)?,
    )?;
    let rim = ents_edges(&holed)?
        .into_iter()
        .filter(|e| e.curve_name() == "circle")
        .max_by(|a, b| a.mid.z.total_cmp(&b.mid.z))
        .ok_or("no hole rim")?;
    let fp = edge_fingerprint_with(tuning, &rim.shape, &holed).map_err(kerr)?;
    ensure(fp["radius_group"] == json!(1), "a lone hole rim is group 1")?;
    let got = r()
        .edges(&holed, &json!({"kind": "edge", "by": "match", "fp": fp}))
        .map_err(kerr)?;
    ensure(
        got.len() == 1 && close(radius_of(&got, 0)?, 5.0, 0.05),
        "group 1 rim resolves by radius",
    )?;

    let got = r()
        .faces(&boxed, &json!({"kind": "face", "by": "match", "fp": face_fingerprint(&top.shape).map_err(kerr)?}))
        .map_err(kerr)?;
    ensure(
        got.len() == 1
            && close(
                FaceEnt::new(got[0].clone()).map_err(kerr)?.centroid().z,
                5.0,
                1e-3,
            ),
        "face match picks the top face",
    )?;

    let seed = ents_edges(&boxed)?
        .into_iter()
        .find(|e| e.curve_name() == "line")
        .ok_or("no line edge")?;
    let fp = edge_fingerprint_with(tuning, &seed.shape, &boxed).map_err(kerr)?;
    let got = r()
        .edges(
            &boxed,
            &json!({"kind": "edge", "by": "tangentChain", "seed": fp}),
        )
        .map_err(kerr)?;
    ensure(got.len() == 1, "a box tangent chain is the seed alone")?;

    let mut diag = Vec::new();
    let bad = json!({"mid": [100, 100, 100], "dir": [1, 0, 0], "length": 999, "curve": "line"});
    let got = Resolver::new(Some(&mut diag), Some("f9"))
        .with_tuning(tuning)
        .edges(&boxed, &json!({"kind": "edge", "by": "match", "fp": bad}))
        .map_err(kerr)?;
    ensure(got.len() == 1, "a poor match still resolves")?;
    ensure(
        diag.first()
            .is_some_and(|d| d["lossy"] == json!(true) && d["feature_id"] == json!("f9")),
        "a poor match records a lossy diagnostic",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let out = aggregate(&[
            ("concentric", Outcome::Invalid),
            ("concentric", Outcome::Invalid),
        ]);
        assert!(approx(&out["v2_rate"], 0.0));
        assert!(approx(&out["concentric"], 0.0));
        assert_eq!(out["invalid_count"], json!(2.0));
    }

    #[test]
    fn rounding_six_places_and_the_extremes() {
        use Outcome::*;
        let out = aggregate(&[
            ("concentric", Survive),
            ("concentric", Miss),
            ("concentric", Miss),
        ]);
        assert!(approx(&out["concentric"], 0.333333));
        assert!(approx(&out["v2_rate"], 0.333333));
        assert!(approx(
            &aggregate(&[("moved_sketch", Survive)])["v2_rate"],
            1.0
        ));
        assert!(approx(
            &aggregate(&[("moved_sketch", Miss)])["v2_rate"],
            0.0
        ));
    }
}
