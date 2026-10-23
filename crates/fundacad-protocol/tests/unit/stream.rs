use fundacad_protocol::body::FullBody;
use fundacad_protocol::body::{JobResult, MeshResult, WireBody};
use fundacad_protocol::envelope;
use fundacad_protocol::frame::Limits;
use fundacad_protocol::stdio::Message;
use fundacad_protocol::stream::*;
use serde_json::Value;
use serde_json::{json, Map};

fn full(id: &str, n: usize) -> WireBody {
    let mut b = FullBody::new(id, id, "e");
    b.positions = vec![0.5; 3 * n];
    b.indices = vec![0; 3 * n];
    b.face_ids = vec![0; n];
    WireBody::Full(b)
}

fn header(frame: &[u8]) -> Value {
    let hl = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    serde_json::from_slice(&frame[4..4 + hl]).unwrap_or(Value::Null)
}

#[test]
fn chunks_keep_order_and_isolate_big_bodies() {
    let bodies = vec![full("a", 1), full("b", 1), full("c", 100), full("d", 1)];
    let sizes: Vec<usize> = bodies.iter().map(WireBody::wire_size).collect();
    assert_eq!(sizes[0], 4 * 7 + 256);
    assert_eq!(chunk_bodies(&bodies, 600), vec![0..2, 2..3, 3..4]);
    assert!(chunk_bodies(&[], 600).is_empty());
}

#[test]
fn stream_shape() {
    let res =
        MeshResult { fields: Map::new(), bodies: vec![full("a", 1), full("b", 1), WireBody::stub("s", "S", "x")] };
    let limits = Limits { max_frame: 1 << 20, chunk_target: 300 };
    let msgs: Vec<Message> =
        stream_reply(json!("r"), res, "sid".into(), None, limits).map(Iterator::collect).unwrap_or_default();
    assert_eq!(msgs.len(), 4);
    let heads: Vec<Value> = msgs
        .iter()
        .map(|m| match m {
            Message::Binary(b) => header(b),
            Message::Text(_) => Value::Null,
        })
        .collect();
    assert_eq!(heads[0]["status"], json!("chunk"));
    assert_eq!(heads[0]["result"]["manifest"].as_array().map(Vec::len), Some(3));
    assert_eq!(heads[3]["ok"], json!(true));
    assert_eq!(heads[3]["stream"]["seq"], json!(3));
    assert!(heads[3].get("status").is_none());
}

#[test]
fn empty_stream_is_one_final_head() {
    let res = MeshResult::default();
    let msgs: Vec<Message> = send_reply(
        json!("r"),
        JobResult::Mesh(res),
        ReplyOptions { binary: true, chunked: true },
        None,
        Limits::default(),
    )
    .collect();
    assert_eq!(msgs.len(), 1);
    match &msgs[0] {
        Message::Binary(b) => assert_eq!(header(b)["stream"]["final"], json!(true)),
        Message::Text(_) => panic!("expected a frame"),
    }
}

#[test]
fn cancel_between_chunks() {
    let token = CancelToken::new();
    let res = MeshResult { fields: Map::new(), bodies: vec![full("a", 1), full("b", 1)] };
    let limits = Limits { max_frame: 1 << 20, chunk_target: 1 };
    let mut reply = send_reply(
        json!("r"),
        JobResult::Mesh(res),
        ReplyOptions { binary: true, chunked: true },
        Some(token.clone()),
        limits,
    );
    assert!(matches!(reply.next(), Some(Message::Binary(_))));
    assert!(matches!(reply.next(), Some(Message::Binary(_))));
    token.cancel();
    assert_eq!(reply.next(), Some(Message::Text(envelope::cancelled(&json!("r")))));
    assert_eq!(reply.next(), None);
}

#[test]
fn stream_ids_differ() {
    let a = new_stream_id();
    assert_eq!(a.len(), 16);
    assert_ne!(a, new_stream_id());
}
