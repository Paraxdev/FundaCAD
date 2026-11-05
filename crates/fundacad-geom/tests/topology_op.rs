//! The `topology` op against a real build: its face numbers and its wire order are the ones the mesh reply uses.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild, Watch};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use fundacad_geom::mesh::WalkedEdge;
use fundacad_geom::reply;
use fundacad_geom::topology::{edge_faces, topology_result};
use fundacad_protocol::{CancelToken, FullBody, JobResult, WireBody};
use opencascade::select_access as sa;
use serde_json::{json, Map, Value};

const SLANT: [(&str, f64); 6] =
    [("dx", 113.5), ("dy", -41.25), ("dz", 17.0), ("rx", 20.0), ("ry", -35.0), ("rz", 12.0)];

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-topology-op-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn slanted_move(id: &str, body: &str) -> Value {
    let mut m = json!({"id": id, "type": "move", "bodies": [body]});
    for (k, v) in SLANT {
        m[k] = json!(v);
    }
    m
}

fn at(id: &str, body: &str, x: f64, y: f64) -> Value {
    json!({"id": id, "type": "move", "dx": x, "dy": y, "bodies": [body]})
}

fn doc(features: Value) -> Value {
    json!({"version": 1, "parameters": {}, "features": features})
}

/// A 60 by 40 by 20 box with two through holes of radius 5 and one rounded corner, slanted off the origin.
fn holed() -> Value {
    doc(json!([
        {"id": "b", "type": "box", "length": 60, "width": 40, "height": 20},
        {"id": "c1", "type": "cylinder", "radius": 5, "height": 60},
        at("m1", "body2", -15.0, 5.0),
        {"id": "h1", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]},
        {"id": "c2", "type": "cylinder", "radius": 5, "height": 60},
        at("m2", "body3", 12.0, -6.0),
        {"id": "h2", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body3"]},
        {"id": "f", "type": "fillet", "radius": 3,
         "edges": [{"kind": "edge", "by": "nearest", "point": [30, 20, 0], "body": "body1"}]},
        slanted_move("mv", "body1"),
    ]))
}

fn splined() -> Value {
    let poles: Vec<Value> = [[0.0, -20.0], [25.0, -18.0], [30.0, 5.0], [12.0, 28.0], [-15.0, 22.0], [-28.0, 0.0]]
        .iter()
        .map(|p: &[f64; 2]| json!({"x": p[0], "y": p[1]}))
        .collect();
    doc(json!([
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [
            {"type": "bspline", "id": "sp", "closed": true, "poles": poles},
        ]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 10, "operation": "new"},
        slanted_move("mv", "body1"),
    ]))
}

fn imported(name: &str) -> Value {
    let store = BlobStore::open(blob_dir()).unwrap();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../../tests/fixtures/{name}.step"));
    let mut f = import::import_geometry(&path.to_string_lossy(), "step", &store).unwrap();
    f.remove("faces");
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!("step"));
    doc(json!([Value::Object(f)]))
}

fn build(raw: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let r = builder::rebuild(&typed, raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    assert!(r.errors.is_empty(), "{:?}", r.errors.iter().map(|e| &e.message).collect::<Vec<_>>());
    r
}

fn wire(r: &Rebuild) -> Vec<FullBody> {
    let JobResult::Mesh(m) = reply::mesh_result(&r.bodies, 0.1, &Map::new(), &NoWatch) else { panic!("a mesh reply") };
    m.bodies
        .into_iter()
        .map(|b| match b {
            WireBody::Full(f) => f,
            WireBody::Stub(_) => panic!("a full body"),
        })
        .collect()
}

fn ask_with(raw: &Value, extra: Value, watch: &dyn Watch) -> Value {
    let mut req = json!({"document": raw});
    for (k, v) in extra.as_object().unwrap() {
        req[k] = v.clone();
    }
    match topology_result(req.as_object().unwrap(), watch) {
        JobResult::Json(m) => Value::Object(m),
        JobResult::Mesh(_) => panic!("a JSON reply"),
    }
}

fn ask(raw: &Value, extra: Value) -> Value {
    ask_with(raw, extra, &NoWatch)
}

fn rows(reply: &Value) -> &Vec<Value> {
    reply["faces"].as_array().unwrap_or_else(|| panic!("no faces in {reply}"))
}

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn vec3(v: &Value) -> [f64; 3] {
    std::array::from_fn(|k| num(&v[k]))
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn length(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

fn no_negative_zero(v: &Value) {
    match v {
        Value::Number(n) => assert!(!(n.as_f64() == Some(0.0) && n.as_f64().unwrap().is_sign_negative()), "-0"),
        Value::Array(a) => a.iter().for_each(no_negative_zero),
        Value::Object(o) => o.values().for_each(no_negative_zero),
        _ => {}
    }
}

/// Area and area weighted centre of each face's triangles.
fn mesh_faces(b: &FullBody) -> Vec<(f64, [f64; 3])> {
    let count = b.face_ids.iter().max().map_or(0, |m| *m as usize + 1);
    let mut out = vec![(0.0, [0.0; 3]); count];
    let p = |i: u32| std::array::from_fn::<f64, 3, _>(|k| f64::from(b.positions[i as usize * 3 + k]));
    for (t, tri) in b.indices.chunks(3).enumerate() {
        let (a, c, d) = (p(tri[0]), p(tri[1]), p(tri[2]));
        let area = length(cross(sub(c, a), sub(d, a))) / 2.0;
        let slot = &mut out[b.face_ids[t] as usize];
        slot.0 += area;
        for k in 0..3 {
            slot.1[k] += area * (a[k] + c[k] + d[k]) / 3.0;
        }
    }
    for slot in &mut out {
        for k in 0..3 {
            slot.1[k] /= slot.0.max(1e-12);
        }
    }
    out
}

/// Each row is the mesh's face of that number, and each `edgeFaces` entry names faces that hold that wire edge.
fn assert_parity(raw: &Value, k: usize, label: &str) -> Value {
    let r = build(raw);
    let body = &wire(&r)[k];
    let id = r.bodies[k].id.clone();
    let reply = ask(raw, json!({"body": id}));
    assert_eq!(reply["body"], json!(id), "{label}");
    let list = rows(&reply);
    let shape_faces = kernel::subshapes(&r.bodies[k].shape, Kind::Face);
    assert_eq!(list.len(), shape_faces.len(), "{label}");
    assert_eq!(reply["faceCount"], json!(shape_faces.len()), "{label}");
    no_negative_zero(&reply);

    let meshed = mesh_faces(body);
    assert_eq!(body.fields["faceCount"], json!(meshed.len()), "{label}");
    assert!(meshed.len() <= list.len(), "{label}");
    for (i, row) in list.iter().enumerate() {
        assert_eq!(row["i"], json!(i), "{label}");
        let Some((area, centre)) = meshed.get(i) else { continue };
        let want = num(&row["area"]);
        assert!((area - want).abs() < 0.01 * want.max(1.0), "{label} face {i}: mesh {area} row {want}");
        let off = length(sub(*centre, vec3(&row["centroid"])));
        assert!(off < 0.25, "{label} face {i}: the mesh centre is {off} from the row's");
    }

    let joined = reply["edgeFaces"].as_array().unwrap();
    assert_eq!(joined.len(), body.edges.len(), "{label}");
    for (e, of) in joined.iter().enumerate() {
        let of = of.as_array().unwrap();
        assert!(!of.is_empty(), "{label} edge {e} joins nothing");
        let pts = &body.edges[e].points;
        let mid = pts[pts.len() / 2].map(f64::from);
        for f in of {
            let f = f.as_u64().unwrap() as usize;
            let (gap, _) = sa::distance_to_point(&shape_faces[f], mid).unwrap();
            assert!(gap < 0.02, "{label} edge {e} is {gap} from its face {f}");
        }
    }
    reply
}

#[test]
fn a_slanted_filleted_body_lists_the_faces_and_edges_the_mesh_has() {
    let reply = assert_parity(&holed(), 0, "holed");
    let list = rows(&reply);
    assert_eq!(list.len(), 9);
    assert_eq!(reply["edgeFaces"].as_array().unwrap().len(), 19);
    let bores: Vec<&Value> = list.iter().filter(|f| f["radius"] == json!(5.0)).collect();
    assert_eq!(bores.len(), 2);
    assert_eq!(bores[0]["area"], bores[1]["area"], "equal faces, told apart only by the centre check");
    assert!(length(sub(vec3(&bores[0]["centroid"]), vec3(&bores[1]["centroid"]))) > 20.0);
}

#[test]
fn a_spline_edge_keeps_wire_order_and_its_face_says_only_what_it_knows() {
    let raw = splined();
    let reply = assert_parity(&raw, 0, "spline");
    let body = &wire(&build(&raw))[0];
    assert!(body.edges.iter().any(|e| e.points.len() > 4), "a sampled curve is on the wire");
    let wall = rows(&reply).iter().find(|f| f.get("normal").is_none()).expect("a curved wall");
    let mut keys: Vec<&str> = wall.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["area", "centroid", "i", "surface"]);
    assert_ne!(wall["surface"], json!("plane"));
}

#[test]
fn an_imported_body_lists_the_faces_and_edges_the_mesh_has() {
    blob_dir();
    assert_parity(&imported("loose_faces_solid"), 0, "bracket");
    let raw = imported("asm_multisolid");
    for k in [0, 3] {
        assert_parity(&raw, k, "assembly");
    }
    assert_eq!(build(&raw).bodies.len(), 4);
}

#[test]
fn a_box_off_the_origin_says_exact_normals_and_sizes() {
    let raw = doc(json!([
        {"id": "b", "type": "box", "length": 60, "width": 40, "height": 20},
        at("m", "body1", 7.5, -3.25),
    ]));
    let reply = ask(&raw, json!({"body": "body1"}));
    no_negative_zero(&reply);
    let mut got: Vec<Value> = rows(&reply)
        .iter()
        .map(|f| {
            let mut f = f.clone();
            f.as_object_mut().unwrap().remove("i");
            f
        })
        .collect();
    got.sort_by(|a, b| a["normal"].to_string().cmp(&b["normal"].to_string()));
    let row = |normal: [f64; 3], centroid: [f64; 3], area: f64, size: [f64; 2]| json!({"surface": "plane", "area": area, "centroid": centroid, "normal": normal, "size": size});
    let mut want = vec![
        row([0.0, 0.0, 1.0], [7.5, -3.25, 10.0], 2400.0, [60.0, 40.0]),
        row([0.0, 0.0, -1.0], [7.5, -3.25, -10.0], 2400.0, [60.0, 40.0]),
        row([0.0, 1.0, 0.0], [7.5, 16.75, 0.0], 1200.0, [60.0, 20.0]),
        row([0.0, -1.0, 0.0], [7.5, -23.25, 0.0], 1200.0, [60.0, 20.0]),
        row([1.0, 0.0, 0.0], [37.5, -3.25, 0.0], 800.0, [40.0, 20.0]),
        row([-1.0, 0.0, 0.0], [-22.5, -3.25, 0.0], 800.0, [40.0, 20.0]),
    ];
    want.sort_by(|a, b| a["normal"].to_string().cmp(&b["normal"].to_string()));
    assert_eq!(got, want);
    assert_eq!(reply["edgeFaces"].as_array().unwrap().len(), 12);
    assert_eq!(reply["errors"], json!([]));
    assert!(reply.get("truncated").is_none());
}

#[test]
fn a_pocket_floor_faces_out_of_the_material() {
    let raw = doc(json!([
        {"id": "b", "type": "box", "length": 60, "width": 40, "height": 20},
        {"id": "t", "type": "box", "length": 10, "width": 8, "height": 20},
        {"id": "m", "type": "move", "dx": 9, "dy": -4, "dz": 10, "bodies": ["body2"]},
        {"id": "c", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]},
    ]));
    let reply = ask(&raw, json!({"body": "body1"}));
    let floor = rows(&reply).iter().find(|f| f["centroid"] == json!([9.0, -4.0, 0.0])).expect("the floor");
    assert_eq!(floor["normal"], json!([0.0, 0.0, 1.0]));
    assert_eq!(floor["area"], json!(80.0));
    assert_eq!(floor["size"], json!([10.0, 8.0]));
    let wall = rows(&reply).iter().find(|f| f["centroid"] == json!([14.0, -4.0, 5.0])).expect("a wall");
    assert_eq!(wall["normal"], json!([-1.0, 0.0, 0.0]));
}

#[test]
fn a_rectangle_turned_in_its_plane_reports_its_true_sides() {
    let (s, c) = 30f64.to_radians().sin_cos();
    let p = |x: f64, y: f64| (x * c - y * s + 37.5, x * s + y * c - 12.25);
    let corners = [p(0.0, 0.0), p(50.0, 0.0), p(50.0, 30.0), p(0.0, 30.0)];
    let lines: Vec<Value> = (0..4)
        .map(|k| {
            let (a, b) = (corners[k], corners[(k + 1) % 4]);
            json!({"type": "line", "id": format!("l{k}"), "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1})
        })
        .collect();
    let flat = doc(json!([
        {"id": "s", "type": "sketch", "plane": "XY", "entities": lines},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 7, "operation": "new"},
    ]));
    let mut slanted = flat.clone();
    slanted["features"].as_array_mut().unwrap().push(slanted_move("mv", "body1"));
    for raw in [&flat, &slanted] {
        let reply = ask(raw, json!({"body": "body1"}));
        let mut sizes: Vec<String> = rows(&reply).iter().map(|f| f["size"].to_string()).collect();
        sizes.sort();
        let want = ["[30.0,7.0]", "[30.0,7.0]", "[50.0,30.0]", "[50.0,30.0]", "[50.0,7.0]", "[50.0,7.0]"];
        assert_eq!(sizes, want);
    }
}

#[test]
fn a_bore_looks_at_its_axis_and_a_boss_does_not_on_a_slanted_axis() {
    let reply = ask(&holed(), json!({"body": "body1"}));
    let list = rows(&reply);
    let top = list.iter().find(|f| f["size"] == json!([60.0, 40.0])).expect("a big flat face");
    let up = vec3(&top["normal"]);
    let bore = list.iter().find(|f| f["radius"] == json!(5.0)).expect("a bore");
    let mut keys: Vec<&str> = bore.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["area", "axis", "centroid", "concave", "i", "length", "radius", "surface", "wraps"]);
    assert_eq!(bore["concave"], json!(true));
    assert_eq!(bore["wraps"], json!(true));
    assert_eq!(bore["surface"], json!("cylinder"));
    assert_eq!(bore["length"], json!(20.0));
    assert!((dot(vec3(&bore["axis"]), up).abs() - 1.0).abs() < 1e-6);
    let round = list.iter().find(|f| f["radius"] == json!(3.0)).expect("the fillet");
    assert_eq!((&round["concave"], &round["wraps"], &round["length"]), (&json!(false), &json!(false), &json!(20.0)));

    let boss = doc(json!([
        {"id": "c", "type": "cylinder", "radius": 4.5, "height": 33},
        slanted_move("mv", "body1"),
    ]));
    let reply = ask(&boss, json!({"body": "body1"}));
    let list = rows(&reply);
    let wall = list.iter().find(|f| f["surface"] == json!("cylinder")).expect("a wall");
    assert_eq!(wall["concave"], json!(false));
    assert_eq!(wall["radius"], json!(4.5));
    assert_eq!(wall["length"], json!(33.0));
    assert_eq!(wall["wraps"], json!(true));
    let cap = list.iter().find(|f| f["surface"] == json!("plane")).expect("a cap");
    let (long, short) = (num(&cap["size"][0]), num(&cap["size"][1]));
    assert!((long - 9.0).abs() < 1e-3 && (short - 9.0).abs() < 1e-3, "a disc, sampled finely: {long} by {short}");
    assert!((dot(vec3(&cap["normal"]), vec3(&wall["axis"])).abs() - 1.0).abs() < 1e-6);
}

#[test]
fn every_round_surface_gives_its_own_sizes() {
    let cone = doc(json!([
        {"id": "c", "type": "cone", "bottomRadius": 5, "topRadius": 0, "height": 10, "operation": "new"},
        slanted_move("mv", "body1"),
    ]));
    let reply = assert_parity(&cone, 0, "cone");
    let side = rows(&reply).iter().find(|f| f["surface"] == json!("cone")).expect("a cone");
    let semi = num(&side["semiAngle"]);
    assert!((semi - 0.5f64.atan()).abs() < 1e-5, "{side}");
    assert_eq!(side["length"], json!(10.0), "the seam runs to the apex");
    assert_eq!((&side["concave"], &side["wraps"]), (&json!(false), &json!(true)));

    let sphere = doc(json!([
        {"id": "s", "type": "sphere", "radius": 4.25},
        at("m", "body1", 11.0, -6.5),
    ]));
    let reply = assert_parity(&sphere, 0, "one face");
    assert_eq!(reply["faceCount"], json!(1));
    let only = &rows(&reply)[0];
    assert_eq!((&only["surface"], &only["radius"], &only["concave"]), (&json!("sphere"), &json!(4.25), &json!(false)));
    assert!(only.get("normal").is_none() && only.get("axis").is_none());

    let pocket = doc(json!([
        {"id": "b", "type": "box", "length": 30, "width": 30, "height": 30},
        {"id": "s", "type": "sphere", "radius": 6.5},
        {"id": "m", "type": "move", "dx": 2, "dy": -3, "dz": 15, "bodies": ["body2"]},
        {"id": "c", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]},
    ]));
    let reply = ask(&pocket, json!({"body": "body1"}));
    let hollow = rows(&reply).iter().find(|f| f["surface"] == json!("sphere")).expect("a pocket");
    assert_eq!(hollow["concave"], json!(true));

    let ring = doc(json!([
        {"id": "t", "type": "torus", "majorRadius": 12, "minorRadius": 2.5},
        slanted_move("mv", "body1"),
    ]));
    let reply = assert_parity(&ring, 0, "torus");
    let tube = &rows(&reply)[0];
    assert_eq!((&tube["surface"], &tube["major"], &tube["radius"]), (&json!("torus"), &json!(12.0), &json!(2.5)));
    assert_eq!(tube["concave"], json!(false));
    assert!((length(vec3(&tube["axis"])) - 1.0).abs() < 1e-5);
}

#[test]
fn asking_for_faces_returns_just_those_rows_and_no_edges() {
    let raw = holed();
    let whole = ask(&raw, json!({"body": "body1"}));
    let list = rows(&whole);
    let one = ask(&raw, json!({"body": "body1", "faces": [7]}));
    assert_eq!(one, json!({"body": "body1", "faceCount": 9, "faces": [list[7]], "errors": []}));
    let some = ask(&raw, json!({"body": "body1", "faces": [8, 2, 2, 400]}));
    assert_eq!(some["faces"], json!([list[2], list[8]]), "sorted, once each, a number past the end left out");
    assert!(some.get("truncated").is_none());
    let none = ask(&raw, json!({"body": "body1", "faces": []}));
    assert_eq!(none, json!({"body": "body1", "faceCount": 9, "faces": [], "errors": []}));
    for bad in [json!(3), json!(["3"]), json!([-1]), json!([1.5])] {
        let refused = ask(&raw, json!({"body": "body1", "faces": bad}));
        assert!(refused["error"]["message"].as_str().unwrap().contains("faces"), "{refused}");
    }
}

#[test]
fn max_faces_cuts_rows_and_says_how_many_keeping_every_edge() {
    let raw = holed();
    let whole = ask(&raw, json!({"body": "body1"}));
    let list = rows(&whole);
    let two = ask(&raw, json!({"body": "body1", "maxFaces": 2}));
    assert_eq!(two["faces"], json!(list[..2]));
    assert_eq!(two["truncated"], json!({"faces": 7}));
    assert_eq!(two["edgeFaces"], whole["edgeFaces"]);
    assert_eq!(two["faceCount"], json!(9));

    assert!(ask(&raw, json!({"body": "body1", "maxFaces": 9})).get("truncated").is_none());
    let under = ask(&raw, json!({"body": "body1", "maxFaces": 8}));
    assert_eq!((rows(&under).len(), &under["truncated"]), (8, &json!({"faces": 1})));
    let zero = ask(&raw, json!({"body": "body1", "maxFaces": 0}));
    assert_eq!((rows(&zero).len(), &zero["truncated"]), (0, &json!({"faces": 9})));
    let picked = ask(&raw, json!({"body": "body1", "faces": [1, 4, 6], "maxFaces": 2}));
    assert_eq!(picked["faces"], json!([list[1], list[4]]));
    assert_eq!(picked["truncated"], json!({"faces": 1}));
}

// A seam is not drawn, so no body built here has a drawn edge through one face twice.
#[test]
fn an_edge_through_one_face_twice_names_it_once_and_an_undrawn_edge_is_left_out() {
    let walked = |faces: Vec<usize>, drawn: bool| WalkedEdge { edge: 0, faces, points: vec![], drawn };
    let wire = edge_faces(&[
        walked(vec![2, 2], true),
        walked(vec![0, 1], true),
        walked(vec![3, 3], false),
        walked(vec![4, 5, 4], true),
        walked(vec![], true),
    ]);
    assert_eq!(wire, vec![json!([2]), json!([0, 1]), json!([4, 5, 4]), json!([])]);
}

#[test]
fn a_body_is_found_by_id_or_name_and_an_unknown_one_is_an_error() {
    let raw = doc(json!([
        {"id": "b", "type": "box", "length": 9, "width": 7, "height": 5},
        {"id": "s", "type": "sphere", "radius": 3},
        at("m", "body2", 40.0, 25.0),
    ]));
    let r = build(&raw);
    let second = ask(&raw, json!({"body": r.bodies[1].name}));
    assert_eq!(second["body"], json!(r.bodies[1].id));
    assert_eq!(second["faceCount"], json!(1));
    assert_eq!(ask(&raw, json!({"body": "body1"}))["faceCount"], json!(6));

    let unknown = ask(&raw, json!({"body": "body9"}));
    assert!(unknown["error"]["message"].as_str().unwrap().contains("body9"), "{unknown}");
    assert!(unknown.get("faces").is_none());
    assert!(ask(&raw, json!({}))["error"]["message"].is_string());
    assert!(ask(&raw, json!({"body": 4}))["error"]["message"].is_string());
}

#[test]
fn an_empty_document_has_no_body_to_list() {
    let reply = ask(&doc(json!([])), json!({"body": "body1"}));
    assert!(reply["error"]["message"].is_string(), "{reply}");
    assert!(reply.get("faces").is_none());
}

#[test]
fn a_scan_is_one_face_with_nothing_to_measure() {
    let dir = blob_dir();
    let (lat, lon) = (280usize, 280usize);
    let point = |i: usize, j: usize| -> [f32; 3] {
        let (th, ph) = (std::f64::consts::PI * i as f64 / lat as f64, std::f64::consts::TAU * j as f64 / lon as f64);
        [(20.0 * th.sin() * ph.cos()) as f32 + 9.0, (20.0 * th.sin() * ph.sin()) as f32 - 4.0, (20.0 * th.cos()) as f32]
    };
    let mut bytes = vec![0u8; 84];
    let mut count = 0u32;
    let mut tri = |a: [f32; 3], b: [f32; 3], c: [f32; 3]| {
        bytes.extend_from_slice(&[0u8; 12]);
        for v in [a, b, c] {
            for x in v {
                bytes.extend_from_slice(&x.to_le_bytes());
            }
        }
        bytes.extend_from_slice(&[0u8; 2]);
        count += 1;
    };
    for i in 0..lat {
        for j in 0..lon {
            let (a, b, c, d) = (point(i, j), point(i + 1, j), point(i + 1, j + 1), point(i, j + 1));
            if i > 0 {
                tri(a, b, d);
            }
            if i + 1 < lat {
                tri(b, c, d);
            }
        }
    }
    bytes[80..84].copy_from_slice(&count.to_le_bytes());
    let path = dir.join("scan.stl");
    std::fs::write(&path, &bytes).unwrap();
    let store = BlobStore::open(dir).unwrap();
    let got = import::import_geometry(&path.to_string_lossy(), "stl", &store).expect("a scan");
    assert_eq!(got["scan"], json!(true));
    let raw = doc(json!([{"id": "scan", "type": "import", "format": "stl", "name": got["name"], "geom": got["geom"],
                          "solid": false, "scan": true}]));
    let reply = ask(&raw, json!({"body": "body1"}));
    assert_eq!(reply["faceCount"], json!(1));
    assert_eq!(reply["edgeFaces"], json!([]));
    let only = &rows(&reply)[0];
    assert_eq!((&only["i"], &only["surface"]), (&json!(0), &json!("other")));
    for fact in ["normal", "size", "axis", "radius", "length", "wraps", "concave"] {
        assert!(only.get(fact).is_none(), "{only}");
    }
}

struct Beats {
    token: CancelToken,
    beats: Arc<AtomicUsize>,
    cancel_at: usize,
}

impl Watch for Beats {
    fn cancelled(&self) -> bool {
        self.token.is_cancelled()
    }
    fn cancel_token(&self) -> Option<CancelToken> {
        Some(self.token.clone())
    }
    fn heartbeat(&self) -> Option<fundacad_geom::heartbeat::Beat> {
        let (token, beats, at) = (self.token.clone(), self.beats.clone(), self.cancel_at);
        Some(Arc::new(move || {
            if beats.fetch_add(1, Ordering::SeqCst) + 1 >= at {
                token.cancel();
            }
        }))
    }
}

#[test]
fn a_cancel_stops_the_list_between_faces() {
    let raw = holed();
    ask(&raw, json!({"body": "body1"}));

    let beats = Arc::new(AtomicUsize::new(0));
    let live = Beats { token: CancelToken::new(), beats: beats.clone(), cancel_at: usize::MAX };
    assert_eq!(rows(&ask_with(&raw, json!({"body": "body1"}), &live)).len(), 9);
    assert!(beats.load(Ordering::SeqCst) >= 9, "every face beats");

    let beats = Arc::new(AtomicUsize::new(0));
    let midway = Beats { token: CancelToken::new(), beats: beats.clone(), cancel_at: 1 };
    let stopped = ask_with(&raw, json!({"body": "body1"}), &midway);
    assert_eq!(stopped["error"]["message"], json!("cancelled"));
    assert!(beats.load(Ordering::SeqCst) < 9, "it stopped before the last face");

    let early = Beats { token: CancelToken::new(), beats: Arc::new(AtomicUsize::new(0)), cancel_at: usize::MAX };
    early.token.cancel();
    assert_eq!(ask_with(&raw, json!({"body": "body1"}), &early)["error"]["message"], json!("cancelled"));
}

/// 2 caps and `4 * teeth + 2` flat walls.
fn comb(teeth: usize) -> Value {
    let mut ring: Vec<(f64, f64)> = Vec::new();
    for k in 0..teeth {
        let x = 2.0 * k as f64;
        ring.extend([(x, 0.0), (x, 10.0), (x + 1.0, 10.0), (x + 1.0, 0.0)]);
    }
    ring.extend([(2.0 * teeth as f64, -5.0), (-1.0, 0.0)]);
    let lines: Vec<Value> = (0..ring.len())
        .map(|k| {
            let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
            json!({"type": "line", "id": format!("l{k}"), "x1": a.0, "y1": a.1, "x2": b.0, "y2": b.1})
        })
        .collect();
    doc(json!([
        {"id": "s", "type": "sketch", "plane": "XY", "entities": lines},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 8, "operation": "new"},
    ]))
}

fn plate(holes: usize) -> Value {
    let side = (holes as f64).sqrt().ceil() as usize;
    let far = side * 10;
    let outline = vec![
        json!({"type": "line", "id": "a", "x1": 0, "y1": 0, "x2": far, "y2": 0}),
        json!({"type": "line", "id": "b", "x1": far, "y1": 0, "x2": far, "y2": far}),
        json!({"type": "line", "id": "c", "x1": far, "y1": far, "x2": 0, "y2": far}),
        json!({"type": "line", "id": "d", "x1": 0, "y1": far, "x2": 0, "y2": 0}),
    ];
    let circles: Vec<Value> = (0..holes)
        .map(|k| {
            let (x, y) = ((k % side) * 10 + 5, (k / side) * 10 + 5);
            json!({"type": "circle", "id": format!("h{k}"), "x": x, "y": y, "radius": 3})
        })
        .collect();
    doc(json!([
        {"id": "s", "type": "sketch", "plane": "XY", "entities": outline},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 8, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": "XY", "entities": circles},
        {"id": "h", "type": "extrude", "sketch": "s2", "distance": 8, "operation": "cut"},
    ]))
}

// The budget of the Geometry list, run by hand in release:
// cargo test --release -p fundacad-geom --test topology_op -- --ignored --nocapture
#[test]
#[ignore = "a measurement, slow"]
fn measure_the_op_on_big_bodies() {
    for (label, raw) in [("comb 2004", comb(500)), ("comb 10004", comb(2500)), ("plate 1000", plate(994))] {
        let t = std::time::Instant::now();
        let first = ask(&raw, json!({"body": "body1"}));
        let cold = t.elapsed();
        let mut warm = Vec::new();
        for _ in 0..3 {
            let t = std::time::Instant::now();
            let reply = ask(&raw, json!({"body": "body1"}));
            warm.push(t.elapsed());
            assert_eq!(reply["faces"], first["faces"]);
        }
        let t = std::time::Instant::now();
        let one = ask(&raw, json!({"body": "body1", "faces": [1]}));
        let lone = t.elapsed();
        assert_eq!(rows(&one).len(), 1);
        let bytes = serde_json::to_vec(&first).unwrap().len();
        eprintln!(
            "{label}: faces {} edges {} bytes {bytes} first {cold:?} warm {warm:?} one face {lone:?}",
            first["faceCount"],
            first["edgeFaces"].as_array().unwrap().len(),
        );
    }
}
