//! The import feature, the oracles of sidecar/tests/test_assembly.py and
//! test_blob_rebuild.py: a STEP imported through the `import` op, rebuilt from
//! its blob.

use std::path::PathBuf;
use std::sync::OnceLock;

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::import::{self, blobstore::BlobStore};
use fundacad_geom::kernel::{self, Kind};
use serde_json::{json, Map, Value};

fn blob_dir() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("fundacad-import-feature-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("FUNDACAD_BLOB_DIR", &dir);
        dir
    })
}

fn fixture(name: &str) -> String {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../sidecar/fixtures/{name}.step"))
        .to_string_lossy()
        .into_owned()
}

fn imported(name: &str) -> Map<String, Value> {
    let store = BlobStore::open(blob_dir()).unwrap();
    import::import_geometry(&fixture(name), "step", &store).unwrap()
}

fn doc_of(feature: Map<String, Value>) -> Value {
    let mut f = feature;
    f.insert("id".into(), json!("f1"));
    f.insert("type".into(), json!("import"));
    f.insert("format".into(), json!("step"));
    json!({"version": 1, "parameters": {}, "features": [f]})
}

fn build(doc: &Value) -> Rebuild {
    let typed: CadDocument = serde_json::from_value(doc.clone()).unwrap();
    builder::rebuild(&typed, doc, &NoWatch).unwrap_or_else(|_| panic!("cancelled"))
}

fn clean(doc: &Value) -> Rebuild {
    let r = build(doc);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r
}

#[test]
fn a_multisolid_product_names_its_bodies_from_the_manifest() {
    let r = clean(&doc_of(imported("asm_multisolid")));
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["M3 Nut (x3) 1", "M3 Nut (x3) 2", "M3 Nut (x3) 3", "Plate"]);
    let refs: Vec<Option<&str>> = r.bodies.iter().map(|b| b.node_ref.as_deref()).collect();
    assert_eq!(refs, [Some("f1/1"), Some("f1/1"), Some("f1/1"), Some("f1/2")]);
    let ids: Vec<&str> = r.body_ids.values().map(String::as_str).collect();
    assert_eq!(ids, ["body1", "body2", "body3", "body4"]);
    assert!(r.body_ids.contains_key("f1/1"));
}

#[test]
fn each_occurrence_of_a_repeated_subassembly_is_its_own_node() {
    let r = clean(&doc_of(imported("asm_nested")));
    let mcus: Vec<_> = r.bodies.iter().filter(|b| b.name == "MCU").collect();
    assert_eq!(mcus.len(), 2);
    assert_ne!(mcus[0].node_ref, mcus[1].node_ref);
}

#[test]
fn a_solid_less_product_stays_a_body() {
    let r = clean(&doc_of(imported("asm_empty_product")));
    let names: Vec<&str> = r.bodies.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(names, ["Panel", "Decal"]);
}

#[test]
fn face_colours_reach_the_body() {
    let r = clean(&doc_of(imported("asm_face_colors")));
    assert!(r.bodies.iter().any(|b| b.face_colors.is_some()), "no body carries face colours");
}

#[test]
fn a_manifest_that_disagrees_falls_back_loudly() {
    let mut f = imported("asm_multisolid");
    f["parts"][2]["faces"] = json!(999);
    let r = clean(&doc_of(f));
    assert!(r.bodies.iter().all(|b| !b.name.contains("M3 Nut") && b.node_ref.is_none()));
    let reason = r
        .diagnostics
        .iter()
        .find(|d| d["kind"] == "import")
        .and_then(|d| d["reason"].as_str())
        .expect("the fallback was silent");
    assert!(reason.contains("999") && reason.contains('6'), "{reason}");
}

#[test]
fn explode_false_keeps_the_root_node() {
    let pay = imported("asm_nested");
    let exploded = clean(&doc_of(pay.clone()));
    let mut f = pay.clone();
    f.insert("explode".into(), json!(false));
    let r = clean(&doc_of(f));
    assert_eq!(r.bodies.len(), 1);
    let body = &r.bodies[0];
    let root = pay["nodes"].as_array().unwrap().iter().position(|n| n["parent"].is_null()).unwrap();
    assert_eq!(body.node_ref.as_deref(), Some(format!("f1/{root}").as_str()));
    assert_eq!(body.name, pay["nodes"][root]["name"].as_str().unwrap());
    let faces: usize = exploded.bodies.iter().map(|b| kernel::count(&b.shape, Kind::Face)).sum();
    assert_eq!(kernel::count(&body.shape, Kind::Face), faces, "debris dropping took parts of the collapsed import");
}

#[test]
fn a_missing_blob_without_a_fallback_says_what_to_do() {
    let mut f = imported("asm_flat");
    f.insert("geom".into(), json!("0".repeat(32)));
    let r = build(&doc_of(f));
    assert!(r.bodies.is_empty());
    let msg = r.errors[0].message.to_lowercase();
    assert!(msg.contains("missing") && (msg.contains(".funda") || msg.contains("re-import")), "{msg}");
}

#[test]
fn a_pre_v5_inline_brep_rebuilds_like_its_blob_and_migrates() {
    let pay = imported("asm_multisolid");
    let blob = BlobStore::open(blob_dir()).unwrap().get_bytes(pay["geom"].as_str().unwrap()).unwrap();
    let shape = fundacad_geom::features::import::blob_to_shape(&blob).unwrap();
    let path = blob_dir().join("legacy.brep");
    shape.write_brep_text(&path).unwrap();
    let text = std::fs::read(&path).unwrap();
    let body = text.strip_prefix(&b"DBRep_DrawableShape\n"[..]).unwrap_or(&text);
    let b64 = encode_b64(body);

    let mut legacy = pay.clone();
    legacy.remove("geom");
    legacy.insert("brep".into(), json!(b64));
    let from_blob = clean(&doc_of(pay.clone()));
    let from_inline = clean(&doc_of(legacy.clone()));
    let names = |r: &Rebuild| r.bodies.iter().map(|b| b.name.clone()).collect::<Vec<_>>();
    assert_eq!(names(&from_blob), names(&from_inline));

    let mut missing = legacy.clone();
    missing.insert("geom".into(), json!("f".repeat(32)));
    assert_eq!(names(&clean(&doc_of(missing))), names(&from_blob));

    let store = BlobStore::open(blob_dir()).unwrap();
    let out = fundacad_geom::features::import::migrate_geometry(
        &[json!({"id": "f1", "brep": b64}), json!({"id": "bad", "brep": "bm90IGEgYnJlcA=="})],
        &store,
    );
    let geom = out["items"][0]["geom"].as_str().unwrap();
    assert!(store.get_bytes(geom).is_some());
    assert_eq!(out["failed"][0]["id"], "bad");
    let mut migrated = legacy;
    migrated.remove("brep");
    migrated.insert("geom".into(), json!(geom));
    assert_eq!(names(&clean(&doc_of(migrated))), names(&from_blob));
}

#[test]
fn a_tampered_blob_is_refused_before_occt_reads_it() {
    let store = BlobStore::open(blob_dir()).unwrap();
    let digest = store.put_bytes(b"not a brep at all").unwrap();
    let mut f = imported("asm_flat");
    f.insert("geom".into(), json!(digest));
    let r = build(&doc_of(f));
    assert!(r.errors[0].message.contains("bad header"), "{:?}", r.errors);
}

fn encode_b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |a, (i, &b)| a | (u32::from(b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
