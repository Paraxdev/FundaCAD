//! Byte equality against the Python engine's `wire.py`, on the fixtures
//! `tests/golden/gen_golden.py on the legacy branch` wrote from the Python encoders.

use fundacad_protocol::body::{Edge, FullBody, JobResult, MeshResult, WireBody};
use fundacad_protocol::stream::{send_reply, CancelToken, ReplyOptions};
use fundacad_protocol::{envelope, frame, pyjson, stdio, Limits, Message};
use serde_json::{Map, Value};
use std::io::Cursor;
use std::path::PathBuf;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
}

fn load_json(name: &str) -> Value {
    let text = std::fs::read_to_string(golden_dir().join(name)).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn f32s(v: &Value) -> Vec<f32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap() as f32)
        .collect()
}

fn u32s(v: &Value) -> Vec<u32> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap() as u32)
        .collect()
}

fn body_from_json(m: &Map<String, Value>) -> WireBody {
    if pyjson::truthy(m.get("unchanged")) {
        return WireBody::Stub(m.clone());
    }
    let edges = m
        .get("edges")
        .and_then(Value::as_array)
        .map(|es| {
            es.iter()
                .map(|e| Edge {
                    points: e["points"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|p| {
                            let p = f32s(p);
                            [p[0], p[1], p[2]]
                        })
                        .collect(),
                    smooth: pyjson::truthy(e.get("smooth")),
                })
                .collect()
        })
        .unwrap_or_default();
    WireBody::Full(FullBody {
        fields: m.clone(),
        positions: f32s(&m["positions"]),
        normals: m.get("normals").map(f32s),
        indices: u32s(&m["indices"]),
        face_ids: u32s(&m["faceIds"]),
        edges,
    })
}

fn result_from_json(v: &Value) -> JobResult {
    let m = v.as_object().unwrap().clone();
    match m.get("bodies").and_then(Value::as_array) {
        Some(bodies) => {
            let bodies = bodies
                .iter()
                .map(|b| body_from_json(b.as_object().unwrap()))
                .collect();
            JobResult::Mesh(MeshResult { fields: m, bodies })
        }
        None => JobResult::Json(m),
    }
}

fn run_case(case: &Value) -> Vec<Message> {
    let id = case["id"].clone();
    let text = |s: String| vec![Message::Text(s)];
    let mut limits = Limits::default();
    if let Some(l) = case.get("limits") {
        if let Some(n) = l.get("max_frame").and_then(Value::as_u64) {
            limits.max_frame = n as usize;
        }
        if let Some(n) = l.get("chunk_target").and_then(Value::as_u64) {
            limits.chunk_target = n as usize;
        }
    }
    match case["kind"].as_str().unwrap() {
        "reply_for" => text(envelope::reply_for(
            &id,
            case["result"].as_object().unwrap(),
        )),
        "err" => {
            let fid = case.get("feature_id").filter(|v| !v.is_null());
            text(envelope::err(&id, case["message"].as_str().unwrap(), fid))
        }
        "building" => {
            let f = &case["frame"];
            text(envelope::building(
                &id,
                f[0].as_i64().unwrap(),
                f[1].as_i64().unwrap(),
                f[2].as_i64().unwrap(),
            ))
        }
        "importing" => {
            let f = &case["frame"];
            text(envelope::importing(
                &id,
                f[0].as_i64().unwrap(),
                f[1].as_str().unwrap(),
                f[2].as_i64().unwrap(),
            ))
        }
        "send_reply" => {
            let opts = ReplyOptions {
                binary: case["binary"].as_bool().unwrap(),
                chunked: case["chunked"].as_bool().unwrap(),
            };
            let result = result_from_json(&case["result"]);
            let token = CancelToken::new();
            let cancel_after = case.get("cancel_after").and_then(Value::as_u64);
            let reply = match (&result, case.get("sid").and_then(Value::as_str)) {
                // The sid is random in both encoders, the fixture pins it.
                (JobResult::Mesh(m), Some(sid)) if opts.binary && opts.chunked => {
                    let n = m.bodies.len();
                    match fundacad_protocol::stream::stream_reply(
                        id.clone(),
                        m.clone(),
                        sid.to_string(),
                        Some(token.clone()),
                        limits,
                    ) {
                        Ok(r) => r,
                        Err(over) => {
                            return text(frame::too_large_error(&id, over.size, n, &limits))
                        }
                    }
                }
                _ => send_reply(id.clone(), result, opts, Some(token.clone()), limits),
            };
            let mut out = Vec::new();
            for m in reply {
                out.push(m);
                if cancel_after.is_some_and(|n| out.len() as u64 >= n) {
                    token.cancel();
                }
            }
            out
        }
        other => panic!("unknown case kind {other}"),
    }
}

fn describe_first_difference(want: &[u8], got: &[u8]) -> String {
    let at = want
        .iter()
        .zip(got)
        .position(|(a, b)| a != b)
        .unwrap_or(want.len().min(got.len()));
    let lo = at.saturating_sub(40);
    format!(
        "differs at byte {at} (want {} bytes, got {})\nwant: {:?}\n got: {:?}",
        want.len(),
        got.len(),
        String::from_utf8_lossy(&want[lo..(at + 60).min(want.len())]),
        String::from_utf8_lossy(&got[lo..(at + 60).min(got.len())]),
    )
}

#[test]
fn replies_match_wire_py_byte_for_byte() {
    let inputs = load_json("inputs.json");
    let cases = inputs["cases"].as_array().unwrap();
    assert!(cases.len() >= 15);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let want = std::fs::read(golden_dir().join(format!("{name}.bin"))).unwrap();
        let mut got = Vec::new();
        for m in run_case(case) {
            stdio::write_message(&mut got, &m).unwrap();
        }
        assert!(
            want == got,
            "case {name}: {}",
            describe_first_difference(&want, &got)
        );

        // The Python-written framing reads back through the Rust reader too.
        let mut cur = Cursor::new(&want);
        let mut n = 0;
        while let Some(m) = stdio::read_message(&mut cur).unwrap() {
            assert!(
                stdio::message_id(&m).is_some() || case["id"].is_null(),
                "case {name}: no id"
            );
            n += 1;
        }
        assert!(n >= 1);
    }
}

#[test]
fn float_repr_matches_python() {
    let vectors = load_json("vectors.json");
    for v in vectors["floats"].as_array().unwrap() {
        let bits = u64::from_str_radix(v["bits"].as_str().unwrap(), 16).unwrap();
        let mut s = String::new();
        pyjson::write_float(&mut s, f64::from_bits(bits));
        assert_eq!(s, v["repr"].as_str().unwrap(), "bits {bits:016x}");
    }
}

#[test]
fn size_text_matches_sysmem_describe() {
    let vectors = load_json("vectors.json");
    for v in vectors["sizes"].as_array().unwrap() {
        let n = v["n"].as_u64().unwrap() as usize;
        assert_eq!(
            frame::describe_size(n),
            v["text"].as_str().unwrap(),
            "{n} bytes"
        );
    }
}
