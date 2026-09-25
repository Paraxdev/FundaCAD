//! The blob ops read and write the same store `import` publishes to and a
//! rebuild reads from, with the environment a private engine gets: a cache
//! directory of its own and no data directory named at all.

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

fn call(engine: &Engine, rx: &Receiver<Message>, req: Value) -> Value {
    engine.handle(Message::Text(req.to_string()));
    loop {
        match rx.recv().unwrap() {
            Message::Text(t) => {
                let v: Value = serde_json::from_str(&t).unwrap();
                if v.get("ok").is_some() {
                    return v;
                }
            }
            Message::Binary(b) => return fundacad_protocol::frame::decode_frame(&b).unwrap(),
        }
    }
}

#[test]
fn blob_ops_find_what_import_stored_with_only_a_cache_dir_set() {
    let root = std::env::temp_dir().join(format!("fundacad-blobops-env-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (home, cache, work) = (root.join("home"), root.join("cache"), root.join("work"));
    for d in [&home, &cache, &work] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::env::remove_var("FUNDACAD_BLOB_DIR");
    std::env::remove_var("XDG_DATA_HOME");
    std::env::set_var("XDG_CACHE_HOME", &cache);
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);

    let (tx, rx) = channel();
    let engine = Engine::start(GeomJobs, Arc::new(Channel(Mutex::new(tx))));
    let step: PathBuf = work.join("two.step");
    let doc = json!({"features": [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "b", "type": "sphere", "radius": 4},
        {"id": "m", "type": "move", "x": 30},
    ]});
    let r = call(&engine, &rx, json!({"id": "1", "op": "export", "document": doc, "format": "step", "path": step}));
    assert_eq!(r["ok"], true, "{r}");
    let r = call(&engine, &rx, json!({"id": "2", "op": "import", "format": "step", "path": step}));
    assert_eq!(r["ok"], true, "{r}");
    let imported = r["result"].clone();
    let geom = imported["geom"].as_str().unwrap().to_string();

    let r = call(&engine, &rx, json!({"id": "3", "op": "blobHas", "hashes": [geom]}));
    assert_eq!(r["result"]["have"], json!([geom]), "{r}");
    let r = call(&engine, &rx, json!({"id": "4", "op": "blobRead", "hash": geom, "offset": 0}));
    let size = r["result"]["size"].as_u64().unwrap();
    assert!(size > 0, "{r}");
    let on_disk = home.join(".local/share/fundacad/blobs").join(format!("{geom}.bbrep"));
    assert_eq!(std::fs::metadata(&on_disk).unwrap().len(), size);

    let mut feature = imported.as_object().unwrap().clone();
    feature.insert("id".into(), json!("f1"));
    feature.insert("type".into(), json!("import"));
    let doc = json!({"features": [Value::Object(feature)]});
    let r = call(&engine, &rx, json!({"id": "5", "op": "rebuild", "document": doc}));
    assert_eq!(r["ok"], true, "{r}");
    assert!(r["result"]["featureErrors"].as_array().map_or(true, Vec::is_empty), "{r}");
    let _ = std::fs::remove_dir_all(&root);
}
