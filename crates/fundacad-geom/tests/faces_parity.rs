//! fundacad-geom::topo and ::faces against sidecar topo_adj.py and
//! face_bands.py, on the BREP fixtures tests/faces/gen.py wrote.

use fundacad_geom::{faces, mesh, topo};
use opencascade::mesh_access;
use opencascade::primitives::{Shape, ShapeType};
use serde_json::{json, Value};
use std::path::PathBuf;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/faces")
}

fn load(name: &str) -> (Shape, Value) {
    let text = std::fs::read_to_string(dir().join(format!("{name}.brep"))).unwrap();
    let want = std::fs::read_to_string(dir().join(format!("{name}.json"))).unwrap();
    (
        mesh_access::read_brep_str(&text).expect("fixture BREP reads"),
        serde_json::from_str(&want).unwrap(),
    )
}

fn names() -> Vec<String> {
    serde_json::from_str(&std::fs::read_to_string(dir().join("fixtures.json")).unwrap()).unwrap()
}

fn components(adj: &topo::FaceAdjacency) -> Vec<Vec<usize>> {
    let mut c: Vec<Vec<usize>> = adj
        .components()
        .into_iter()
        .map(|mut g| {
            g.sort_unstable();
            g
        })
        .collect();
    c.sort();
    c
}

#[test]
fn adjacency_matches_topo_adj() {
    let mut failures = Vec::new();
    for name in names() {
        let (shape, want) = load(&name);
        let adj = topo::FaceAdjacency::new(&shape);
        let edges = shape.shape_map(ShapeType::Edge);
        let got = json!({
            "extent": adj.extent(),
            "neighbors": adj.indices().map(|i| adj.neighbors(i).into_iter().collect::<Vec<_>>()).collect::<Vec<_>>(),
            "walkCounts": adj.indices().map(|i| adj.walk(i).len()).collect::<Vec<_>>(),
            "edgeFaces": edges.iter().map(|e| adj.faces_of_edge(&e)).collect::<Vec<_>>(),
            "components": components(&adj),
            "wraps": adj.indices().map(|i| topo::face_wraps(&adj.face(i))).collect::<Vec<_>>(),
        });
        for key in ["extent", "neighbors", "walkCounts", "edgeFaces", "components", "wraps"] {
            if got[key] != want[key] {
                failures.push(format!("{name}.{key}: got {} want {}", got[key], want[key]));
            }
        }
        for i in adj.indices() {
            if adj.index_of(&adj.face(i)) != i {
                failures.push(format!("{name}: index_of(face({i})) != {i}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_face_of_another_shape_has_no_index() {
    let adj = topo::FaceAdjacency::new(&Shape::box_with_dimensions(20.0, 20.0, 10.0));
    let stranger = Shape::box_with_dimensions(20.0, 20.0, 10.0);
    let face = stranger.shape_map(ShapeType::Face).get(1).unwrap();
    assert_eq!(adj.index_of(&face), 0);
}

#[test]
fn face_bands_match_face_bands_py() {
    let mut failures = Vec::new();
    for name in names() {
        let (shape, want) = load(&name);
        let got = faces::face_bands(&shape);
        if json!(got) != want["bands"] {
            failures.push(format!("{name}: bands got {got:?} want {}", want["bands"]));
        }
        let tol = faces::gap_tolerance(&shape);
        let wtol = want["gapTolerance"].as_f64().unwrap();
        if (tol - wtol).abs() > 1e-6 {
            failures.push(format!("{name}: gap tolerance {tol} want {wtol}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_dense_body_is_skipped() {
    let (shape, _) = load("split_wall");
    let items = opencascade::select_access::items(&shape, opencascade::select_access::ItemKind::Face);
    assert!(faces::face_bands_capped(&shape, &items, 2).is_empty());
    assert_eq!(faces::face_bands_capped(&shape, &items, 3000), vec![vec![0, 1]]);
}

#[test]
fn the_payload_carries_face_bands_only_when_there_is_a_run() {
    let (split, _) = load("split_wall");
    let p = mesh::body_payload(&split, "b", "B", 0.1, mesh::viewport_profile(1));
    assert_eq!(p.fields["faceBands"], json!([[0, 1]]));
    let keys: Vec<&str> = p.fields.keys().map(String::as_str).collect();
    let at = keys.iter().position(|k| *k == "faceBands").unwrap();
    assert_eq!(keys[at - 1], "bbox");
    let (plain, _) = load("box");
    let p = mesh::body_payload(&plain, "b", "B", 0.1, mesh::viewport_profile(1));
    assert!(!p.fields.contains_key("faceBands"));
}

#[test]
fn a_cached_payload_still_carries_its_bands() {
    let (split, _) = load("split_wall");
    let body = mesh::MeshBody {
        id: "b".into(),
        name: "B".into(),
        shape: Some(&split),
        identity: Some((1, 1)),
        ..Default::default()
    };
    let mut payloads = fundacad_geom::cache::meshes::Payloads::default();
    let bands = |r: &fundacad_protocol::MeshResult| r.bodies[0].fields()["faceBands"].clone();
    let want = json!([[0, 1]]);
    {
        let mut cache = fundacad_geom::cache::meshes::Tiered {
            payloads: &mut payloads,
            store: None,
            persist_after: std::time::Duration::ZERO,
        };
        let first = mesh::mesh_result_cached(std::slice::from_ref(&body), 0.1, &Default::default(), &mut cache);
        assert_eq!(bands(&first), want);
        let again = mesh::mesh_result_cached(std::slice::from_ref(&body), 0.1, &Default::default(), &mut cache);
        assert_eq!(bands(&again), want, "a cached payload lost its face bands");
    }
    assert_eq!(payloads.ram_hits, 1);
    // ...and the disk tier, which carries the payload as bytes.
    let full = mesh::body_payload(&split, "b", "B", 0.1, mesh::viewport_profile(1));
    let bytes = fundacad_geom::cache::meshes::encode(&mesh::strip_envelope(&full));
    let back = fundacad_geom::cache::meshes::decode(&bytes).expect("a payload decodes");
    assert_eq!(back.fields["faceBands"], want);
}
