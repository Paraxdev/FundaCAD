use fundacad_protocol::stdio::*;
use serde_json::json;
use std::io::Cursor;
use std::io::ErrorKind;

#[test]
fn round_trip_and_clean_eof() {
    let msgs = [Message::Text("{\"id\": \"a\"}".into()), Message::Binary(vec![1, 2, 3]), Message::Text(String::new())];
    let mut buf = Vec::new();
    for m in &msgs {
        write_message(&mut buf, m).expect("write");
    }
    assert_eq!(&buf[..5], &[11, 0, 0, 0, KIND_TEXT]);
    let mut cur = Cursor::new(buf);
    for m in &msgs {
        assert_eq!(read_message(&mut cur).expect("read").as_ref(), Some(m));
    }
    assert_eq!(read_message(&mut cur).expect("eof"), None);
}

#[test]
fn truncation_and_garbage_are_errors() {
    let mut buf = Vec::new();
    write_message(&mut buf, &Message::Binary(vec![9; 10])).expect("write");
    let e = read_message(&mut Cursor::new(&buf[..8])).expect_err("truncated payload");
    assert_eq!(e.kind(), ErrorKind::UnexpectedEof);
    let e = read_message(&mut Cursor::new(&buf[..3])).expect_err("truncated header");
    assert_eq!(e.kind(), ErrorKind::UnexpectedEof);
    let e = read_message(&mut Cursor::new([1u8, 0, 0, 0, 7, 0])).expect_err("kind");
    assert_eq!(e.kind(), ErrorKind::InvalidData);
    let e = read_message_limited(&mut Cursor::new(&buf), 4).expect_err("limit");
    assert_eq!(e.kind(), ErrorKind::InvalidData);
    let e = read_message(&mut Cursor::new([1u8, 0, 0, 0, KIND_TEXT, 0xff])).expect_err("utf8");
    assert_eq!(e.kind(), ErrorKind::InvalidData);
}

#[test]
fn ids_from_both_kinds() {
    let text = Message::Text(r#"{"op": "rebuild", "big": [1, 2, {"id": "inner"}], "id": "r7"}"#.into());
    assert_eq!(message_id(&text), Some(json!("r7")));
    let header = br#"{"id": 12, "ok": true}"#;
    let mut frame = (header.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(header);
    frame.extend_from_slice(&[0, 0, 1, 2, 3, 4]);
    assert_eq!(message_id(&Message::Binary(frame)), Some(json!(12)));
    assert_eq!(message_id(&Message::Text(r#"{"id": null}"#.into())), None);
    assert_eq!(message_id(&Message::Binary(vec![255, 0, 0, 0, 1])), None);
    assert_eq!(message_id(&Message::Text("nope".into())), None);
}
