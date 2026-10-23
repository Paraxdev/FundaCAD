//! The FundaCAD engine wire protocol (docs/PROTOCOL.md) and the stdio framing of the engine worker (docs/ENGINE.md 2.1).
//! Output is byte-identical to the Python encoder for the same input, the golden tests hold it to that.

pub mod body;
pub mod envelope;
pub mod frame;
pub mod import_stage;
pub mod pyjson;
pub mod stdio;
pub mod stream;

pub use body::{Edge, FullBody, JobResult, MeshResult, WireBody};
pub use frame::{Limits, TooLarge, CHUNK_TARGET_BYTES, MAX_FRAME};
pub use stdio::{message_id, read_message, write_message, Message};
pub use stream::{send_reply, CancelToken, Reply, ReplyOptions};
