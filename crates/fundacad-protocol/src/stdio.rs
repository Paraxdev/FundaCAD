//! Message framing on the engine worker's stdin and stdout.
//!
//! No Python counterpart: the sidecar spoke WebSocket, whose text and binary
//! messages this mirrors one to one so the app can relay without parsing.
//!
//! Each message is `[u32 LE payload_len][u8 kind][payload]`, where
//! `payload_len` counts the payload only, kind 1 is UTF-8 JSON text and kind 2
//! a binary reply frame. A payload may not exceed `MAX_PAYLOAD`.

use serde::Deserialize;
use serde_json::Value;
use std::io::{self, ErrorKind, Read, Write};

pub const KIND_TEXT: u8 = 1;
pub const KIND_BINARY: u8 = 2;

/// Equal to the WebSocket cap. Anything past it is refused before allocating.
pub const MAX_PAYLOAD: usize = crate::frame::MAX_FRAME;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Text(String),
    Binary(Vec<u8>),
}

impl Message {
    pub fn kind(&self) -> u8 {
        match self {
            Message::Text(_) => KIND_TEXT,
            Message::Binary(_) => KIND_BINARY,
        }
    }

    pub fn payload(&self) -> &[u8] {
        match self {
            Message::Text(s) => s.as_bytes(),
            Message::Binary(b) => b,
        }
    }
}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, msg.into())
}

/// Write one message and flush it, a reply sitting in a pipe buffer is a
/// request that looks hung.
pub fn write_message<W: Write>(w: &mut W, msg: &Message) -> io::Result<()> {
    let payload = msg.payload();
    if payload.len() > MAX_PAYLOAD {
        return Err(invalid(format!(
            "message of {} bytes is over the {} byte limit",
            payload.len(),
            MAX_PAYLOAD
        )));
    }
    let mut prefix = [0u8; 5];
    prefix[..4].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    prefix[4] = msg.kind();
    w.write_all(&prefix)?;
    w.write_all(payload)?;
    w.flush()
}

/// Read one message. `Ok(None)` is a clean end of stream, at a message
/// boundary; a stream that ends inside a message is `UnexpectedEof`.
pub fn read_message<R: Read>(r: &mut R) -> io::Result<Option<Message>> {
    read_message_limited(r, MAX_PAYLOAD)
}

pub fn read_message_limited<R: Read>(r: &mut R, max_payload: usize) -> io::Result<Option<Message>> {
    let mut prefix = [0u8; 5];
    let mut got = 0;
    while got < prefix.len() {
        match r.read(&mut prefix[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "stream ended inside a message header",
                ))
            }
            Ok(n) => got += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    let kind = prefix[4];
    if kind != KIND_TEXT && kind != KIND_BINARY {
        return Err(invalid(format!("unknown message kind {kind}")));
    }
    if len > max_payload {
        return Err(invalid(format!(
            "message of {len} bytes is over the {max_payload} byte limit"
        )));
    }
    // Grown as bytes arrive rather than allocated from the header up front, so
    // a corrupt length cannot reserve the whole cap for a few bytes of input.
    let mut payload = Vec::with_capacity(len.min(1 << 20));
    let read = r.take(len as u64).read_to_end(&mut payload)?;
    if read < len {
        return Err(io::Error::new(
            ErrorKind::UnexpectedEof,
            "stream ended inside a message payload",
        ));
    }
    Ok(Some(match kind {
        KIND_TEXT => Message::Text(
            String::from_utf8(payload).map_err(|_| invalid("text message is not UTF-8"))?,
        ),
        _ => Message::Binary(payload),
    }))
}

#[derive(Deserialize)]
struct IdOnly {
    #[serde(default)]
    id: Option<Value>,
}

/// The request id a message belongs to: the top-level `id` of a text message,
/// or of a binary frame's JSON header. `None` when there is none, or it is
/// null, or the message is malformed. The other fields are skipped without
/// being built, so a large text reply costs one scan.
pub fn message_id(msg: &Message) -> Option<Value> {
    let json = match msg {
        Message::Text(s) => s.as_bytes(),
        Message::Binary(b) => {
            let head = b.get(..4)?;
            let hl = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
            b.get(4..4usize.checked_add(hl)?)?
        }
    };
    serde_json::from_slice::<IdOnly>(json)
        .ok()?
        .id
        .filter(|v| !v.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn round_trip_and_clean_eof() {
        let msgs = [
            Message::Text("{\"id\": \"a\"}".into()),
            Message::Binary(vec![1, 2, 3]),
            Message::Text(String::new()),
        ];
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
        let text = Message::Text(
            r#"{"op": "rebuild", "big": [1, 2, {"id": "inner"}], "id": "r7"}"#.into(),
        );
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
}
