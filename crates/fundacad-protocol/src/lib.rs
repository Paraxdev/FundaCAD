//! The FundaCAD engine wire protocol (docs/PROTOCOL.md).
//!
//! Replaces `sidecar/wire.py`: reply envelopes, binary mesh frames, chunked
//! replies with their size limits and cancel checks, and the status frames.
//! Output is byte-identical to the Python encoder for the same input, which
//! the golden tests hold it to. Adds the stdio framing the engine worker
//! speaks to the app (docs/RUST-PIVOT.md, section 2.1).

pub mod body;
pub mod envelope;
pub mod frame;
pub mod pyjson;
pub mod stdio;
pub mod stream;

pub use body::{Edge, FullBody, JobResult, MeshResult, WireBody};
pub use frame::{Limits, TooLarge, CHUNK_TARGET_BYTES, MAX_FRAME};
pub use stdio::{message_id, read_message, write_message, Message};
pub use stream::{send_reply, CancelToken, Reply, ReplyOptions};
