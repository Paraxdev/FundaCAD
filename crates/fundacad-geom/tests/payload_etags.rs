//! A body the replay left alone keeps the etag its payload was stored with, and the reply built from cached
//! payloads is byte for byte the one a cold mesh gives.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::cache::RebuildCache;
use fundacad_geom::mesh::etags_hashed;
use fundacad_geom::reply;
use fundacad_protocol::frame::{encode_binary_reply, Limits};
use fundacad_protocol::{JobResult, MeshResult, WireBody};
use serde_json::{json, Map, Value};

const TOL: f64 = 0.1;

fn corpus_doc(name: &str) -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/golden/corpus/corpus_engines.json");
    let corpus: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("the corpus")).expect("json");
    corpus["documents"]
        .as_array()
        .expect("documents")
        .iter()
        .find(|d| d["name"] == name)
        .map(|d| d["document"].clone())
        .unwrap_or_else(|| panic!("no corpus document called {name}"))
}

/// `boxes_move_two_bodies` with both moves slanted off the axes.
fn two_boxes() -> Value {
    let mut d = corpus_doc("boxes_move_two_bodies");
    d["features"][1]["dy"] = json!(6.5);
    d["features"][1]["dz"] = json!(-2.25);
    d["features"][3]["dy"] = json!(-7.5);
    d["features"][3]["dz"] = json!(3.0);
    d
}

fn with_move(raw: &Value, dx: f64) -> Value {
    let mut d = raw.clone();
    d["features"][3]["dx"] = json!(dx);
    d
}

fn rebuild(cache: &mut RebuildCache, raw: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    cache.rebuild(&typed, raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"))
}

fn cold(raw: &Value, known: &Map<String, Value>) -> MeshResult {
    let typed: CadDocument = serde_json::from_value(raw.clone()).unwrap();
    let r = builder::rebuild(&typed, raw, &NoWatch).unwrap_or_else(|_| panic!("cancelled"));
    let JobResult::Mesh(m) = reply::mesh_result(&r.bodies, TOL, known, &NoWatch) else { panic!("mesh") };
    m
}

/// The cached mesh of `r` and how many etags it hashed on this thread.
fn mesh(cache: &mut RebuildCache, r: &Rebuild, known: &Map<String, Value>) -> (MeshResult, usize) {
    let before = etags_hashed();
    let m = cache.mesh(r, TOL, known, &mut |_, _| {});
    (m, etags_hashed() - before)
}

fn etags(m: &MeshResult) -> Map<String, Value> {
    m.bodies
        .iter()
        .map(|b| match b {
            WireBody::Full(f) => (f.fields["id"].as_str().unwrap().to_owned(), f.fields["etag"].clone()),
            WireBody::Stub(s) => (s["id"].as_str().unwrap().to_owned(), s["etag"].clone()),
        })
        .collect()
}

fn bytes(m: &MeshResult) -> Vec<u8> {
    encode_binary_reply(&json!(7), m, &Limits::default()).expect("the reply fits a frame")
}

fn stub(id: &str, name: &str, etag: &Value) -> WireBody {
    let Value::Object(m) = json!({"id": id, "name": name, "etag": etag, "unchanged": true}) else { unreachable!() };
    WireBody::Stub(m)
}

#[test]
fn an_unchanged_body_keeps_its_etag_and_is_not_hashed_again() {
    let mut cache = RebuildCache::new(None);
    let base = two_boxes();
    let r = rebuild(&mut cache, &base);
    let (first, _) = mesh(&mut cache, &r, &Map::new());
    let held = etags(&first);
    assert_eq!(held.len(), 2);
    let ids: Vec<String> = r.bodies.iter().map(|b| b.id.clone()).collect();
    let names: Vec<String> = r.bodies.iter().map(|b| b.name.clone()).collect();

    let edited = with_move(&base, 20.5);
    let r = rebuild(&mut cache, &edited);
    let (m, hashed) = mesh(&mut cache, &r, &held);
    let fresh = etags(&cold(&edited, &Map::new()));
    assert_ne!(fresh[&ids[1]], held[&ids[1]], "the moved box kept its etag");
    assert_eq!(fresh[&ids[0]], held[&ids[0]]);
    let WireBody::Full(moved) = &m.bodies[1] else { panic!("the moved box came as a stub") };
    assert_eq!(moved.fields["etag"], fresh[&ids[1]]);
    assert_eq!(m.bodies[0], stub(&ids[0], &names[0], &held[&ids[0]]));
    assert_eq!(hashed, 1, "only the moved box is hashed, when it is meshed");
    assert_eq!(cache.stats.mesh_ram_hits, 1);

    let now = etags(&m);
    let (again, hashed) = mesh(&mut cache, &r, &now);
    assert_eq!(again.bodies, vec![stub(&ids[0], &names[0], &now[&ids[0]]), stub(&ids[1], &names[1], &now[&ids[1]])]);
    assert_eq!(hashed, 0, "a body served from memory was hashed again");
    assert_eq!((cache.stats.mesh_ram_hits, cache.stats.meshed), (2, 0));

    // A second document reuses the body ids: its own geometry, not the first one's stubs.
    let other = with_move(&corpus_doc("boxes_move_two_bodies"), -31.0);
    let r = rebuild(&mut cache, &other);
    let (m, _) = mesh(&mut cache, &r, &now);
    assert!(m.bodies.iter().all(|b| matches!(b, WireBody::Full(_))));
    assert_eq!(etags(&m), etags(&cold(&other, &Map::new())));
}

#[test]
fn cached_replies_are_byte_identical_to_a_cold_mesh() {
    let mut cache = RebuildCache::new(None);
    let base = two_boxes();
    let r = rebuild(&mut cache, &base);
    let held = etags(&cache.mesh(&r, TOL, &Map::new(), &mut |_, _| {}));
    let edited = with_move(&base, 20.5);
    let r = rebuild(&mut cache, &edited);
    let ids: Vec<String> = r.bodies.iter().map(|b| b.id.clone()).collect();
    let now = etags(&cold(&edited, &Map::new()));

    let one: Map<String, Value> =
        held.iter().filter(|(k, _)| **k == ids[0]).map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut sums = Vec::new();
    for known in [Map::new(), one, held.clone(), now.clone()] {
        let warm = bytes(&cache.mesh(&r, TOL, &known, &mut |_, _| {}));
        assert_eq!(warm, bytes(&cold(&edited, &known)), "known {known:?}");
        sums.push(blake2_hex(&warm));
    }
    eprintln!("reply sums {sums:?}");
}

fn blake2_hex(data: &[u8]) -> String {
    use blake2::digest::{Update, VariableOutput};
    let mut h = blake2::Blake2bVar::new(16).unwrap();
    h.update(data);
    let mut out = [0u8; 16];
    h.finalize_variable(&mut out).unwrap();
    out.iter().map(|b| format!("{b:02x}")).collect()
}
