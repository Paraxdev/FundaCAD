//! A cup whose outer rim is already rounded, its inner rim filleted past the
//! wall: the fillet is one revolved face that carves the rim, not a band of
//! lofted sections that cuts the wall in two and takes half a minute.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel::{self, BoolKind, Kind};
use fundacad_geom::mesh::edges::edge_polylines;
use opencascade::mesh_access::MeshAccess;
use serde_json::{json, Value};

const R: f64 = 30.0;
const H: f64 = 30.0;
const OUTER: f64 = 5.0;
const INNER: f64 = 11.05;

fn cup(inner_fillet: Option<f64>) -> Value {
    let mut features = vec![
        json!({"id": "sk", "type": "sketch", "plane": "XY", "entities": [
            {"type": "circle", "id": "c", "x": 0, "y": 0, "radius": R}]}),
        json!({"id": "ex", "type": "extrude", "sketch": "sk", "distance": H, "operation": "new"}),
        json!({"id": "fi", "type": "fillet", "radius": OUTER,
               "edges": [{"kind": "edge", "by": "nearest", "point": [R, 0, H]}]}),
        json!({"id": "pp1", "type": "press-pull", "distance": -20,
               "face": {"kind": "face", "by": "nearest", "point": [0, 0, H]}}),
        json!({"id": "pp2", "type": "press-pull", "distance": -4.1,
               "face": {"kind": "face", "by": "nearest", "point": [0, 0, H - 20.0]}}),
    ];
    if let Some(r) = inner_fillet {
        features.push(json!({"id": "rim", "type": "fillet", "radius": r,
            "edges": [{"kind": "edge", "by": "nearest", "point": [R - OUTER, 0, H]}]}));
    }
    json!({"parameters": {}, "features": features})
}

fn build(doc: &Value) -> (Rebuild, f64) {
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let t = std::time::Instant::now();
    let r = builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    (r, t.elapsed().as_secs_f64())
}

/// The rim's section is the arc of a ball resting on the wall and on the
/// rim's tangent plane, revolved: what is left is the base less the ring
/// outside that ball's torus.
fn carved(base: &opencascade::primitives::Shape, r: f64) -> f64 {
    let (x0, x1) = (R - OUTER - 0.1, R - OUTER + r);
    let ring = kernel::polygon_face(&[[x0, 0.0, H - r], [x1, 0.0, H - r], [x1, 0.0, H + 1.0], [x0, 0.0, H + 1.0]])
        .and_then(|f| kernel::revolve(&f, [0.0; 3], [0.0, 0.0, 1.0], 360.0))
        .expect("ring");
    let ball = kernel::translated(&kernel::make_torus(x1, r).expect("torus"), [0.0, 0.0, H - r]).expect("moved");
    let b = kernel::bbox(&ball).expect("box");
    assert!((b[2] - (H - 2.0 * r)).abs() < 1e-6 && (b[5] - H).abs() < 1e-6, "{b:?}");
    let tool = kernel::boolean_op(&ring, &[&ball], BoolKind::Cut).expect("tool");
    kernel::volume(&kernel::boolean_op(base, &[&tool], BoolKind::Cut).expect("carve"))
}

#[test]
fn a_rim_fillet_past_a_rounded_wall_is_one_face() {
    let (before, _) = build(&cup(None));
    let base = &before.bodies[0].shape;
    let (r, secs) = build(&cup(Some(INNER)));
    let out = &r.bodies[0].shape;

    assert!(
        !r.diagnostics.iter().any(|d| d["code"] == "bodySplit"),
        "{:?}",
        r.diagnostics
    );
    assert_eq!(kernel::count(out, Kind::Solid), 1);
    assert_eq!(
        kernel::count(out, Kind::Face),
        kernel::count(base, Kind::Face) + 1,
        "the fillet is one face"
    );
    let want = carved(base, INNER);
    let got = kernel::volume(out);
    assert!((got - want).abs() < 1e-3 * want, "volume {got}, the carved rim holds {want}");
    assert!(secs < 10.0, "took {secs} s");

    let access = MeshAccess::new(out);
    let wall_contact = edge_polylines(&access)
        .into_iter()
        .find(|e| {
            let p = e.points[e.points.len() / 2];
            ((p[0].hypot(p[1])) - (R - OUTER)).abs() < 1e-3 && (p[2] - (H - INNER)).abs() < 1e-3
        })
        .expect("an edge where the fillet meets the wall");
    assert!(wall_contact.smooth, "the fillet meets the wall tangentially");
}

/// Small enough for the kernel, the fillet is still the kernel's.
#[test]
fn a_rim_fillet_that_fits_stays_the_kernels() {
    let (before, _) = build(&cup(None));
    let (r, _) = build(&cup(Some(2.0)));
    let out = &r.bodies[0].shape;
    assert_eq!(kernel::count(out, Kind::Face), kernel::count(&before.bodies[0].shape, Kind::Face) + 1);
    let lost = kernel::volume(&before.bodies[0].shape) - kernel::volume(out);
    assert!(lost > 0.0 && lost < 400.0, "removed {lost}");
}
