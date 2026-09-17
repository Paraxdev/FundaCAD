//! FundaCAD geometry engine: the Rust replacement for the Python sidecar.
//!
//! This crate is the first brick of the Rust pivot (docs/RUST-PIVOT.md). It
//! links OpenCASCADE statically through the vendored `opencascade` bindings and
//! exposes the pieces the app consumes: a solid built from the document, a
//! viewport mesh in the wire format the frontend already speaks
//! (docs/PROTOCOL.md, protocol v2 body payload), measurements, and export.
//!
//! What is here today is deliberately small and fully tested: measurement and
//! tessellation over shapes the bindings can already build. The feature
//! builder that replays a `.funda` document lands module by module, each one
//! moving a sidecar `*.py` file across; the conversion targets are listed in
//! the plan.

pub mod builder;
pub mod export;
pub mod features;
pub mod import;
pub mod jobs;
pub mod kernel;
pub mod measure;
pub mod mesh;
pub mod reply;
pub mod select;
pub mod text;

pub use opencascade;

/// The OpenCASCADE version this engine links, as "major.minor.patch".
///
/// The static kernel comes from the `occt-sys` crate the bindings pull in, so
/// this is a build-time constant rather than a runtime lookup; it is the one
/// number to quote in a bug report about the Rust geometry path.
pub const OCCT_VERSION: &str = "7.8.1";

#[cfg(test)]
mod tests {
    use super::*;
    use glam::dvec3;
    use opencascade::primitives::Shape;

    /// A 20 x 20 x 10 box, the same part the spike's tests and the sidecar's
    /// smallest fixtures use.
    fn box_20_20_10() -> Shape {
        Shape::box_with_dimensions(20.0, 20.0, 10.0)
    }

    #[test]
    fn kernel_links_and_measures_a_box() {
        let b = box_20_20_10();
        assert!((measure::volume(&b) - 4000.0).abs() < 1e-6);
        // 2 * (20*20 + 20*10 + 20*10) = 1600
        assert!((measure::surface_area(&b) - 1600.0).abs() < 1e-6);
        let bb = measure::bbox(&b).expect("a box has a bounding box");
        assert!(bb.max[2] - bb.min[2] > 9.9 && bb.max[2] - bb.min[2] < 10.2);
    }

    #[test]
    fn boolean_cut_removes_the_cylinder_volume() {
        let b = box_20_20_10();
        // A through-hole of radius 3 down Z, centred on the box.
        let hole = Shape::cylinder(dvec3(10.0, 10.0, -1.0), 3.0, dvec3(0.0, 0.0, 1.0), 12.0);
        let cut = b.subtract(&hole);
        let expected = 4000.0 - std::f64::consts::PI * 9.0 * 10.0;
        let got = measure::volume(&cut);
        assert!((got - expected).abs() < 1e-3, "volume {got} vs {expected}");
        // Six planar faces plus the cylindrical wall.
        assert_eq!(cut.faces().count(), 7);
    }

    #[test]
    fn tessellation_matches_the_wire_format() {
        let b = box_20_20_10();
        let m = mesh::body_payload(&b, "b1", "Body1", 0.1, mesh::viewport_profile(1));
        assert_eq!(m.positions.len() % 3, 0);
        assert_eq!(m.indices.len() % 3, 0);
        assert_eq!(
            m.face_ids.len(),
            m.indices.len() / 3,
            "one face id per triangle"
        );
        assert_eq!(m.fields["faceCount"], 6);
        let mut seen: Vec<u32> = m.face_ids.clone();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen, vec![0, 1, 2, 3, 4, 5]);
        // A straight edge is its two endpoints.
        assert_eq!(m.edges.len(), 12);
        assert!(m.edges.iter().all(|e| e.points.len() == 2 && !e.smooth));
        let bb = &m.fields["bbox"];
        assert_eq!(bb["min"][0], 0.0);
        assert_eq!(bb["max"][0], 20.0);
        let n = (m.positions.len() / 3) as u32;
        assert!(m.indices.iter().all(|&i| i < n));
        let normals = m.normals.as_ref().expect("full quality carries normals");
        assert_eq!(normals.len(), m.positions.len());
        let keys: Vec<&str> = m.fields.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "id",
                "name",
                "etag",
                "positions",
                "indices",
                "faceIds",
                "faceOwners",
                "edges",
                "faceCount",
                "bbox",
                "normals"
            ]
        );
        assert_eq!(
            m.fields["faceOwners"],
            serde_json::json!([null, null, null, null, null, null])
        );
        let json = m.to_json();
        assert!(json.get("faceIds").is_some() && json.get("normals").is_some());
    }

    #[test]
    fn coarse_profile_leaves_normals_out() {
        let b = box_20_20_10();
        let m = mesh::body_payload(&b, "b1", "Body1", 0.1, mesh::viewport_profile(1200));
        assert!(m.normals.is_none());
        assert!(!m.fields.contains_key("normals"));
    }

    #[test]
    fn etag_is_stable_and_stubs_a_known_body() {
        let a = box_20_20_10();
        let c = Shape::sphere(5.0).build();
        let bodies = [
            mesh::MeshBody {
                id: "a".into(),
                name: "A".into(),
                shape: Some(&a),
                node_ref: Some(serde_json::json!("n1")),
                ..Default::default()
            },
            mesh::MeshBody {
                id: "c".into(),
                name: "C".into(),
                shape: Some(&c),
                ..Default::default()
            },
            mesh::MeshBody {
                id: "empty".into(),
                name: "Empty".into(),
                ..Default::default()
            },
        ];
        let first = mesh::mesh_result(&bodies, 0.1, &serde_json::Map::new());
        assert_eq!(first.bodies.len(), 2);
        let tag = first.bodies[0].fields()["etag"].clone();
        assert_eq!(tag.as_str().map(str::len), Some(32));
        assert_eq!(
            first.fields.keys().collect::<Vec<_>>(),
            ["protocol", "bodies", "bbox"]
        );
        let min_x = first.fields["bbox"]["min"][0].as_f64().unwrap();
        assert!((min_x + 5.0).abs() < 1e-2, "{min_x}");
        assert_eq!(first.fields["bbox"]["max"][0], 20.0);

        let mut known = serde_json::Map::new();
        known.insert("a".into(), tag.clone());
        let second = mesh::mesh_result(&bodies, 0.1, &known);
        match &second.bodies[0] {
            fundacad_protocol::WireBody::Stub(m) => {
                assert_eq!(m["etag"], tag);
                assert_eq!(
                    m.keys().collect::<Vec<_>>(),
                    ["id", "name", "etag", "nodeRef", "unchanged"]
                );
            }
            other => panic!("expected a stub, got {other:?}"),
        }
        assert!(matches!(
            second.bodies[1],
            fundacad_protocol::WireBody::Full(_)
        ));
        // A content etag: the sphere meshed finer is a new payload, while a box
        // at any tolerance is the same twelve triangles and stays a stub.
        known.insert("c".into(), first.bodies[1].fields()["etag"].clone());
        let finer = mesh::mesh_result(&bodies, 0.05, &known);
        assert!(matches!(
            finer.bodies[0],
            fundacad_protocol::WireBody::Stub(_)
        ));
        assert!(matches!(
            finer.bodies[1],
            fundacad_protocol::WireBody::Full(_)
        ));
    }
}
