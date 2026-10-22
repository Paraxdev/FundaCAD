use fundacad_geom::printcheck::*;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// A closed box's positions, indices and face ids, two triangles a
/// side, each side its own face.
type Raw = (Vec<f32>, Vec<u32>, Vec<u32>);

fn box_raw(lo: [f64; 3], hi: [f64; 3]) -> Raw {
    let c = |i: usize| -> [f64; 3] {
        [
            if i & 1 == 0 { lo[0] } else { hi[0] },
            if i & 2 == 0 { lo[1] } else { hi[1] },
            if i & 4 == 0 { lo[2] } else { hi[2] },
        ]
    };
    // Outward-wound quads: -X, +X, -Y, +Y, -Z, +Z.
    let quads = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    let mut face_ids = Vec::new();
    for (f, q) in quads.iter().enumerate() {
        let base = (positions.len() / 3) as u32;
        for &i in q {
            positions.extend(c(i).iter().map(|&x| x as f32));
        }
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        face_ids.extend([f as u32, f as u32]);
    }
    (positions, indices, face_ids)
}

fn box_body(id: &str, lo: [f64; 3], hi: [f64; 3]) -> Body {
    let (positions, indices, face_ids) = box_raw(lo, hi);
    Body::new(&Mesh { id, name: "", positions: &positions, indices: &indices, face_ids: &face_ids }, [0.0, 0.0, 1.0])
}

fn defaults() -> Settings {
    settings_of(&Map::new()).unwrap()
}

#[test]
fn settings_refuse_values_they_cannot_use() {
    let m = |v: Value| v.as_object().cloned().unwrap();
    assert!(settings_of(&m(json!({"nozzle": -1}))).is_err());
    assert!(settings_of(&m(json!({"up": "+Z", "layFlat": true}))).is_err());
    assert!(settings_of(&m(json!({"checks": ["walls"]}))).is_err());
    let s = settings_of(&m(json!({"up": "-y", "checks": ["gap"]}))).unwrap();
    assert_eq!(s.up.1, "-Y");
    assert!(s.checks.gap && !s.checks.wall);
}

#[test]
fn a_box_on_the_bed_is_fine() {
    let b = box_body("body1", [0.0; 3], [20.0, 20.0, 10.0]);
    let f = run(&[b], &defaults(), true, &HashMap::new(), &|| false);
    assert!(f.is_empty(), "{f:?}");
}

#[test]
fn a_thin_fin_is_one_perimeter_and_counted_once() {
    let b = box_body("body1", [0.0; 3], [0.6, 20.0, 10.0]);
    let f = run(&[b], &defaults(), true, &HashMap::new(), &|| false);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].kind, Kind::Wall);
    assert!((f[0].value - 0.6).abs() < 1e-6 && (f[0].area - 200.0).abs() < 1e-6, "{f:?}");
}

#[test]
fn two_boxes_a_tenth_apart_print_fused_unless_laid_apart() {
    let a = box_body("body1", [0.0; 3], [10.0; 3]);
    let b = box_body("body2", [10.1, 0.0, 0.0], [20.1, 10.0, 10.0]);
    let f = run(&[a, b], &defaults(), true, &HashMap::new(), &|| false);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!(f[0].kind, Kind::Fused);
    assert!((f[0].value - 0.1).abs() < 1e-5, "{f:?}");
    let a = box_body("body1", [0.0; 3], [10.0; 3]);
    let b = box_body("body2", [10.1, 0.0, 0.0], [20.1, 10.0, 10.0]);
    assert!(run(&[a, b], &defaults(), false, &HashMap::new(), &|| false).is_empty());
}

#[test]
fn a_mesh_hole_names_its_lowest_face_every_time() {
    // A box without its top: the four side faces each keep an open edge.
    let (positions, indices, face_ids) = box_raw([0.0; 3], [20.0, 20.0, 10.0]);
    let mesh =
        Mesh { id: "body1", name: "", positions: &positions, indices: &indices[..30], face_ids: &face_ids[..10] };
    for _ in 0..20 {
        let b = Body::new(&mesh, [0.0, 0.0, 1.0]);
        let f = run(&[b], &defaults(), true, &HashMap::new(), &|| false);
        let holes: Vec<&Finding> = f.iter().filter(|f| f.kind == Kind::MeshHole).collect();
        assert_eq!(holes.len(), 1, "{f:?}");
        assert_eq!((holes[0].face, holes[0].value), (0, 4.0));
    }
}

#[test]
fn a_triangle_without_area_left_in_the_mesh_is_a_finding() {
    // The last three triangles: two corners at one point (index 0 twice,
    // then two nodes at one place), and three corners on one line.
    let (mut positions, mut indices, mut face_ids) = box_raw([0.0; 3], [20.0, 20.0, 10.0]);
    let whole = Mesh { id: "body1", name: "", positions: &positions, indices: &indices, face_ids: &face_ids };
    let f = run(&[Body::new(&whole, [0.0, 0.0, 1.0])], &defaults(), true, &HashMap::new(), &|| false);
    assert!(f.iter().all(|f| f.kind != Kind::FlatTriangle), "{f:?}");

    let n = (positions.len() / 3) as u32;
    positions.extend_from_slice(&[0.0, 0.0, 0.0, 5.0, 5.0, 2.0, 5.0, 5.0, 2.0, 10.0, 10.0, 4.0]);
    indices.extend_from_slice(&[0, 0, n, n + 1, n + 2, n, n, n + 1, n + 3]);
    face_ids.extend_from_slice(&[4, 3, 5]);
    let mesh = Mesh { id: "body1", name: "", positions: &positions, indices: &indices, face_ids: &face_ids };
    let bodies = [Body::new(&mesh, [0.0, 0.0, 1.0])];
    let f = run(&bodies, &defaults(), true, &HashMap::new(), &|| false);
    let flat: Vec<&Finding> = f.iter().filter(|f| f.kind == Kind::FlatTriangle).collect();
    assert_eq!(flat.len(), 1, "{f:?}");
    assert_eq!((flat[0].face, flat[0].value), (3, 3.0));
    let text = report(&bodies, &f, &defaults(), "as modelled", &HashMap::new());
    assert!(text.contains("3 triangles without area near F3"), "{text}");
}

#[test]
fn a_box_in_the_air_has_its_bottom_as_an_overhang_but_not_on_the_bed() {
    // Two boxes as one print: the high one's bottom hangs over nothing.
    let low = box_body("body1", [0.0; 3], [5.0; 3]);
    let mut high = box_body("body2", [20.0, 0.0, 10.0], [30.0, 10.0, 12.0]);
    high.bed = 0.0;
    let f = run(&[low, high], &defaults(), true, &HashMap::new(), &|| false);
    assert_eq!(f.len(), 1, "{f:?}");
    assert_eq!((f[0].kind, f[0].body, f[0].face), (Kind::Overhang, 1, 4));
    assert_eq!(f[0].value, 90.0);
    assert_eq!(f[0].low, 10.0);
}
