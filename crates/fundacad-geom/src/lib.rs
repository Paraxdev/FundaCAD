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

pub mod measure;
pub mod mesh;

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
        let m = mesh::tessellate(&b, 0.1).expect("box tessellates");
        assert_eq!(m.positions.len() % 3, 0);
        assert_eq!(m.indices.len() % 3, 0);
        assert_eq!(
            m.face_ids.len(),
            m.indices.len() / 3,
            "one face id per triangle"
        );
        assert_eq!(m.face_count, 6);
        let mut seen: Vec<u32> = m.face_ids.clone();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen, vec![0, 1, 2, 3, 4, 5]);
        // Twelve edges, every polyline has at least two points.
        assert_eq!(m.edges.len(), 12);
        assert!(m.edges.iter().all(|e| e.points.len() >= 2));
        let bb = m.bbox.expect("bbox");
        assert!(bb.min[0] <= 0.0 + 1e-6 && bb.max[0] >= 20.0 - 1e-6);
        // Every index addresses a vertex that exists.
        let n = (m.positions.len() / 3) as u32;
        assert!(m.indices.iter().all(|&i| i < n));
        // Serialises with the camelCase names the frontend reads.
        let json = serde_json::to_value(&m).unwrap();
        assert!(json.get("faceIds").is_some() && json.get("faceCount").is_some());
    }
}
