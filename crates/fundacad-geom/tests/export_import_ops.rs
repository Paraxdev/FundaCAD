//! The `export` and `import` ops through the engine's request loop, the way a
//! client sends them: JSON text in, the reply envelope out.

use fundacad_engine::{Engine, Outbox};
use fundacad_geom::jobs::GeomJobs;
use fundacad_protocol::Message;
use serde_json::{json, Value};
use std::io;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

struct Channel(Mutex<Sender<Message>>);

impl Outbox for Channel {
    fn send(&self, msgs: &mut dyn Iterator<Item = Message>) -> io::Result<()> {
        let tx = self.0.lock().unwrap();
        for m in msgs {
            let _ = tx.send(m);
        }
        Ok(())
    }
}

struct Client {
    engine: Engine,
    rx: Receiver<Message>,
}

impl Client {
    fn new() -> Client {
        let (tx, rx) = channel();
        Client { engine: Engine::start(GeomJobs, Arc::new(Channel(Mutex::new(tx)))), rx }
    }

    fn call(&self, req: Value) -> Value {
        self.engine.handle(Message::Text(req.to_string()));
        loop {
            let Message::Text(t) = self.rx.recv().unwrap() else { continue };
            let v: Value = serde_json::from_str(&t).unwrap();
            if v.get("ok").is_some() {
                return v;
            }
        }
    }
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("fundacad-ops-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn two_bodies() -> Value {
    json!({"features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b", "type": "sphere", "radius": 4},
        {"id": "m", "type": "move", "x": 30},
    ]})
}

fn p(dir: &PathBuf, file: &str) -> String {
    dir.join(file).to_string_lossy().into_owned()
}

fn glb_json(path: &str) -> Value {
    let raw = std::fs::read(path).unwrap();
    let len = u32::from_le_bytes(raw[12..16].try_into().unwrap()) as usize;
    serde_json::from_slice(&raw[20..20 + len]).unwrap()
}

#[test]
fn export_writes_every_mesh_format() {
    let c = Client::new();
    let dir = scratch("formats");
    let stl = p(&dir, "part.stl");
    let r = c.call(json!({"id": 1, "op": "export", "document": two_bodies(), "format": "stl", "path": stl}));
    assert_eq!(r, json!({"id": 1, "ok": true, "result": {"path": stl}}));
    let raw = std::fs::read(&stl).unwrap();
    let ntri = u32::from_le_bytes(raw[80..84].try_into().unwrap()) as usize;
    assert!(ntri > 12 && raw.len() == 84 + 50 * ntri, "{ntri}");

    let ascii = p(&dir, "part_ascii.stl");
    let r = c.call(json!({"id": 2, "op": "export", "document": two_bodies(), "format": "stl", "path": ascii,
        "mesh": {"binary": false, "unit": "cm", "surfaceDeviation": 0.5}}));
    assert_eq!(r["ok"], true, "{r}");
    let text = std::fs::read_to_string(&ascii).unwrap();
    assert!(text.starts_with("solid FundaCAD\nfacet normal "));
    assert!(text.contains("vertex 5.000000e-01 "), "positions are in centimetres");

    let threemf = p(&dir, "part.3mf");
    let r = c.call(json!({"id": 3, "op": "export", "document": two_bodies(), "format": "3mf", "path": threemf,
        "mesh": {"unit": "in", "maxEdgeLength": 2}}));
    assert_eq!(r["ok"], true, "{r}");
    let mut z = zip::ZipArchive::new(std::fs::File::open(&threemf).unwrap()).unwrap();
    let mut model = String::new();
    io::Read::read_to_string(&mut z.by_name("3D/3dmodel.model").unwrap(), &mut model).unwrap();
    assert!(model.contains("<model unit=\"inch\""));

    let glb = p(&dir, "part.glb");
    let doc = two_bodies();
    let r = c.call(json!({"id": 4, "op": "export", "document": doc, "format": "glb", "path": glb,
        "palette": [{"color": "#ff0000"}, {"color": "00ff00"}], "bodyColors": {"body2": 1}}));
    assert_eq!(r["ok"], true, "{r}");
    let j = glb_json(&glb);
    let names: Vec<&str> = j["meshes"].as_array().unwrap().iter().map(|m| m["name"].as_str().unwrap()).collect();
    assert_eq!(names.len(), 2);
    let colors: Vec<&Value> =
        j["materials"].as_array().unwrap().iter().map(|m| &m["pbrMetallicRoughness"]["baseColorFactor"]).collect();
    assert_eq!(colors[0], &json!([1.0, 0.0, 0.0, 1.0]));
    assert_eq!(colors[1], &json!([0.0, 1.0, 0.0, 1.0]));
}

#[test]
fn export_one_body_separate_bodies_and_refusals() {
    let c = Client::new();
    let dir = scratch("separate");
    let base = p(&dir, "parts.step");
    let r = c.call(json!({"id": 1, "op": "export", "document": two_bodies(), "format": "step", "path": base, "separate": true}));
    assert_eq!(r["ok"], true, "{r}");
    let folder = p(&dir, "parts");
    assert_eq!(r["result"]["path"], folder);
    let paths = r["result"]["paths"].as_array().unwrap();
    assert_eq!(paths.len(), 2);
    for f in paths {
        assert!(std::fs::metadata(f.as_str().unwrap()).unwrap().len() > 1000);
    }
    let again = c.call(json!({"id": 2, "op": "export", "document": two_bodies(), "format": "step", "path": base, "separate": true}));
    assert_eq!(
        again,
        json!({"id": 2, "ok": false, "error": {"message":
            "parts already exists, the separate-bodies export writes a folder of that name. Choose another name, or move the existing folder."}})
    );

    let one = p(&dir, "one.stl");
    let r = c.call(json!({"id": 3, "op": "export", "document": two_bodies(), "format": "stl", "path": one, "body": "nope"}));
    assert_eq!(r["error"]["message"], "body 'nope' not found to export");

    let r = c.call(json!({"id": 4, "op": "export", "document": two_bodies(), "format": "obj", "path": one}));
    assert_eq!(r["error"]["message"], "unknown export format: obj");

    let broken = json!({"features": [{"id": "x", "type": "box", "length": 0, "width": 1, "height": 1}]});
    let r = c.call(json!({"id": 5, "op": "export", "document": broken, "format": "stl", "path": one}));
    assert_eq!(
        r,
        json!({"id": 5, "ok": false, "error": {"message": "Box: length must be greater than 0 (got 0)", "feature_id": "x"}})
    );

    let partly = json!({"features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "s", "type": "shell", "thickness": 0},
    ]});
    let r = c.call(json!({"id": 6, "op": "export", "document": partly, "format": "stl", "path": one}));
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["result"]["warnings"][0]["feature_id"], "s");
}

#[test]
fn step_round_trips_through_export_and_import() {
    std::env::set_var("FUNDACAD_BLOB_DIR", scratch("blobs"));
    let c = Client::new();
    let dir = scratch("roundtrip");
    let path = p(&dir, "Model Two.step");
    let r = c.call(json!({"id": 1, "op": "export", "document": two_bodies(), "format": "step", "path": path}));
    assert_eq!(r["ok"], true, "{r}");
    let r = c.call(json!({"id": 2, "op": "import", "format": "step", "path": path}));
    assert_eq!(r["ok"], true, "{r}");
    let res = &r["result"];
    assert_eq!(res["name"], "Model Two");
    assert_eq!(res["solid"], true);
    assert_eq!(res["faces"], 7);
    assert_eq!(res["nodes"][0], json!({"name": "Model Two", "parent": null}));
    assert_eq!(res["nodes"].as_array().unwrap().len(), 3);
    assert_eq!(res["parts"].as_array().unwrap().len(), 2);
    let blob = std::env::var("FUNDACAD_BLOB_DIR").unwrap();
    let geom = res["geom"].as_str().unwrap();
    assert!(PathBuf::from(blob).join(format!("{geom}.bbrep")).exists());

    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/asm_colors.step");
    let r = c.call(json!({"id": 3, "op": "import", "format": "STEP", "path": fixture}));
    assert_eq!(r["result"]["parts"][0], json!({"node": 1, "faces": 6, "color": "#e51919"}));

    let r = c.call(json!({"id": 4, "op": "import", "format": "iges", "path": fixture}));
    assert_eq!(r, json!({"id": 4, "ok": false, "error": {"message": "unsupported import format: iges"}}));
}
