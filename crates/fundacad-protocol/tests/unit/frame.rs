use fundacad_protocol::body::{Edge, FullBody, JobResult, MeshResult, WireBody};
use fundacad_protocol::envelope;
use fundacad_protocol::frame::*;
use fundacad_protocol::stdio::Message;
use serde_json::{json, Map, Value};

fn body() -> FullBody {
    let mut b = FullBody::new("b1", "Body1", "e1");
    b.positions = vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
    b.indices = vec![0, 1, 2];
    b.face_ids = vec![0];
    b.edges = vec![
        Edge { points: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], smooth: false },
        Edge { points: vec![[1.0, 1.0, 1.0]], smooth: true },
    ];
    b
}

#[test]
fn frame_layout_decodes() {
    let res = MeshResult { fields: Map::new(), bodies: vec![WireBody::Full(body())] };
    let frame = encode_binary_reply(&json!("r"), &res, &Limits::default()).expect("fits");
    let hl = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    let header: Value = serde_json::from_slice(&frame[4..4 + hl]).expect("json");
    let mut off = 4 + hl + (4 - hl % 4) % 4;
    assert_eq!(off % 4, 0);
    let bufs = header["result"]["$buffers"].as_array().expect("buffers");
    let lens: Vec<u64> = bufs.iter().map(|b| b["len"].as_u64().unwrap_or(0)).collect();
    assert_eq!(lens, vec![9, 3, 1, 9, 2]);
    off += 4 * lens.iter().sum::<u64>() as usize;
    assert_eq!(off, frame.len());
    let edges = &header["result"]["bodies"][0]["edges"];
    assert_eq!(edges["smooth"], json!([1]));
    assert_eq!(edges["body"], json!("b1"));
    assert!(header["result"]["bodies"][0].get("normals").is_none());
}

#[test]
fn decoded_frame_is_the_text_reply() {
    let res = MeshResult { fields: Map::new(), bodies: vec![WireBody::Full(body())] };
    let frame = encode_binary_reply(&json!("r"), &res, &Limits::default()).expect("fits");
    let decoded = decode_frame(&frame).expect("decodes");
    let text: Value =
        serde_json::from_str(&envelope::reply_for(&json!("r"), &JobResult::Mesh(res).to_json())).expect("json");
    assert_eq!(decoded, text);
}

#[test]
fn too_large_refuses() {
    let res = MeshResult { fields: Map::new(), bodies: vec![WireBody::Full(body())] };
    let limits = Limits { max_frame: 64, chunk_target: 16 };
    let msg = reply_bytes(&json!("r"), &JobResult::Mesh(res), true, &limits);
    match msg {
        Message::Text(t) => {
            assert!(t.contains("too detailed to display: the rebuilt geometry"))
        }
        Message::Binary(_) => panic!("expected an error"),
    }
}

#[test]
fn sizes_and_thousands() {
    assert_eq!(describe_size(512), "512 B");
    assert_eq!(describe_size(2560), "2 KiB");
    assert_eq!(describe_size(MAX_FRAME), "128 MiB");
    assert_eq!(describe_size(3 * 1024 * 1024 * 1024 / 2), "1.5 GiB");
    let across = |n| too_large_error(&json!("r"), 0, n, &Limits::default());
    assert!(across(1234567).contains("across 1,234,567 bodies"));
    assert!(across(999).contains("across 999 bodies"));
}
