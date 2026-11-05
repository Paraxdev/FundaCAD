use super::*;

use std::f64::consts::PI;

use super::host::types::{BooleanOp, BooleanOptions, Fuzzy};
use super::kernel_api as k;
use super::kernel_ext as kx;
use crate::kernel;

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("fundacad-plugins-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn checkout(root: &Path) -> [PluginRoot; 1] {
    [PluginRoot { dir: root.to_path_buf(), records: false }]
}

fn put_manifest(root: &Path, id: &str, man: Value) {
    let dir = root.join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("manifest.json"), man.to_string()).unwrap();
}

/// The cache keys a plugin feature on this, so a new version or a new
/// component misses the checkpoints the old one wrote.
#[test]
fn a_bundle_identity_moves_with_its_version_and_its_component() {
    let id_of = |tag: &str, version: &str, wasm: &[u8]| {
        let root = temp_root(tag);
        put_manifest(
            &root,
            "P",
            json!({"id": "P", "version": version, MANIFEST_WASM: "p.wasm", "featureTypes": ["t"]}),
        );
        std::fs::write(root.join("P").join("p.wasm"), wasm).unwrap();
        let mut reg = Registry::default();
        reg.replace(discover_in(&checkout(&root)));
        let id = identity(&mut reg.entries[0]);
        let _ = std::fs::remove_dir_all(&root);
        id
    };
    let base = id_of("ida", "1.0.0", b"one");
    assert_eq!(base, id_of("idb", "1.0.0", b"one"));
    assert_ne!(base, id_of("idc", "1.0.1", b"one"));
    assert_ne!(base, id_of("idd", "1.0.0", b"two"));
}

/// A bundle for the retired Python engine declares what it owns and names no component. It still owns
/// those names, so every sentence names the plugin and says an update fixes it.
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
    reg.replace(discover_in(&checkout(&root)));
    let mut say = |claim, name: &str| {
        let m = component_for(&mut reg, claim, name).err().expect("nothing runs it");
        missing(claim, name, m)
    };
    let why = "which is installed but would not load: the installed copy was made for the previous engine and has no component for FundaCAD 1.0, updating the plugin in Preferences, Plugins fixes it";
    assert_eq!(say(Claim::Feature, "legacyThing"), format!("this needs the \"Some.Plugin\" plugin, {why}"));
    assert_eq!(say(Claim::Generator, "widget"), format!("the shape 'widget' needs the \"Some.Plugin\" plugin, {why}"));
    assert_eq!(
        say(Claim::Exporter, "legacy-3mf"),
        format!("the 'legacy-3mf' export needs the \"Some.Plugin\" plugin, {why}")
    );

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
    reg.replace(discover_in(&checkout(&root)));
    reg.entries[0].loaded = Loaded::Broken("kept".into());
    assert!(matches!(component_for(&mut reg, Claim::Feature, "two"), Err(Missing::Unknown)));

    put_manifest(&root, "B.Two", json!({"id": "B.Two", "featureTypes": ["two"]}));
    reg.replace(discover_in(&checkout(&root)));
    assert!(matches!(component_for(&mut reg, Claim::Feature, "two"), Err(Missing::Broken(id, _)) if id == "B.Two"));
    assert!(matches!(&reg.entries[0].loaded, Loaded::Broken(why) if why == "kept"));

    put_manifest(&root, "A.One", json!({"id": "A.One", "featureTypes": ["one"], "version": "1.1.0"}));
    reg.replace(discover_in(&checkout(&root)));
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
        let out =
            kx::boolean_with(BooleanOp::Cut, &b, &[&c], &BooleanOptions { parallel, fuzzy, clean: true }).unwrap();
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
    assert!(kx::boolean_with(
        BooleanOp::Cut,
        &b,
        &[],
        &BooleanOptions { parallel: true, fuzzy: Fuzzy::Exact, clean: true }
    )
    .is_err());
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
    let side =
        faces.iter().find(|f| kx::surface_frame(f).is_some_and(|s| s.kind == "cylinder")).expect("a cylindrical face");
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
    let top =
        kx::select_faces(&b, r#"{"kind": "face", "by": "nearest", "point": [5, 5, 10]}"#).ok().expect("the top face");
    assert_eq!(top.len(), 1);
    assert!(kx::select_faces(&b, "not json").is_err());
}

#[test]
fn os_errors_read_as_python_prints_them() {
    assert_eq!(host::py_repr("C:\\x\\it's"), "\"C:\\\\x\\\\it's\"");
    assert_eq!(host::py_repr("a'b\"c"), "'a\\'b\"c'");
}

fn dir_names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> =
        std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

fn append(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

#[test]
fn a_failed_export_keeps_the_old_file_byte_for_byte() {
    let root = temp_root("export-fail");
    let target = root.join("project.3mf");
    std::fs::write(&target, b"the old project").unwrap();

    let r: Result<(), String> = k::replace_after(&target, |part| {
        append(part, b"half of a new")?;
        Err("cancelled".into())
    });
    assert_eq!(r, Err("cancelled".into()));
    assert_eq!(std::fs::read(&target).unwrap(), b"the old project");
    assert_eq!(dir_names(&root), ["project.3mf"]);

    let r: Result<(), String> = k::replace_after(&target, |_| Ok(()));
    assert!(r.unwrap_err().contains("wrote nothing"));
    assert_eq!(std::fs::read(&target).unwrap(), b"the old project");
    assert_eq!(dir_names(&root), ["project.3mf"]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_finished_export_replaces_the_old_file_with_only_its_own_bytes() {
    let root = temp_root("export-ok");
    let target = root.join("project.3mf");
    std::fs::write(&target, b"the old project").unwrap();
    let r = k::replace_after(&target, |part| {
        append(part, b"new ")?;
        append(part, b"bytes")?;
        Ok(7)
    });
    assert_eq!(r, Ok(7));
    assert_eq!(std::fs::read(&target).unwrap(), b"new bytes");
    assert_eq!(dir_names(&root), ["project.3mf"]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_plugin_store_caps_its_linear_memories_in_total() {
    use wasmtime::ResourceLimiter;
    let over_half = MEMORY_LIMIT / 2 + (64 << 10);
    let mut limits = host::store_limits();
    assert!(limits.memory_growing(0, over_half, None).unwrap());
    assert!(!matches!(limits.memory_growing(0, over_half, None), Ok(true)));
}

#[test]
fn one_plugin_memory_still_grows_to_the_whole_cap() {
    use wasmtime::ResourceLimiter;
    let mut limits = host::store_limits();
    assert!(limits.memory_growing(0, MEMORY_LIMIT / 2, None).unwrap());
    assert!(limits.memory_growing(MEMORY_LIMIT / 2, MEMORY_LIMIT, None).unwrap());
    assert!(!matches!(limits.memory_growing(MEMORY_LIMIT, MEMORY_LIMIT + (64 << 10), None), Ok(true)));
}

#[test]
fn a_refused_memory_growth_gives_nothing_back_to_the_total() {
    use wasmtime::ResourceLimiter;
    let half = MEMORY_LIMIT / 2;
    let mut limits = host::store_limits();
    assert!(limits.memory_growing(0, half, None).unwrap());
    assert!(!matches!(limits.memory_growing(half, MEMORY_LIMIT + (64 << 10), None), Ok(true)));
    let _ = limits.memory_grow_failed(wasmtime::Error::msg("refused"));
    assert!(!matches!(limits.memory_growing(0, half + (64 << 10), None), Ok(true)));
}

#[test]
fn a_triangulation_finer_than_its_floor_meshes_at_the_floor() {
    let triangles = |times_floor: f64| {
        let ball = k::make_sphere((0.0, 0.0, 0.0), 10.0).unwrap();
        let face = k::items(&ball, k::Items::Faces).remove(0);
        let floor = k::MIN_RELATIVE_DEFLECTION * kernel::bbox_diagonal(&face);
        k::triangulate(&face, times_floor * floor).unwrap().indices.len()
    };
    assert_eq!(triangles(0.25), triangles(1.0));
    assert!(triangles(4.0) < triangles(1.0));
}

#[test]
fn a_helical_sweep_past_its_turn_cap_is_refused() {
    let tri = k::polygon_face(&[(5.0, 0.0, 0.0), (6.0, 0.0, 0.0), (5.0, 0.0, 1.0)]).unwrap();
    for degrees in [360.0 * 1000.5, -360.0 * 1000.5] {
        let r = kx::helical_sweep(&tri, (0.0, 0.0, 0.0), (0.0, 0.0, 1.0), degrees, 2.0);
        assert!(r.as_ref().err().is_some_and(|e| e.contains("1000 turns")), "{:?}", r.err());
    }
}

#[test]
fn a_planar_delaunay_past_its_point_cap_is_refused() {
    let points = vec![0.0; 2 * (kx::MAX_DELAUNAY_POINTS + 1)];
    let e = kx::delaunay_2d(&points).unwrap_err();
    assert!(e.contains("10000000 points"), "{e}");
}

#[test]
fn a_plugin_store_refuses_shapes_past_its_live_cap_and_counts_drops() {
    use host::kernel::HostShape as _;
    let cube = k::make_box((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)).unwrap();
    let mut st = host::State::bare();
    st.shape_cap = 2;
    let a = st.own(cube.clone()).unwrap();
    let b = st.own(cube.clone()).unwrap();
    let e = st.own(cube.clone()).unwrap_err().to_string();
    assert!(e.contains("more than 2 shapes"), "{e}");
    st.drop(a).unwrap();
    host::take(&mut st, b).unwrap();
    st.own(cube.clone()).unwrap();
    st.own(cube).unwrap();
}

#[test]
fn a_plugin_file_read_past_its_cap_is_refused() {
    let root = temp_root("read-cap");
    let path = root.join("big.bin");
    std::fs::write(&path, [7u8; 10]).unwrap();
    let path = path.to_string_lossy().into_owned();
    assert_eq!(host::read_file(&path, 10).unwrap(), vec![7u8; 10]);
    let e = host::read_file(&path, 9).unwrap_err();
    assert!(e.contains("larger than"), "{e}");
}

#[test]
fn a_plugin_call_stores_shapes_only_within_its_blob_budget() {
    let root = temp_root("blob-budget");
    let small = k::make_box((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)).unwrap();
    let other = k::make_box((0.0, 0.0, 0.0), (2.0, 1.0, 1.0)).unwrap();
    let len = opencascade::xcaf::to_bin_v3(&small).unwrap().len();
    let stored = || std::fs::read_dir(&root).unwrap().count();

    let mut b = k::BlobBudget::default();
    b.total = len + len / 2;
    k::write_blob_capped(&small, &root, &mut b).unwrap();
    let e = k::write_blob_capped(&other, &root, &mut b).unwrap_err();
    assert!(e.contains("in total"), "{e}");
    assert_eq!(stored(), 1);

    let mut b = k::BlobBudget::default();
    b.per_blob = len - 1;
    let e = k::write_blob_capped(&other, &root, &mut b).unwrap_err();
    assert!(e.contains("for one stored shape"), "{e}");

    assert_eq!(stored(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_plugin_call_may_store_any_number_of_shapes_within_its_bytes() {
    let root = temp_root("blob-many");
    let small = k::make_box((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)).unwrap();
    let mut b = k::BlobBudget::default();
    let stored: Result<Vec<String>, String> = (0..1100).map(|_| k::write_blob_capped(&small, &root, &mut b)).collect();
    assert_eq!(stored.map(|d| d.len()), Ok(1100));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_failed_blob_store_leaves_the_budget_unspent() {
    let root = temp_root("blob-unspent");
    let not_a_dir = root.join("file");
    std::fs::write(&not_a_dir, b"x").unwrap();
    let small = k::make_box((0.0, 0.0, 0.0), (1.0, 1.0, 1.0)).unwrap();
    let len = opencascade::xcaf::to_bin_v3(&small).unwrap().len();

    let mut b = k::BlobBudget::default();
    b.total = len + len / 2;
    assert!(k::write_blob_capped(&small, &not_a_dir, &mut b).is_err());
    assert!(k::write_blob_capped(&small, &root.join("store"), &mut b).is_ok());
    let _ = std::fs::remove_dir_all(&root);
}

fn broken_reason(root: &Path, rel: &str) -> String {
    put_manifest(root, "P", json!({"id": "P", "version": "1.0.0", MANIFEST_WASM: rel, "featureTypes": ["t"]}));
    let mut reg = Registry::default();
    reg.replace(discover_in(&checkout(root)));
    match compile(&reg.entries[0].declared) {
        Loaded::Broken(why) => why,
        _ => panic!("{rel:?} loaded"),
    }
}

#[test]
fn a_component_named_outside_its_bundle_is_not_loaded_or_hashed() {
    let root = temp_root("wasm-outside");
    std::fs::write(root.join("outside.wasm"), b"not in the bundle").unwrap();
    let abs = root.join("outside.wasm").to_string_lossy().replace('\\', "/");
    for rel in ["../outside.wasm", "./../outside.wasm", abs.as_str()] {
        let why = broken_reason(&root, rel);
        assert!(why.contains("outside the installed copy"), "{rel:?}: {why}");
        let mut reg = Registry::default();
        reg.replace(discover_in(&checkout(&root)));
        let with = identity(&mut reg.entries[0]);
        std::fs::write(root.join("outside.wasm"), b"other bytes").unwrap();
        let mut reg = Registry::default();
        reg.replace(discover_in(&checkout(&root)));
        assert_eq!(with, identity(&mut reg.entries[0]), "{rel:?}");
    }
    std::fs::write(root.join("P").join("p.wasm"), b"in the bundle").unwrap();
    let why = broken_reason(&root, "p.wasm");
    assert!(!why.contains("outside the installed copy"), "{why}");
    let _ = std::fs::remove_dir_all(&root);
}

fn put_installed(root: &Path, id: &str, official: bool, man: Value) {
    put_manifest(root, id, man);
    let record = json!({"id": id, "official": official, "consented": {"grants": []}});
    std::fs::write(root.join(id).join(RECORD), record.to_string()).unwrap();
}

#[test]
fn a_name_belongs_to_one_plugin_and_an_official_one_owns_it_first() {
    let root = temp_root("owners");
    std::fs::write(root.join(DISABLED), "[]").unwrap();
    put_installed(&root, "Acme.Tools", false, json!({"id": "Acme.Tools", "featureTypes": ["ribbon", "acme"]}));
    put_installed(&root, "Zed.Official", true, json!({"id": "Zed.Official", "featureTypes": ["ribbon"]}));
    let roots = [PluginRoot { dir: root.clone(), records: true }];
    assert_eq!(discovered_ids(&roots), ["Zed.Official", "Acme.Tools"], "mesh passes look in this order too");
    let mut reg = Registry::default();
    reg.replace(discover_in(&roots));
    assert!(
        matches!(component_for(&mut reg, Claim::Feature, "ribbon"), Err(Missing::Broken(id, _)) if id == "Zed.Official")
    );
    let m = component_for(&mut reg, Claim::Feature, "acme").err().expect("not loaded");
    assert_eq!(
        missing(Claim::Feature, "acme", m),
        "this needs the \"Acme.Tools\" plugin, which is installed but would not load: its feature type \"ribbon\" is already provided by the \"Zed.Official\" plugin"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_second_plugin_naming_an_owned_exporter_or_shape_is_not_loaded() {
    let root = temp_root("owners-checkout");
    put_manifest(&root, "A.One", json!({"id": "A.One", "exporters": ["x"], "shapeGenerators": ["g"]}));
    put_manifest(&root, "B.Two", json!({"id": "B.Two", "exporters": ["y"]}));
    put_manifest(&root, "C.Three", json!({"id": "C.Three", "exporters": ["z"], "shapeGenerators": ["g"]}));
    put_manifest(&root, "D.Four", json!({"id": "D.Four", "exporters": ["w", "x"]}));
    let mut reg = Registry::default();
    reg.replace(discover_in(&checkout(&root)));
    let why = |reg: &mut Registry, claim, name: &str| match component_for(reg, claim, name) {
        Err(Missing::Broken(id, why)) => format!("{id}: {why}"),
        _ => panic!("{name} resolved"),
    };
    assert_eq!(why(&mut reg, Claim::Exporter, "x"), format!("A.One: {NO_COMPONENT}"));
    assert_eq!(why(&mut reg, Claim::Exporter, "y"), format!("B.Two: {NO_COMPONENT}"));
    assert_eq!(
        why(&mut reg, Claim::Exporter, "z"),
        "C.Three: its shape generator \"g\" is already provided by the \"A.One\" plugin"
    );
    assert_eq!(
        why(&mut reg, Claim::Exporter, "w"),
        "D.Four: its exporter \"x\" is already provided by the \"A.One\" plugin"
    );
    let _ = std::fs::remove_dir_all(&root);
}
