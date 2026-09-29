//! A sketch corner snapped to a model vertex arrives a few 1e-5 mm off it. The
//! imprint must land on that vertex rather than leave an edge that short, which
//! no fillet can take and which the viewport cannot show.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

#[test]
fn a_line_ending_just_off_a_corner_divides_the_face_at_that_corner() {
    let square = [[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]];
    let outline: Vec<Value> = (0..4).map(|i| line(&format!("s{i}"), square[i], square[(i + 1) % 4])).collect();
    let raw = json!({"parameters": {}, "features": [
        {"id": "sk", "type": "sketch", "plane": "XY", "entities": outline},
        {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 10, "operation": "new"},
        {"id": "cut", "type": "sketch",
         "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": [line("d", [0.0, 1.1e-5], [20.0, 20.0])]},
        {"id": "im", "type": "imprint", "sketch": "cut"},
    ]});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let shape = &r.bodies[0].shape;
    assert_eq!(kernel::count(shape, Kind::Face), 7, "the top face is divided in two");
    let shortest = kernel::subshapes(shape, Kind::Edge)
        .iter()
        .map(kernel::length)
        .fold(f64::INFINITY, f64::min);
    assert!(shortest > 1.0, "the shortest edge is {shortest}mm");
}
