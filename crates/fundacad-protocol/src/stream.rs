//! Chunked replies and the cancel check between chunks. A reply is an iterator of messages and the transport pulls
//! the next only after sending the previous, which is where the cancel check sits.

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

/// `_chunk_bodies`: group bodies IN ORDER into ranges of about `target` estimated bytes, since the client accumulates
/// faceStart by manifest order and reordering breaks face picking. A body over target gets a chunk of its own.
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

/// A random 16 hex digit stream id. It only has to differ between replies on one connection, so std's randomly
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

impl Reply {
    /// True as soon as the last message has been yielded, before `next` says None.
    pub fn is_done(&self) -> bool {
        match &self.state {
            State::One(m) => m.is_none(),
            State::Stream(s) => s.done,
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
                Some(Message::Text(frame::body_too_large_error(&self.id, bodies, over.size, &self.limits)))
            }
        }
    }
}

/// `_stream_binary_reply`: frame 0 carries every non-body field and the manifest, frames 1..N contiguous slices of
/// the bodies. Non-final frames have `status: "chunk"` and no `ok`, the final one `ok: true`. The head is cap-checked
/// here before anything is sent, so a head over the cap is still an ordinary error reply.
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

/// `_send_reply`: stream when the client opted into chunked binary frames and the result is a successful mesh reply,
/// a single message otherwise. Every such reply streams, not only large ones, so the multi-frame path runs constantly.
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
                Err(over) => single(Message::Text(frame::too_large_error(&id, over.size, n_bodies, &limits))),
            }
        }
        other => single(frame::reply_bytes(&id, &other, opts.binary, &limits)),
    }
}

fn single(m: Message) -> Reply {
    Reply { state: State::One(Some(m)) }
}
