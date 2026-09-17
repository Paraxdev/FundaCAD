//! The `listFonts` and `tessellateText` ops through the engine's request loop,
//! server.py `_list_fonts_job` and `_tessellate_text_job`.

use fundacad_engine::{Engine, Outbox};
use fundacad_geom::jobs::GeomJobs;
use fundacad_protocol::Message;
use serde_json::{json, Value};
use std::io;
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
        Client {
            engine: Engine::start(GeomJobs, Arc::new(Channel(Mutex::new(tx)))),
            rx,
        }
    }

    fn call(&self, req: Value) -> Value {
        self.engine.handle(Message::Text(req.to_string()));
        loop {
            let Message::Text(t) = self.rx.recv().unwrap() else {
                continue;
            };
            let v: Value = serde_json::from_str(&t).unwrap();
            if v.get("ok").is_some() {
                return v["result"].clone();
            }
        }
    }
}

#[test]
fn list_fonts_answers_a_sorted_family_list() {
    let c = Client::new();
    let r = c.call(json!({"id": 1, "op": "listFonts"}));
    let families = r["families"].as_array().cloned().unwrap_or_default();
    assert_eq!(r.as_object().map(|m| m.len()), Some(1), "only families");
    let names: Vec<&str> = families.iter().filter_map(Value::as_str).collect();
    assert!(names.windows(2).all(|w| w[0] <= w[1]), "sorted");
    assert_eq!(
        names.len(),
        names.iter().collect::<std::collections::HashSet<_>>().len(),
        "deduplicated"
    );
}

#[test]
fn tessellate_text_gives_outer_contours_and_counters() {
    let c = Client::new();
    let r = c.call(json!({"id": 2, "op": "tessellateText",
        "entity": {"type": "text", "text": "oB", "height": 10, "font": "Arial"}}));
    let faces = r["faces"].as_array().cloned().unwrap_or_default();
    if faces.is_empty() {
        eprintln!("skipped: no usable system font on this machine");
        return;
    }
    assert_eq!(faces.len(), 2, "one face per glyph: {r}");
    let holes: Vec<usize> = faces
        .iter()
        .map(|f| f["holes"].as_array().map_or(0, Vec::len))
        .collect();
    assert_eq!(holes, vec![1, 2], "an o has one counter, a B has two");
    for f in &faces {
        let outer = f["outer"].as_array().cloned().unwrap_or_default();
        assert!(outer.len() > 3, "a sampled contour");
        assert_eq!(outer.first(), outer.last(), "the loop closes");
    }
}

#[test]
fn a_text_that_cannot_be_drawn_is_an_empty_face_list() {
    let c = Client::new();
    let blank = c.call(json!({"id": 3, "op": "tessellateText",
        "entity": {"type": "text", "text": "   ", "height": 10}}));
    assert_eq!(blank, json!({"faces": []}));
    // No height at all: `_text_faces` catches the KeyError and draws nothing.
    let no_height = c.call(json!({"id": 4, "op": "tessellateText",
        "entity": {"type": "text", "text": "x"}}));
    assert_eq!(no_height, json!({"faces": []}));
}
