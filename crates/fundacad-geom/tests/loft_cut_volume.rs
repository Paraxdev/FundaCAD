//! The quick volume integration misses by about a percent on a loft between
//! closed spline sections, so a pin bored into one looked like a cut that grew
//! the body and was refused as impossible.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Value};

const BASE: [[f64; 2]; 24] = [
    [47.500, 0.000], [45.640, 13.163], [40.205, 25.295], [31.621, 35.446], [20.560, 42.820], [7.889, 46.840],
    [-5.400, 47.192], [-18.266, 43.847], [-29.702, 37.068], [-39.872, 28.440], [-50.029, 19.795], [-60.185, 11.150],
    [-66.500, 0.000], [-60.185, -11.150], [-50.029, -19.795], [-39.872, -28.440], [-29.702, -37.068], [-18.266, -43.847],
    [-5.400, -47.192], [7.889, -46.840], [20.560, -42.820], [31.621, -35.446], [40.205, -25.295], [45.640, -13.163],
];
const RIM: [[f64; 2]; 24] = [
    [50.000, 0.000], [48.055, 13.810], [42.371, 26.546], [33.391, 37.216], [21.813, 44.991], [8.538, 49.266],
    [-5.402, 49.707], [-18.921, 46.282], [-30.968, 39.256], [-41.645, 30.213], [-52.300, 21.144], [-62.955, 12.076],
    [-69.000, 0.000], [-62.955, -12.076], [-52.300, -21.144], [-41.645, -30.213], [-30.968, -39.256], [-18.921, -46.282],
    [-5.402, -49.707], [8.538, -49.266], [21.813, -44.991], [33.391, -37.216], [42.371, -26.546], [48.055, -13.810],
];

fn section(id: &str, z: f64, poles: &[[f64; 2]]) -> Value {
    let poles: Vec<Value> = poles.iter().map(|p| json!({"x": p[0], "y": p[1]})).collect();
    json!({"id": id, "type": "sketch", "plane": {"origin": [0, 0, z], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
           "entities": [{"type": "bspline", "id": "c", "closed": true, "degree": 3, "poles": poles}]})
}

#[test]
fn a_bore_into_a_lofted_spline_tray_is_cut_not_refused() {
    let raw = json!({"parameters": {}, "features": [
        section("base", 0.0, &BASE),
        section("rim", 34.0, &RIM),
        {"id": "tray", "type": "loft", "sketches": ["base", "rim"], "operation": "new"},
        {"id": "pin_sk", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "p", "radius": 1.1, "x": 0, "y": 0}]},
        {"id": "pin", "type": "extrude", "sketch": "pin_sk", "distance": 25, "operation": "cut"},
    ]});
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    assert_eq!(kernel::count(&r.bodies[0].shape, Kind::Face), 5, "the side, both caps, the bore wall and its end");
}
