use super::*;

use std::f64::consts::PI;

use super::host::types::{BooleanOp, BooleanOptions, Fuzzy};
use super::kernel_api as k;
use super::kernel_ext as kx;
use crate::kernel;

#[test]
fn a_pass_key_carries_minus_one_for_an_unknown_pass() {
    let specs = vec![json!({"pass": "nobody-has-this", "depth": 1})];
    let key = pass_cache_key(&specs).expect("a key");
    assert!(key.starts_with("{\"nobody-has-this\":-1}:"), "{key}");
    assert!(pass_cache_key(&[]).is_none());
}

/// The three sentences of `plugin_geometry.unregistered`, the middle one for a
/// plugin on disk whose manifest names no component for this engine.
#[test]
fn a_plugin_without_a_component_is_named() {
    let d = Declared {
        id: "Some.Plugin".into(),
        dir: std::env::temp_dir(),
        wasm: None,
        types: vec!["legacyThing".into()],
        exporters: vec![],
        generators: vec![],
        files_read: false,
    };
    let Loaded::Broken(why) = compile(&d) else {
        panic!("a manifest without a component is broken");
    };
    assert_eq!(
        missing_feature("legacyThing", Missing::Broken(d.id.clone(), why)),
        "this needs the \"Some.Plugin\" plugin, which is installed but would not load: its manifest names no geometryWasm, so the Rust engine has no geometry to run"
    );
    assert_eq!(missing_feature("x", Missing::Unknown), "unknown feature type: x");
    assert!(missing_feature("x", Missing::NotRegistered("P".into())).contains("is not installed"));
}

fn close(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * b.abs().max(1.0)
}

#[test]
fn a_helical_sweep_keeps_the_revolve_volume_and_climbs() {
    // A triangle of area 0.5 centred 10/3 + 5 off the axis: Pappus holds
    // whatever the pitch, the axial travel only shears the section.
    let tri = k::polygon_face(&[(5.0, 0.0, 0.0), (6.0, 0.0, 0.0), (5.0, 0.0, 1.0)]).unwrap();
    let r = 5.0 + 1.0 / 3.0;
    let one = kx::helical_sweep(&tri, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), 360.0, 2.0).unwrap();
    assert!(close(kernel::volume(&one), 0.5 * 2.0 * PI * r, 1e-4), "{}", kernel::volume(&one));
    let bb = kernel::bbox(&one).unwrap();
    assert!((bb[5] - 3.0).abs() < 1e-3 && bb[2].abs() < 1e-3, "{bb:?}");
    let down = kx::helical_sweep(&tri, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), 180.0, -2.0).unwrap();
    assert!(close(kernel::volume(&down), 0.5 * PI * r, 1e-4));
    assert!(kernel::bbox(&down).unwrap()[2] < -0.9);
    let on_axis = k::polygon_face(&[(-1.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)]).unwrap();
    assert!(kx::helical_sweep(&on_axis, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), 360.0, 2.0).is_err());
}

#[test]
fn a_boolean_with_options_cuts_and_cleans() {
    let b = k::make_box((0.0, 0.0, 0.0), (10.0, 10.0, 10.0)).unwrap();
    let c = k::make_cylinder((5.0, 5.0, -1.0), (0.0, 0.0, 1.0), 2.0, 12.0).unwrap();
    for (parallel, fuzzy) in [(true, Fuzzy::Exact), (false, Fuzzy::Picked), (false, Fuzzy::Value(1e-6))] {
        let out = kx::boolean_with(BooleanOp::Cut, &b, &[&c], &BooleanOptions { parallel, fuzzy, clean: true }).unwrap();
        assert!(close(kernel::volume(&out), 1000.0 - PI * 40.0, 1e-9));
        assert_eq!(k::kind(&out), host::types::ShapeKind::Solid, "a lone solid is unwrapped");
    }
    let raw = kx::boolean_with(
        BooleanOp::Fuse,
        &b,
        &[&k::make_box((10.0, 0.0, 0.0), (10.0, 10.0, 10.0)).unwrap()],
        &BooleanOptions { parallel: true, fuzzy: Fuzzy::Exact, clean: false },
    )
    .unwrap();
    let cleaned = kx::boolean_with(
        BooleanOp::Fuse,
        &b,
        &[&k::make_box((10.0, 0.0, 0.0), (10.0, 10.0, 10.0)).unwrap()],
        &BooleanOptions { parallel: true, fuzzy: Fuzzy::Exact, clean: true },
    )
    .unwrap();
    assert!(k::items(&raw, k::Items::Faces).len() > k::items(&cleaned, k::Items::Faces).len());
    assert_eq!(k::items(&cleaned, k::Items::Faces).len(), 6);
    assert!(kx::boolean_with(BooleanOp::Cut, &b, &[], &BooleanOptions { parallel: true, fuzzy: Fuzzy::Exact, clean: true }).is_err());
}

#[test]
fn edges_wires_and_a_rotation() {
    let arc = kx::arc_edge((-2.0, 0.0, 0.0), (0.0, 2.0, 0.0), (2.0, 0.0, 0.0)).unwrap();
    let line = kx::line_edge((2.0, 0.0, 0.0), (-2.0, 0.0, 0.0)).unwrap();
    let wire = kx::wire_from_edges(&[&arc, &line]).unwrap();
    let half = k::face_from_wire(&wire).unwrap();
    assert!(close(kernel::area(&half), PI * 2.0, 1e-9));
    let circle = kx::circle_edge((1.0, 1.0, 0.0), (0.0, 0.0, 1.0), 3.0).unwrap();
    let disc = k::face_from_wire(&kx::wire_from_edges(&[&circle]).unwrap()).unwrap();
    assert!(close(kernel::area(&disc), PI * 9.0, 1e-9));
    assert!(kx::circle_edge((0.0, 0.0, 0.0), (0.0, 0.0, 1.0), 0.0).is_err());
    assert!(kx::wire_from_edges(&[]).is_err());

    let b = k::make_box((0.0, 0.0, 0.0), (4.0, 2.0, 1.0)).unwrap();
    let turned = kx::rotate(&b, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), 90.0).unwrap();
    let bb = kernel::bbox(&turned).unwrap();
    assert!((bb[0] + 2.0).abs() < 1e-6 && (bb[4] - 4.0).abs() < 1e-6, "{bb:?}");
}

#[test]
fn a_face_reads_its_surface_and_stored_triangulation() {
    let cyl = k::make_cylinder((0.0, 0.0, 0.0), (0.0, 0.0, 1.0), 3.0, 5.0).unwrap();
    let faces = k::items(&cyl, k::Items::Faces);
    let side = faces
        .iter()
        .find(|f| kx::surface_frame(f).is_some_and(|s| s.kind == "cylinder"))
        .expect("a cylindrical face");
    let frame = kx::surface_frame(side).unwrap();
    assert!((frame.radius - 3.0).abs() < 1e-12 && (frame.z_dir.2 - 1.0).abs() < 1e-12);
    assert!((frame.u_last - frame.u_first - 2.0 * PI).abs() < 1e-9);
    let s = kx::surface_samples(side, &[0.0, 2.0, PI / 2.0, 1.0], 1e-6);
    assert_eq!(s.len(), 2);
    assert!((s[0].point.0 - 3.0).abs() < 1e-12 && (s[0].point.2 - 2.0).abs() < 1e-12);
    let n = s[1].normal.expect("a defined normal");
    assert!((n.1.abs() - 1.0).abs() < 1e-12);

    assert!(kx::triangulation(side).is_none(), "not meshed yet");
    let access = opencascade::mesh_access::MeshAccess::new(&cyl);
    crate::mesh::tessellate(
        &cyl,
        &access,
        crate::mesh::MeshParams { linear: 0.1, angular: 0.5, relative: false, display: false, force_remesh: false },
    );
    let t = kx::triangulation(side).expect("meshed now");
    assert_eq!(t.uvs.len() / 2, t.positions.len() / 3);
    assert!(t.indices.iter().all(|&i| (i as usize) < t.positions.len() / 3));
    for (p, uv) in t.positions.chunks_exact(3).zip(t.uvs.chunks_exact(2)) {
        assert!((p[0] - 3.0 * uv[0].cos()).abs() < 1e-9 && (p[2] - uv[1]).abs() < 1e-9);
    }
    assert!(!kx::is_reversed(&cyl));
}

#[test]
fn face_selectors_resolve_against_a_shape() {
    let b = k::make_box((0.0, 0.0, 0.0), (10.0, 10.0, 10.0)).unwrap();
    assert_eq!(kx::select_faces(&b, r#"{"by": "all"}"#).ok().map(|v| v.len()), Some(6));
    let top = kx::select_faces(&b, r#"{"kind": "face", "by": "nearest", "point": [5, 5, 10]}"#)
        .ok()
        .expect("the top face");
    assert_eq!(top.len(), 1);
    assert!(kx::select_faces(&b, "not json").is_err());
}

#[test]
fn os_errors_read_as_python_prints_them() {
    assert_eq!(host::py_repr("C:\\x\\it's"), "\"C:\\\\x\\\\it's\"");
    assert_eq!(host::py_repr("a'b\"c"), "'a\\'b\"c'");
}
