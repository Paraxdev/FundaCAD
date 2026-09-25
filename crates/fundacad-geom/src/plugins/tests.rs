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

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("fundacad-plugins-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn put_manifest(root: &Path, id: &str, man: Value) {
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), man.to_string()).unwrap();
}

/// A bundle built for the retired Python engine: it declares
/// what it owns and names no component. It owns those names all the same, so
/// every sentence names the plugin and says an update fixes it.
#[test]
fn a_plugin_without_a_component_owns_its_names() {
    let root = temp_root("owner");
    put_manifest(
        &root,
        "Some.Plugin",
        json!({"id": "Some.Plugin", "version": "1.0.0", "geometry": "geometry/register.py",
               "featureTypes": ["legacyThing"], "shapeGenerators": ["widget"], "exporters": ["legacy-3mf"]}),
    );
    let mut reg = Registry::default();
    reg.replace(discover_in(std::slice::from_ref(&root)));
    let mut say = |claim, name: &str| {
        let m = component_for(&mut reg, claim, name).err().expect("nothing runs it");
        missing(claim, name, m)
    };
    let why = "which is installed but would not load: the installed copy was made for the previous engine and has no component for FundaCAD 1.0, updating the plugin in Preferences, Plugins fixes it";
    assert_eq!(say(Claim::Feature, "legacyThing"), format!("this needs the \"Some.Plugin\" plugin, {why}"));
    assert_eq!(say(Claim::Generator, "widget"), format!("the shape 'widget' needs the \"Some.Plugin\" plugin, {why}"));
    assert_eq!(say(Claim::Exporter, "legacy-3mf"), format!("the 'legacy-3mf' export needs the \"Some.Plugin\" plugin, {why}"));

    assert_eq!(say(Claim::Feature, "x"), "unknown feature type: x");
    assert_eq!(say(Claim::Generator, "x"), "no plugin that is running offers the shape 'x'");
    assert_eq!(say(Claim::Exporter, "x"), "no installed plugin provides the 'x' export");
    assert_eq!(
        missing(Claim::Feature, "t", Missing::NotRegistered("P".into())),
        "this needs the \"P\" plugin, which is installed but would not load: its component does not register it"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A plugin installed after the engine started is found by the next look, and
/// one that did not change keeps what it had loaded.
#[test]
fn a_rescan_finds_a_plugin_installed_later() {
    let root = temp_root("rescan");
    put_manifest(&root, "A.One", json!({"id": "A.One", "featureTypes": ["one"]}));
    let mut reg = Registry::default();
    reg.replace(discover_in(std::slice::from_ref(&root)));
    reg.entries[0].loaded = Loaded::Broken("kept".into());
    assert!(matches!(component_for(&mut reg, Claim::Feature, "two"), Err(Missing::Unknown)));

    put_manifest(&root, "B.Two", json!({"id": "B.Two", "featureTypes": ["two"]}));
    reg.replace(discover_in(std::slice::from_ref(&root)));
    assert!(matches!(component_for(&mut reg, Claim::Feature, "two"), Err(Missing::Broken(id, _)) if id == "B.Two"));
    assert!(matches!(&reg.entries[0].loaded, Loaded::Broken(why) if why == "kept"));

    put_manifest(&root, "A.One", json!({"id": "A.One", "featureTypes": ["one"], "version": "1.1.0"}));
    reg.replace(discover_in(std::slice::from_ref(&root)));
    assert!(matches!(&reg.entries[0].loaded, Loaded::NotYet), "a replaced bundle is read again");
    let _ = std::fs::remove_dir_all(&root);
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
fn ellipses_lofts_curves_and_an_affine_map() {
    let n = (0.0, 0.0, 1.0);
    let e = kx::ellipse_edge((0.0, 0.0, 0.0), n, (1.0, 0.0, 0.0), 2.0, 5.0, 0.0).unwrap();
    let disc = k::face_from_wire(&kx::wire_from_edges(&[&e]).unwrap()).unwrap();
    assert!(close(kernel::area(&disc), PI * 10.0, 1e-9));
    // The start is kept when the radius across is the larger one.
    let start = k::point_at(&e, 0.0).unwrap();
    assert!((start.0 - 2.0).abs() < 1e-9 && start.1.abs() < 1e-9, "{start:?}");
    let turned = kx::ellipse_edge((0.0, 0.0, 0.0), n, (1.0, 0.0, 0.0), 2.0, 5.0, PI / 2.0).unwrap();
    let start = k::point_at(&turned, 0.0).unwrap();
    assert!(start.0.abs() < 1e-9 && (start.1 - 5.0).abs() < 1e-9, "{start:?}");
    assert!(kx::ellipse_edge((0.0, 0.0, 0.0), n, n, 2.0, 5.0, 0.0).is_err());
    assert!(kx::ellipse_edge((0.0, 0.0, 0.0), n, (1.0, 0.0, 0.0), 0.0, 5.0, 0.0).is_err());

    let options = host::kernel::LoftOptions { ruled: true, smooth: false, match_seams: false, max_degree: 0 };
    let lower = kx::circle_edge((0.0, 0.0, 0.0), n, 3.0).unwrap();
    let upper = kx::circle_edge((0.0, 0.0, 10.0), n, 3.0).unwrap();
    let tube = kx::loft(&[&lower, &upper], None, None, &options).unwrap();
    assert!(close(kernel::volume(&tube), PI * 90.0, 1e-6), "{}", kernel::volume(&tube));
    let cone = kx::loft(&[&lower], None, Some((0.0, 0.0, 10.0)), &options).unwrap();
    assert!(close(kernel::volume(&cone), PI * 30.0, 1e-3), "{}", kernel::volume(&cone));
    assert!(kx::loft(&[&lower], None, None, &options).is_err());
    let waist = kx::circle_edge((0.0, 0.0, 5.0), n, 2.0).unwrap();
    let low = host::kernel::LoftOptions { ruled: false, smooth: false, match_seams: false, max_degree: 3 };
    let smooth = host::kernel::LoftOptions { smooth: true, max_degree: 0, ..low };
    for o in [low, smooth] {
        let vase = kx::loft(&[&lower, &waist, &upper], None, None, &o).unwrap();
        let v = kernel::volume(&vase);
        assert!(v > PI * 4.0 * 10.0 && v < PI * 90.0, "{v}");
    }

    let curve = kx::interpolate_edge(&[(0.0, 0.0, 0.0), (5.0, 5.0, 1.0), (10.0, 0.0, 2.0)], false).unwrap();
    let mid = k::point_at(&curve, 0.5).unwrap();
    assert!((mid.0 - 5.0).abs() < 0.1 && mid.1 > 4.9, "{mid:?}");
    assert!(kx::interpolate_edge(&[(0.0, 0.0, 0.0)], false).is_err());

    let ball = k::make_sphere((0.0, 0.0, 0.0), 1.0).unwrap();
    let squashed = kx::gtransform(&ball, &[3.0, 0.0, 0.0, 1.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]).unwrap();
    assert!(close(kernel::volume(&squashed), 4.0 / 3.0 * PI * 6.0, 1e-3), "{}", kernel::volume(&squashed));
    let bb = kernel::bbox(&squashed).unwrap();
    assert!((bb[0] + 2.0).abs() < 0.05 && (bb[3] - 4.0).abs() < 0.05, "{bb:?}");
    let mirror = [-1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    assert!(kx::gtransform(&ball, &mirror).is_err());
    assert!(kx::gtransform(&ball, &[1.0; 3]).is_err());
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
