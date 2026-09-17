//! tests/vectors/body_ids.json and tests/vectors/face_colors.json, recorded from
//! sidecar/body_ids.py and sidecar/face_colors.py and also replayed by
//! sidecar/tests/test_shared_vectors.py and tests/document/faceColorVectors.test.ts.

use std::path::Path;

use fundacad_core::body_ids::{number, BodyIds, Event};
use fundacad_core::face_colors::{decode, decode_value, dominant, encode};
use fundacad_core::schema::FaceColorRuns;
use indexmap::IndexMap;
use serde_json::Value;

fn vectors(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/vectors")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse")
}

fn colors(v: &Value) -> Vec<Option<String>> {
    serde_json::from_value(v.clone()).expect("colors")
}

fn recorded(v: &Value) -> Option<IndexMap<String, String>> {
    match v {
        Value::Object(_) => Some(serde_json::from_value(v.clone()).expect("map")),
        _ => None,
    }
}

fn events(v: &Value) -> Vec<Event> {
    v.as_array()
        .expect("events")
        .iter()
        .map(|e| Event {
            key: e[0].as_str().expect("key").to_owned(),
            inherit: e[1].as_str().map(str::to_owned),
            id: e[2].as_str().expect("id").to_owned(),
        })
        .collect()
}

#[test]
fn body_ids() {
    let v = vectors("body_ids.json");
    for pair in v["number"].as_array().expect("number") {
        assert_eq!(
            Some(number(pair[0].as_str().expect("id"))),
            pair[1].as_u64(),
            "{pair}"
        );
    }
    for s in v["sessions"].as_array().expect("sessions") {
        let name = s["name"].as_str().expect("name");
        let mut ids = BodyIds::new(recorded(&s["recorded"]));
        for (step, want) in s["steps"]
            .as_array()
            .expect("steps")
            .iter()
            .zip(s["results"].as_array().expect("results"))
        {
            let arg = step[1].as_str();
            let got = match step[0].as_str().expect("op") {
                "start" => {
                    ids.start_feature(arg.expect("feature"));
                    continue;
                }
                "key" => {
                    let k = ids.key(None);
                    let id = ids.assign(&k, None);
                    (k, id)
                }
                "keyNode" => {
                    let k = ids.key(arg);
                    let id = ids.assign(&k, None);
                    (k, id)
                }
                "keyInherit" => {
                    let k = ids.key(None);
                    let id = ids.assign(&k, arg);
                    (k, id)
                }
                other => panic!("{name}: step {other}"),
            };
            assert_eq!(
                (got.0.as_str(), got.1.as_str()),
                (want[0].as_str().expect("k"), want[1].as_str().expect("id")),
                "{name}"
            );
        }
        assert_eq!(ids.events(), events(&s["events"]).as_slice(), "{name}");
        let map: IndexMap<String, String> =
            serde_json::from_value(s["resultingMap"].clone()).expect("map");
        assert_eq!(ids.resulting_map(), map, "{name}");
    }
    for r in v["restore"].as_array().expect("restore") {
        let mut ids = BodyIds::new(recorded(&r["recorded"]));
        assert_eq!(
            Some(ids.restore(&events(&r["events"]))),
            r["expect"].as_bool(),
            "{}",
            r["name"]
        );
    }
}

#[test]
fn face_colors() {
    let v = vectors("face_colors.json");
    for c in v["encode"].as_array().expect("encode") {
        let list = colors(&c["colors"]);
        let packed = encode(&list);
        assert_eq!(
            serde_json::to_value(&packed).expect("json"),
            c["packed"],
            "{}",
            c["name"]
        );
        if let Some(p) = &packed {
            assert_eq!(decode(Some(p), list.len()), list, "{}", c["name"]);
        }
    }
    for c in v["decode"].as_array().expect("decode") {
        let count = usize::try_from(c["count"].as_u64().expect("count")).expect("fits");
        let want = colors(&c["colors"]);
        assert_eq!(
            decode_value(Some(&c["packed"]), count),
            want,
            "{}",
            c["packed"]
        );
        if let Ok(typed) = serde_json::from_value::<FaceColorRuns>(c["packed"].clone()) {
            assert_eq!(decode(Some(&typed), count), want, "{}", c["packed"]);
        }
    }
    for c in v["dominant"].as_array().expect("dominant") {
        assert_eq!(
            dominant(&colors(&c["colors"])),
            c["dominant"].as_str().map(str::to_owned),
            "{}",
            c["colors"]
        );
    }
}
