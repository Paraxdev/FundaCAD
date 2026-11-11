//! A helical cut taller than it is wide used to come out partly uncut from the sliced retry, with only an
//! advisory that whole cuts get too. The capsule holder's threads at a narrow tube are such cuts.

use fundacad_core::CadDocument;
use fundacad_geom::builder::{self, NoWatch, Rebuild};
use fundacad_geom::kernel;
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/helical_cut/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("json")
}

/// The same document with every helical revolve made turn by turn, which the kernel always cuts whole.
fn per_turn(doc: &Value) -> Value {
    let mut doc = doc.clone();
    let params = doc["parameters"].clone();
    let num =
        |v: &Value| v.as_str().map_or_else(|| v.as_f64().expect("number"), |k| params[k].as_f64().expect("parameter"));
    let features = doc["features"].as_array().expect("features").clone();
    let mut out: Vec<Value> = Vec::new();
    let mut helical = Vec::new();
    for f in &features {
        if f["type"] == "revolve" && f.get("pitch").is_some() {
            helical.push(f["id"].as_str().expect("id").to_owned());
            let sketch = features.iter().find(|s| s["id"] == f["sketch"]).expect("its sketch").clone();
            out.retain(|g| g["id"] != f["sketch"]);
            let (pitch, turns) = (num(&f["pitch"]), num(&f["angle"]) / 360.0);
            let mut k = 0.0;
            while k < turns - 1e-9 {
                let n = (turns - k).min(1.0);
                let mut s = sketch.clone();
                s["id"] = json!(format!("{}_{k}", f["sketch"].as_str().unwrap()));
                for e in s["entities"].as_array_mut().unwrap() {
                    for c in ["x1", "x2"] {
                        e[c] = json!(num(&e[c]));
                    }
                    for c in ["y1", "y2"] {
                        e[c] = json!(num(&e[c]) + k * pitch);
                    }
                }
                let mut r = f.clone();
                r["id"] = json!(format!("{}_{k}", f["id"].as_str().unwrap()));
                r["sketch"] = s["id"].clone();
                r["angle"] = json!(360.0 * n);
                out.push(s);
                out.push(r);
                k += n;
            }
        } else {
            out.push(f.clone());
        }
    }
    doc["features"] = json!(out);
    let defs = doc["paramDefs"].as_object_mut().expect("paramDefs");
    defs.retain(|_, d| !helical.iter().any(|h| d["target"]["feature"] == h.as_str()));
    doc
}

fn build(doc: &Value) -> Rebuild {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let typed: CadDocument = serde_json::from_value(doc.clone()).expect("document parses");
    builder::rebuild(&typed, doc, &NoWatch).expect("not cancelled")
}

fn volume(r: &Rebuild, body: &str) -> f64 {
    let b = r.bodies.iter().find(|b| b.name == body).unwrap_or_else(|| panic!("no body {body}"));
    kernel::volume_precise(&b.shape).abs()
}

fn warned(r: &Rebuild) -> Vec<Value> {
    r.diagnostics.iter().filter(|d| d["code"] == "partialCut").cloned().collect()
}

/// What the helical cut left on a body beyond the per-turn reference, in mm3.
fn left_uncut(name: &str, body: &str) -> f64 {
    let doc = fixture(name);
    let built = build(&doc);
    let reference = build(&per_turn(&doc));
    for r in [&built, &reference] {
        let real: Vec<_> = r.errors.iter().filter(|e| !e.message.contains("removed nothing")).collect();
        assert!(real.is_empty(), "{name}: {:?}", real.iter().map(|e| &e.message).collect::<Vec<_>>());
    }
    volume(&built, body) - volume(&reference, body)
}

#[test]
fn a_helical_cut_taller_than_wide_is_cut_whole() {
    // Tool height against width: d12 cap 17.9 against 17.3, d14 with a longer thread tube 19.7 against 19.2,
    // and its cap 23.9 against 19.3. Uncut before: 71.7, 196.1 and 162.0 mm3.
    for (name, body) in
        [("d12", "Cap"), ("d14t18", "Tube"), ("d14t18", "Cap"), ("d16t16", "Cap"), ("d8t18", "Cap"), ("d8t18", "Tube")]
    {
        let left = left_uncut(name, body);
        assert!(left.abs() < 1.0, "{name} {body}: {left:.2} mm3 left uncut");
    }
}

#[test]
fn a_helical_cut_wider_than_tall_stays_whole_and_unwarned() {
    let doc = fixture("d20");
    let built = build(&doc);
    assert_eq!(warned(&built), Vec::<Value>::new());
    let left = left_uncut("d20", "Cap");
    assert!(left.abs() < 1.0, "{left:.2} mm3 left uncut");
    for body in ["Cap", "Tube"] {
        let left = left_uncut("d30t18", body);
        assert!(left.abs() < 1.0, "d30t18 {body}: {left:.2} mm3 left uncut");
    }
}

#[test]
fn a_helical_cut_made_whole_does_not_warn() {
    for name in ["d12", "d14t18", "d16t16", "d8t18", "d30t18"] {
        assert_eq!(warned(&build(&fixture(name))), Vec::<Value>::new(), "{name}");
    }
}
