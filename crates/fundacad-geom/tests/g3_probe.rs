//! Research probe for G3 fillets (backlog nvc2hn0h), not a product test.
//! Builds G1 and G2 fillets through the real builder and writes each body as a
//! BREP text file for `g3_probe/measure.py`, which measures the curvature and
//! its rate across the contact lines and builds the G3 candidates beside them.
//! Run with FUNDACAD_DISK_CACHE=0 and FUNDACAD_G3_PROBE_OUT=<dir>:
//! cargo test -p fundacad-geom --test g3_probe -- --ignored --nocapture

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::kernel;
use serde_json::{json, Value};
use std::time::Instant;

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

/// A triangle prism, 40 high, whose vertical edge at the origin joins two planes at `angle` degrees.
fn wedge(angle: f64) -> Vec<Value> {
    let t = angle.to_radians();
    let c = [-50.0 * t.cos(), -50.0 * t.sin()];
    vec![line("l0", [0.0, 0.0], [-50.0, 0.0]), line("l1", [-50.0, 0.0], c), line("l2", c, [0.0, 0.0])]
}

/// A circle segment prism: chord y = 0 from (-30, 0) to (0, 0), arc through (-15, -12). Its vertical
/// edge at the origin joins a plane and a cylinder (radius 15.37, axis vertical) at about 77 degrees,
/// and its top arc edge joins the top plane and that cylinder.
fn segment() -> Vec<Value> {
    vec![
        line("l0", [-30.0, 0.0], [0.0, 0.0]),
        json!({"type": "arc", "id": "a0", "x1": 0.0, "y1": 0.0, "x2": -30.0, "y2": 0.0, "mx": -15.0, "my": -12.0}),
    ]
}

fn build(name: &str, entities: Vec<Value>, edge: [f64; 3], radius: f64, g2: bool) {
    build_edges(name, entities, &[edge], radius, g2);
}

fn build_edges(name: &str, entities: Vec<Value>, edges: &[[f64; 3]], radius: f64, g2: bool) {
    let picks: Vec<Value> = edges.iter().map(|p| json!({"kind": "edge", "by": "nearest", "point": p})).collect();
    let mut fillet = json!({"id": "f", "type": "fillet", "radius": radius, "edges": picks});
    if g2 {
        fillet["continuity"] = json!("G2");
    }
    let doc = json!({"features": [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": entities},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 40, "operation": "new"},
        fillet,
    ]});
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    let t = Instant::now();
    let r = builder::rebuild(&typed, &doc, &NoWatch).expect("not cancelled");
    let ms = t.elapsed().as_millis();
    let tag = format!("{name}_{}", if g2 { "g2" } else { "g1" });
    if let Some(e) = r.errors.first() {
        println!("PROBE {tag} refused: {}", e.message);
        return;
    }
    let s = &r.bodies[0].shape;
    println!("PROBE {tag} volume {:.4} ms {ms}", kernel::volume(s));
    if let Ok(dir) = std::env::var("FUNDACAD_G3_PROBE_OUT") {
        s.write_brep_text(format!("{dir}/{tag}.brep")).expect("brep written");
    }
}

#[test]
#[ignore = "research probe, writes BREP files for measure.py"]
fn g3_probe_bodies() {
    for angle in [90.0, 120.0, 60.0] {
        for g2 in [false, true] {
            build(&format!("wedge{angle}"), wedge(angle), [0.0, 0.0, 20.0], 10.0, g2);
        }
    }
    for g2 in [false, true] {
        build("plane_cyl_arc", segment(), [-15.0, -11.9, 40.0], 3.0, g2);
        let square = vec![json!({"type": "rectangle", "width": 50, "height": 50, "x": 0, "y": 0})];
        let corner = [[0.0, 25.0, 40.0], [-25.0, 0.0, 40.0], [-25.0, 25.0, 20.0]];
        build_edges("corner3", square, &corner, 10.0, g2);
        for r in [1.0, 2.0, 3.0] {
            build(&format!("plane_cyl_line_r{r}"), segment(), [0.0, 0.0, 20.0], r, g2);
        }
    }
}
