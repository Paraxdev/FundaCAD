//! Framing on the engine worker's stdin and stdout: `[u32 LE payload_len][u8 kind][payload]`, kind 1 is UTF-8 JSON
//! text, kind 2 a binary reply frame. It mirrors WebSocket messages one to one so the app relays without parsing.

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
        return Err(invalid(format!("message of {} bytes is over the {} byte limit", payload.len(), MAX_PAYLOAD)));
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
            Ok(0) => return Err(io::Error::new(ErrorKind::UnexpectedEof, "stream ended inside a message header")),
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
        return Err(invalid(format!("message of {len} bytes is over the {max_payload} byte limit")));
    }
    // Grown as bytes arrive rather than allocated from the header up front, so
    // a corrupt length cannot reserve the whole cap for a few bytes of input.
    let mut payload = Vec::with_capacity(len.min(1 << 20));
    let read = r.take(len as u64).read_to_end(&mut payload)?;
    if read < len {
        return Err(io::Error::new(ErrorKind::UnexpectedEof, "stream ended inside a message payload"));
    }
    Ok(Some(match kind {
        KIND_TEXT => Message::Text(String::from_utf8(payload).map_err(|_| invalid("text message is not UTF-8"))?),
        _ => Message::Binary(payload),
    }))
}

#[derive(Deserialize)]
struct IdOnly {
    #[serde(default)]
    id: Option<Value>,
}

/// The top-level `id` of a text message or of a binary frame's JSON header, `None` when absent, null or malformed.
/// The other fields are skipped without being built, so a large text reply costs one scan.
pub fn message_id(msg: &Message) -> Option<Value> {
    let json = match msg {
        Message::Text(s) => s.as_bytes(),
        Message::Binary(b) => {
            let head = b.get(..4)?;
            let hl = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
            b.get(4..4usize.checked_add(hl)?)?
        }
    };
    serde_json::from_slice::<IdOnly>(json).ok()?.id.filter(|v| !v.is_null())
}
