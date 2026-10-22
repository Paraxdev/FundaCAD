use fundacad_geom::cache::meshes::*;
use fundacad_geom::mesh;

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
