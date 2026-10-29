use fundacad_geom::cache::meshes::*;
use fundacad_geom::mesh;
use fundacad_protocol::body::{Edge, FullBody};

#[test]
fn an_artifact_round_trips_and_junk_is_a_miss() {
    let sphere = fundacad_geom::kernel::make_sphere(4.0).unwrap();
    let full = mesh::strip_envelope(&mesh::body_payload(&sphere, "b", "B", 0.1, mesh::viewport_profile(1)));
    let bytes = encode(&full);
    let back = decode(&bytes).unwrap();
    assert_eq!(back, full);
    assert_eq!(mesh::etag(&back), mesh::etag(&full));
    assert!(decode(&bytes[..bytes.len() - 1]).is_none());
    assert!(decode(b"FCMESH01garbage").is_none());
    let key = artifact_key(&"ab".repeat(16), 0.1, mesh::viewport_profile(1));
    assert!(key.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'), "{key}");
}

#[test]
fn an_edge_keeps_its_curvature_per_mm_of_radius_and_of_chord() {
    let full = FullBody {
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        indices: vec![0, 1, 2],
        face_ids: vec![0],
        edges: vec![
            Edge { points: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], smooth: true, curvature: Some([0.1, 0.08]) },
            Edge { points: vec![[0.0, 1.0, 0.0], [0.0, 0.0, 0.0]], smooth: false, curvature: None },
        ],
        ..Default::default()
    };
    assert_eq!(decode(&encode(&full)), Some(full));
}
