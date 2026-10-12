//! A cut whose corner lands a few 1e-5 mm beside the seam of a revolved tube
//! leaves edges that short between the seam and the corner. The kernel's
//! mesher folds such an edge into one node on the cylinder and keeps its
//! points on the flat wall beside it, so the two faces must be brought to the
//! same nodes or the viewport, an STL and the printability check all get a
//! mesh with holes.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch};
use fundacad_geom::export;
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::mesh::{self, viewport_profile};
use fundacad_geom::printcheck::op::printability_result;
use fundacad_protocol::JobResult;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> Value {
    json!({"type": "line", "id": id, "x1": a[0], "y1": a[1], "x2": b[0], "y2": b[1]})
}

fn outline(points: [[f64; 2]; 4]) -> Vec<Value> {
    (0..4).map(|i| line(&format!("l{i}"), points[i], points[(i + 1) % 4])).collect()
}

/// A tube revolved about Z, its seam at azimuth 0, with a diamond cut through
/// the wall whose top and bottom corners sit `offset` mm beside the seam, the
/// whole part `s` times the size.
fn tube(offset: f64, patterned: bool, s: f64) -> Value {
    tube_cut_to(offset, patterned, s, 17.2)
}

/// `tube` with the top corner of the cut at height `top`, 30 is the rim.
fn tube_cut_to(offset: f64, patterned: bool, s: f64, top: f64) -> Value {
    let diamond = outline([
        [offset, (top - 7.2) * s],
        [3.6 * s + offset, (top - 3.6) * s],
        [offset, top * s],
        [-3.6 * s + offset, (top - 3.6) * s],
    ]);
    let mut features = vec![
        json!({"id": "tubeSk", "type": "sketch", "plane": "XZ",
               "entities": outline([[41.74 * s, 0.0], [43.74 * s, 0.0], [43.74 * s, 30.0 * s], [41.74 * s, 30.0 * s]])}),
        json!({"id": "tube", "type": "revolve", "sketch": "tubeSk", "axis": "Z", "angle": 360, "operation": "new"}),
    ];
    if patterned {
        // Drawn a quarter turn away, the pattern's second copy is the one at
        // the seam.
        features.push(json!({"id": "cutSk", "type": "sketch", "entities": diamond,
            "plane": {"origin": [0, -38.0 * s, 0], "normal": [0, -1, 0], "xdir": [1, 0, 0]}}));
        features.push(json!({"id": "cut", "type": "extrude", "sketch": "cutSk", "distance": 9.0 * s, "operation": "cut"}));
        features.push(json!({"id": "pat", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z",
            "features": ["cut"]}));
    } else {
        features.push(json!({"id": "cutSk", "type": "sketch", "entities": diamond,
            "plane": {"origin": [38.0 * s, 0, 0], "normal": [1, 0, 0], "xdir": [0, 1, 0]}}));
        features.push(json!({"id": "cut", "type": "extrude", "sketch": "cutSk", "distance": 9.0 * s, "operation": "cut"}));
    }
    json!({"parameters": {}, "features": features})
}

/// Triangle sides not met exactly twice, corners joined by exact position.
fn unpaired_sides<T: Copy + Into<f64>>(positions: &[T], indices: &[u32]) -> usize {
    let (once, crowded) = side_tally(positions, indices);
    once + crowded
}

/// Triangle sides met once, and met more than twice.
fn side_tally<T: Copy + Into<f64>>(positions: &[T], indices: &[u32]) -> (usize, usize) {
    let mut ids: HashMap<[u64; 3], u32> = HashMap::new();
    let node: Vec<u32> = positions
        .chunks_exact(3)
        .map(|c| {
            let key = [0, 1, 2].map(|k| (c[k].into() + 0.0).to_bits());
            let next = ids.len() as u32;
            *ids.entry(key).or_insert(next)
        })
        .collect();
    let mut sides: HashMap<(u32, u32), u32> = HashMap::new();
    for t in indices.chunks_exact(3) {
        let c = [node[t[0] as usize], node[t[1] as usize], node[t[2] as usize]];
        if c[0] == c[1] || c[1] == c[2] || c[2] == c[0] {
            continue;
        }
        for k in 0..3 {
            let (a, b) = (c[k], c[(k + 1) % 3]);
            *sides.entry((a.min(b), a.max(b))).or_insert(0) += 1;
        }
    }
    let count = |pick: fn(u32) -> bool| sides.values().filter(|&&n| pick(n)).count();
    (count(|n| n == 1), count(|n| n > 2))
}

fn mesh_holes(doc: &Value) -> Vec<Value> {
    let mut req = Map::new();
    req.insert("document".into(), doc.clone());
    let JobResult::Json(r) = printability_result(&req, &NoWatch) else {
        panic!("expected a JSON result")
    };
    assert!(r.get("error").is_none(), "{r:?}");
    r["findings"].as_array().unwrap().iter().filter(|f| f["kind"] == "meshHole").cloned().collect()
}

fn assert_whole(label: &str, offset: f64, patterned: bool) {
    assert_whole_at(label, offset, patterned, 1.0);
}

fn assert_whole_at(label: &str, offset: f64, patterned: bool, s: f64) {
    assert_whole_doc(label, tube(offset, patterned, s));
}

fn assert_whole_doc(label: &str, raw: Value) {
    let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
    let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
    assert!(r.errors.is_empty(), "{label}: {:?}", r.errors);
    assert_eq!(r.bodies.len(), 1, "{label}");
    let shape = &r.bodies[0].shape;
    let faces = kernel::count(shape, Kind::Face);

    let view = mesh::body_payload(shape, "body1", "tube", 0.1, viewport_profile(1));
    let mut seen = vec![false; faces];
    for &f in &view.face_ids {
        seen[f as usize] = true;
    }
    let bare = seen.iter().filter(|s| !**s).count();
    let stl = export::export_mesh(shape, &export::mesh_options(None));
    let stl32: Vec<f32> = stl.0.iter().map(|&v| v as f32).collect();
    let got = (
        bare,
        unpaired_sides(&view.positions, &view.indices),
        unpaired_sides(&stl32, &stl.1),
        mesh_holes(&raw).len(),
    );
    assert_eq!(
        got,
        (0, 0, 0, 0),
        "{label}: (faces without triangles, open sides in the viewport mesh, open sides in the STL, printability mesh holes) of {faces} faces"
    );
}

#[test]
fn a_patterned_cut_with_a_corner_beside_the_seam_meshes_closed() {
    assert_whole("pattern, corner 1.9e-5 mm off the seam", 1.9e-5, true);
}

#[test]
fn a_cut_with_a_corner_beside_the_seam_meshes_closed() {
    assert_whole("direct cut, corner 1e-4 mm off the seam", 1e-4, false);
}

#[test]
fn a_cut_with_a_corner_on_the_seam_or_a_millionth_beside_it_meshes_closed() {
    assert_whole("pattern, corner on the seam", 0.0, true);
    assert_whole("pattern, corner 1e-6 mm off the seam", 1e-6, true);
    assert_whole("direct cut, corner on the seam", 0.0, false);
}

#[test]
fn a_body_is_still_valid_after_its_mesh_folded_a_short_edge() {
    // BRepCheck also holds every stored edge polygon to the deflection it
    // claims, so a fold the mesher left unrecorded turns the body invalid for
    // the features that check their input in a live session.
    for (label, raw) in [
        ("direct cut, corner 1e-4 mm off the seam", tube(1e-4, false, 1.0)),
        ("pattern, corner at the rim 1.9e-5 mm off the seam", tube_cut_to(1.9e-5, true, 1.0, 30.0)),
    ] {
        let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
        let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
        let shape = &r.bodies[0].shape;
        assert!(matches!(shape.is_valid(), Ok(true)), "{label}: before any mesh");
        mesh::body_payload(shape, "body1", "tube", 0.1, viewport_profile(1));
        assert!(matches!(shape.is_valid(), Ok(true)), "{label}: after the viewport mesh");
        export::export_mesh(shape, &export::mesh_options(None));
        assert!(matches!(shape.is_valid(), Ok(true)), "{label}: after the export mesh");
    }
}

#[test]
fn a_cut_with_a_corner_at_the_rim_beside_the_seam_meshes_closed() {
    // The corner leaves a triangle of the wall between the seam, the rim and
    // the cut, as wide as the corner is off the seam. The mesher gives a face
    // that small no triangles, or one where its outline needs five. The cut
    // also meets the rim along one radial line, a side the top face and both
    // walls of the cut share: that one belongs to the model and is no hole.
    for (patterned, offset, cuts) in
        [(false, 1e-4, 1), (false, -1e-4, 1), (true, 1.9e-5, 4), (true, 1e-4, 4), (true, -1e-4, 4)]
    {
        let raw = tube_cut_to(offset, patterned, 1.0, 30.0);
        let doc: CadDocument = serde_json::from_value(raw.clone()).expect("a document");
        let r = builder::rebuild(&doc, &raw, &NoWatch).expect("not cancelled");
        assert!(r.errors.is_empty(), "{:?}", r.errors);
        let shape = &r.bodies[0].shape;
        let view = mesh::body_payload(shape, "body1", "tube", 0.1, viewport_profile(1));
        let stl = export::export_mesh(shape, &export::mesh_options(None));
        let stl32: Vec<f32> = stl.0.iter().map(|&v| v as f32).collect();
        let got = (side_tally(&view.positions, &view.indices), side_tally(&stl32, &stl.1), mesh_holes(&raw).len());
        assert_eq!(
            got,
            ((0, cuts), (0, cuts), 0),
            "patterned {patterned}, corner {offset} mm off the seam: (sides met once, met more than twice) in the viewport mesh and in the STL, printability mesh holes"
        );
    }
}

#[test]
fn a_part_a_few_mm_across_with_a_corner_beside_the_seam_meshes_closed() {
    // At this size the short edge comes near the viewport's 1e-6 weld, which
    // must find the faces already joined.
    assert_whole_at("pattern at 1/20, corner 9.5e-7 mm off the seam", 9.5e-7, true, 0.05);
}
