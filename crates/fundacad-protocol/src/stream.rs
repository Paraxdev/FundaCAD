//! Chunked replies and the cancel check between chunks.
//!
//! Replaces `_chunk_bodies`, `_stream_binary_reply`, `_send_reply` and the
//! cancel token plumbing (`_CANCEL`, `_cancelled_now`) of `sidecar/wire.py`.
//! Transport-agnostic: a reply is an iterator of messages, and the transport
//! pulls the next one only when it has sent the previous, which is where the
//! Python loop awaited its send and where the cancel check sits.

use crate::body::{JobResult, MeshResult, WireBody};
use crate::envelope;
use crate::frame::{self, Limits};
use crate::stdio::Message;
use serde_json::Value;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::ops::Range;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

/// A per-request cancel flag, shared between the request's job and whatever
/// handles the `cancel` op.
#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// `_chunk_bodies`: group bodies IN ORDER into index ranges of roughly
/// `target` estimated bytes. The client accumulates faceStart by manifest
/// order, so reordering would break face picking. A body over target gets a
/// chunk of its own, it is never split.
pub fn chunk_bodies(bodies: &[WireBody], target: usize) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    let (mut start, mut size) = (0usize, 0usize);
    for (i, b) in bodies.iter().enumerate() {
        let n = b.wire_size();
        if i > start && size + n > target {
            out.push(start..i);
            start = i;
            size = 0;
        }
        size += n;
    }
    if start < bodies.len() {
        out.push(start..bodies.len());
    }
    out
}

/// A random 16 hex digit stream id, `secrets.token_hex(8)` in the sidecar. It
/// only has to differ between replies on one connection, so std's randomly
/// keyed hasher plus a counter is enough and needs no dependency.
pub fn new_stream_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    format!("{:016x}", h.finish())
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReplyOptions {
    pub binary: bool,
    pub chunked: bool,
}

/// The messages of one reply, in send order.
pub struct Reply {
    state: State,
}

enum State {
    One(Option<Message>),
    Stream(Box<Stream>),
}

struct Stream {
    id: Value,
    sid: String,
    result: MeshResult,
    chunks: Vec<Range<usize>>,
    next: usize,
    head: Option<Vec<u8>>,
    cancel: Option<CancelToken>,
    limits: Limits,
    done: bool,
}

impl Iterator for Reply {
    type Item = Message;

    fn next(&mut self) -> Option<Message> {
        match &mut self.state {
            State::One(m) => m.take(),
            State::Stream(s) => s.next_message(),
        }
    }
}

impl Stream {
    fn next_message(&mut self) -> Option<Message> {
        if self.done {
            return None;
        }
        if let Some(head) = self.head.take() {
            if self.chunks.is_empty() {
                self.done = true;
            }
            return Some(Message::Binary(head));
        }
        if self.next >= self.chunks.len() {
            self.done = true;
            return None;
        }
        // Without this a user who cancels still waits out the whole reply.
        // Shaped like the cancelled reply, so the client needs no new handling.
        if self.cancel.as_ref().is_some_and(CancelToken::is_cancelled) {
            self.done = true;
            return Some(Message::Text(envelope::cancelled(&self.id)));
        }
        let range = self.chunks[self.next].clone();
        self.next += 1;
        let seq = self.next;
        let fin = seq == self.chunks.len();
        let bodies = &self.result.bodies[range];
        match frame::encode_stream_chunk(&self.id, &self.sid, seq, fin, bodies, &self.limits) {
            Ok(bytes) => {
                if fin {
                    self.done = true;
                }
                Some(Message::Binary(bytes))
            }
            Err(over) => {
                self.done = true;
                Some(Message::Text(frame::body_too_large_error(
                    &self.id,
                    bodies,
                    over.size,
                    &self.limits,
                )))
            }
        }
    }
}

/// `_stream_binary_reply`: frame 0 carries every non-body field and the
/// manifest, frames 1..N carry contiguous slices of the bodies. Non-final
/// frames have `status: "chunk"` and no `ok`, the final one has `ok: true`.
/// The head is encoded and cap-checked here, before anything is sent, so a
/// head over the cap is still an ordinary error reply.
pub fn stream_reply(
    id: Value,
    result: MeshResult,
    sid: String,
    cancel: Option<CancelToken>,
    limits: Limits,
) -> Result<Reply, frame::TooLarge> {
    let chunks = chunk_bodies(&result.bodies, limits.chunk_target);
    let head = frame::encode_stream_head(&id, &sid, &result, chunks.is_empty(), &limits)?;
    Ok(Reply {
        state: State::Stream(Box::new(Stream {
            id,
            sid,
            result,
            chunks,
            next: 0,
            head: Some(head),
            cancel,
            limits,
            done: false,
        })),
    })
}

/// `_send_reply`: stream when the client opted into chunked binary frames and
/// the result is a successful mesh reply, a single message otherwise. Every
/// such reply is streamed, not only large ones, so the multi-frame path runs
/// constantly rather than first on a user's oversized assembly.
pub fn send_reply(
    id: Value,
    result: JobResult,
    opts: ReplyOptions,
    cancel: Option<CancelToken>,
    limits: Limits,
) -> Reply {
    match result {
        JobResult::Mesh(m) if opts.chunked && opts.binary && !m.is_error_or_resync() => {
            let n_bodies = m.bodies.len();
            match stream_reply(id.clone(), m, new_stream_id(), cancel, limits) {
                Ok(reply) => reply,
                Err(over) => single(Message::Text(frame::too_large_error(
                    &id, over.size, n_bodies, &limits,
                ))),
            }
        }
        other => single(frame::reply_bytes(&id, &other, opts.binary, &limits)),
    }
}

fn single(m: Message) -> Reply {
    Reply {
        state: State::One(Some(m)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::body::FullBody;
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
        let res = MeshResult {
            fields: Map::new(),
            bodies: vec![full("a", 1), full("b", 1), WireBody::stub("s", "S", "x")],
        };
        let limits = Limits {
            max_frame: 1 << 20,
            chunk_target: 300,
        };
        let msgs: Vec<Message> = stream_reply(json!("r"), res, "sid".into(), None, limits)
            .map(Iterator::collect)
            .unwrap_or_default();
        assert_eq!(msgs.len(), 4);
        let heads: Vec<Value> = msgs
            .iter()
            .map(|m| match m {
                Message::Binary(b) => header(b),
                Message::Text(_) => Value::Null,
            })
            .collect();
        assert_eq!(heads[0]["status"], json!("chunk"));
        assert_eq!(
            heads[0]["result"]["manifest"].as_array().map(Vec::len),
            Some(3)
        );
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
            ReplyOptions {
                binary: true,
                chunked: true,
            },
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
        let res = MeshResult {
            fields: Map::new(),
            bodies: vec![full("a", 1), full("b", 1)],
        };
        let limits = Limits {
            max_frame: 1 << 20,
            chunk_target: 1,
        };
        let mut reply = send_reply(
            json!("r"),
            JobResult::Mesh(res),
            ReplyOptions {
                binary: true,
                chunked: true,
            },
            Some(token.clone()),
            limits,
        );
        assert!(matches!(reply.next(), Some(Message::Binary(_))));
        assert!(matches!(reply.next(), Some(Message::Binary(_))));
        token.cancel();
        assert_eq!(
            reply.next(),
            Some(Message::Text(envelope::cancelled(&json!("r"))))
        );
        assert_eq!(reply.next(), None);
    }

    #[test]
    fn stream_ids_differ() {
        let a = new_stream_id();
        assert_eq!(a.len(), 16);
        assert_ne!(a, new_stream_id());
    }
}
