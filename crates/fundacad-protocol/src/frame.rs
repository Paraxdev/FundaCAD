//! Binary reply frames and the size limits around them.
//!
//! Replaces `_pack_edges`, `_taker`, `_pack_bodies`, `_frame_bytes`,
//! `_encode_binary_reply`, `_too_large_error` and `_reply_bytes` in
//! `sidecar/wire.py`.
//!
//! Layout, all integers little-endian:
//! `[u32 header_len][header_len bytes UTF-8 JSON header][pad to 4][buf0][buf1]...`
//! Each mesh array in the header is `{"$buf": i}`, indexing
//! `result.$buffers[i] = {"dtype", "len"}` with `len` an element count, in
//! on-wire order. Both dtypes are 4 bytes wide, so the one header pad aligns
//! every buffer; a wider dtype would need per-buffer padding.

use crate::body::{Edge, FullBody, JobResult, MeshResult, WireBody, F32, U32};
use crate::envelope;
use crate::pyjson;
use crate::stdio::Message;
use serde_json::{json, Map, Value};

/// The largest frame accepted or emitted. A DoS control on the engine's socket,
/// mirrored in `client.ts` as `MAX_MESSAGE_BYTES`; raise it only with that in mind.
pub const MAX_FRAME: usize = 128 * 1024 * 1024;

/// Packing target for one chunk of a streamed reply, an eighth of `MAX_FRAME`
/// so a body far over target still has headroom before its chunk is unsendable.
pub const CHUNK_TARGET_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_frame: usize,
    pub chunk_target: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_frame: MAX_FRAME,
            chunk_target: CHUNK_TARGET_BYTES,
        }
    }
}

/// The frame would reach the cap. Detected from the parts before anything is
/// joined, so the doomed frame is never allocated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TooLarge {
    pub size: usize,
}

#[derive(Clone, Copy)]
enum BufSrc<'a> {
    F32(&'a [f32]),
    U32(&'a [u32]),
    EdgePoints(&'a [Edge]),
    EdgeCounts(&'a [Edge]),
}

impl BufSrc<'_> {
    fn len(&self) -> usize {
        match self {
            BufSrc::F32(v) => v.len(),
            BufSrc::U32(v) => v.len(),
            BufSrc::EdgePoints(e) => 3 * e.iter().map(|e| e.points.len()).sum::<usize>(),
            BufSrc::EdgeCounts(e) => e.len(),
        }
    }

    fn dtype(&self) -> &'static str {
        match self {
            BufSrc::F32(_) | BufSrc::EdgePoints(_) => F32,
            BufSrc::U32(_) | BufSrc::EdgeCounts(_) => U32,
        }
    }

    fn write(&self, out: &mut Vec<u8>) {
        match self {
            BufSrc::F32(v) => write_f32(v, out),
            BufSrc::U32(v) => write_u32(v, out),
            BufSrc::EdgePoints(edges) => {
                for e in *edges {
                    write_f32(bytemuck::cast_slice(&e.points), out);
                }
            }
            BufSrc::EdgeCounts(edges) => {
                for e in *edges {
                    out.extend_from_slice(&(e.points.len() as u32).to_le_bytes());
                }
            }
        }
    }
}

/// The frame is little endian, which on a little endian host is the slice's own
/// bytes; anywhere else each value is swapped on the way out.
fn write_f32(v: &[f32], out: &mut Vec<u8>) {
    if cfg!(target_endian = "little") {
        out.extend_from_slice(bytemuck::cast_slice(v));
    } else {
        v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
    }
}

fn write_u32(v: &[u32], out: &mut Vec<u8>) {
    if cfg!(target_endian = "little") {
        out.extend_from_slice(bytemuck::cast_slice(v));
    } else {
        v.iter().for_each(|x| out.extend_from_slice(&x.to_le_bytes()));
    }
}

/// `_taker`: the buffers of ONE frame. Indices are frame-local because the
/// client walks `$buffers` through the frame it just received.
#[derive(Default)]
struct Packer<'a> {
    bufs: Vec<BufSrc<'a>>,
}

impl<'a> Packer<'a> {
    fn take(&mut self, src: BufSrc<'a>) -> Value {
        self.bufs.push(src);
        json!({"$buf": self.bufs.len() - 1})
    }

    fn meta(&self) -> Value {
        self.bufs
            .iter()
            .map(|b| json!({"dtype": b.dtype(), "len": b.len()}))
            .collect()
    }
}

/// `_pack_edges`: all point triples flattened plus a per-edge point count, and
/// the tangent edges as an inline index list since they are a handful per body.
fn pack_edges<'a>(body: &'a FullBody, p: &mut Packer<'a>) -> Value {
    let mut out = Map::new();
    out.insert("$pts".into(), p.take(BufSrc::EdgePoints(&body.edges)));
    out.insert("$counts".into(), p.take(BufSrc::EdgeCounts(&body.edges)));
    out.insert("body".into(), body.id().clone());
    let smooth: Vec<Value> = body
        .edges
        .iter()
        .enumerate()
        .filter(|(_, e)| e.smooth)
        .map(|(i, _)| i.into())
        .collect();
    if !smooth.is_empty() {
        out.insert("smooth".into(), Value::Array(smooth));
    }
    Value::Object(out)
}

/// `_pack_bodies`: each full body's arrays become `$buf` refs, stubs pass
/// through. Shared by the single-frame and chunked encoders so a body's
/// payload is identical either way.
fn pack_bodies<'a>(bodies: &'a [WireBody], p: &mut Packer<'a>) -> Vec<Value> {
    bodies
        .iter()
        .map(|b| match b {
            WireBody::Stub(m) => Value::Object(m.clone()),
            WireBody::Full(b) => {
                let mut nb = b.fields.clone();
                nb.insert("positions".into(), p.take(BufSrc::F32(&b.positions)));
                match &b.normals {
                    Some(n) => {
                        nb.insert("normals".into(), p.take(BufSrc::F32(n)));
                    }
                    None => {
                        nb.shift_remove("normals");
                    }
                }
                nb.insert("indices".into(), p.take(BufSrc::U32(&b.indices)));
                nb.insert("faceIds".into(), p.take(BufSrc::U32(&b.face_ids)));
                nb.insert("edges".into(), pack_edges(b, p));
                Value::Object(nb)
            }
        })
        .collect()
}

/// `_frame_bytes`: size the frame from its parts, refuse at the cap, then lay
/// it out in one allocation.
fn frame_bytes(
    envelope: &Value,
    bufs: &[BufSrc<'_>],
    max_frame: usize,
) -> Result<Vec<u8>, TooLarge> {
    let header = pyjson::to_string(envelope);
    let pad = (4 - header.len() % 4) % 4;
    let total = 4 + header.len() + pad + bufs.iter().map(|b| 4 * b.len()).sum::<usize>();
    if total >= max_frame {
        return Err(TooLarge { size: total });
    }
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(header.as_bytes());
    out.resize(out.len() + pad, 0);
    for b in bufs {
        b.write(&mut out);
    }
    Ok(out)
}

/// `_encode_binary_reply`: a successful mesh result as one binary frame.
pub fn encode_binary_reply(
    id: &Value,
    res: &MeshResult,
    limits: &Limits,
) -> Result<Vec<u8>, TooLarge> {
    let mut p = Packer::default();
    let mut header = res.fields.clone();
    header.insert(
        "bodies".into(),
        Value::Array(pack_bodies(&res.bodies, &mut p)),
    );
    header.insert("$buffers".into(), p.meta());
    let env = json!({"id": id, "ok": true, "result": header});
    frame_bytes(&env, &p.bufs, limits.max_frame)
}

/// One frame of a chunked stream, `{"id", "stream", "ok"|"status", "result"}`.
fn stream_envelope(
    id: &Value,
    sid: &str,
    seq: usize,
    fin: bool,
    result: Map<String, Value>,
) -> Value {
    let mut env = Map::new();
    env.insert("id".into(), id.clone());
    env.insert(
        "stream".into(),
        json!({"sid": sid, "seq": seq, "final": fin}),
    );
    if fin {
        env.insert("ok".into(), Value::Bool(true));
    } else {
        env.insert("status".into(), Value::from("chunk"));
    }
    env.insert("result".into(), Value::Object(result));
    Value::Object(env)
}

/// The head frame, seq 0: every non-body field plus the manifest.
pub(crate) fn encode_stream_head(
    id: &Value,
    sid: &str,
    res: &MeshResult,
    fin: bool,
    limits: &Limits,
) -> Result<Vec<u8>, TooLarge> {
    let mut head = res.fields.clone();
    head.shift_remove("bodies");
    let manifest = res
        .bodies
        .iter()
        .map(|b| Value::Object(b.manifest_entry()))
        .collect();
    head.insert("manifest".into(), Value::Array(manifest));
    frame_bytes(
        &stream_envelope(id, sid, 0, fin, head),
        &[],
        limits.max_frame,
    )
}

/// Frame `seq` of a stream, carrying a contiguous slice of the bodies.
pub(crate) fn encode_stream_chunk(
    id: &Value,
    sid: &str,
    seq: usize,
    fin: bool,
    bodies: &[WireBody],
    limits: &Limits,
) -> Result<Vec<u8>, TooLarge> {
    let mut p = Packer::default();
    let mut result = Map::new();
    result.insert("bodies".into(), Value::Array(pack_bodies(bodies, &mut p)));
    result.insert("$buffers".into(), p.meta());
    frame_bytes(
        &stream_envelope(id, sid, seq, fin, result),
        &p.bufs,
        limits.max_frame,
    )
}

/// `sysmem.describe`: a human size for an error message, "1.8 GiB".
pub fn describe_size(nbytes: usize) -> String {
    let mut n = nbytes as f64;
    for unit in ["B", "KiB", "MiB"] {
        if n < 1024.0 {
            return format!("{n:.0} {unit}");
        }
        n /= 1024.0;
    }
    format!("{n:.1} GiB")
}

fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `_too_large_error`: the whole reply is over the cap. Without it the socket
/// would close with 1009 and the app would look like it died mid-rebuild.
pub fn too_large_error(id: &Value, size: usize, n_bodies: usize, limits: &Limits) -> String {
    eprintln!(
        "[rebuild] reply {} over the {} frame cap ({} bodies)",
        describe_size(size),
        describe_size(limits.max_frame),
        n_bodies
    );
    envelope::err(
        id,
        &format!(
            "This model is too detailed to display: the rebuilt geometry came to {} across {} bodies, \
             over the {} limit. Hide some bodies or simplify the model.",
            describe_size(size),
            thousands(n_bodies),
            describe_size(limits.max_frame)
        ),
        None,
    )
}

/// `_body_too_large_error`: one body alone is over the cap, the case chunking
/// cannot fix because a body is the indivisible unit of a chunk.
pub fn body_too_large_error(
    id: &Value,
    chunk: &[WireBody],
    size: usize,
    limits: &Limits,
) -> String {
    // Python's max() keeps the FIRST of equal sizes, Iterator::max_by_key the last.
    let mut worst: Option<&WireBody> = None;
    for b in chunk {
        if worst.map_or(true, |w| b.wire_size() > w.wire_size()) {
            worst = Some(b);
        }
    }
    let label = worst
        .map(|w| label_of(w.fields()))
        .unwrap_or_else(|| "a body".into());
    eprintln!(
        "[rebuild] body {label:?} alone is {}, over the {} frame cap",
        describe_size(size),
        describe_size(limits.max_frame)
    );
    envelope::err(
        id,
        &format!(
            "The body \u{201c}{label}\u{201d} is too detailed to display on its own: it came to {}, \
             over the {} limit for a single body. Simplify or re-import that body at a lower resolution.",
            describe_size(size),
            describe_size(limits.max_frame)
        ),
        None,
    )
}

/// `name or id or "a body"`, with Python truthiness.
fn label_of(f: &Map<String, Value>) -> String {
    for key in ["name", "id"] {
        let v = f.get(key);
        if pyjson::truthy(v) {
            return match v {
                Some(Value::String(s)) => s.clone(),
                Some(other) => pyjson::to_string(other),
                None => String::new(),
            };
        }
    }
    "a body".into()
}

/// `_reply_bytes`: a binary frame when the client opted in and the result is a
/// successful mesh reply, the JSON text reply otherwise, either one refused
/// with an error when it would reach the cap.
pub fn reply_bytes(id: &Value, res: &JobResult, binary: bool, limits: &Limits) -> Message {
    let n_bodies = res.body_count();
    let text = match res {
        JobResult::Mesh(m) if binary && !m.is_error_or_resync() => {
            return match encode_binary_reply(id, m, limits) {
                Ok(frame) => Message::Binary(frame),
                Err(over) => Message::Text(too_large_error(id, over.size, n_bodies, limits)),
            };
        }
        _ => envelope::reply_for(id, &res.to_json()),
    };
    if text.len() >= limits.max_frame {
        return Message::Text(too_large_error(id, text.len(), n_bodies, limits));
    }
    Message::Text(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> FullBody {
        let mut b = FullBody::new("b1", "Body1", "e1");
        b.positions = vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0];
        b.indices = vec![0, 1, 2];
        b.face_ids = vec![0];
        b.edges = vec![
            Edge {
                points: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
                smooth: false,
            },
            Edge {
                points: vec![[1.0, 1.0, 1.0]],
                smooth: true,
            },
        ];
        b
    }

    #[test]
    fn frame_layout_decodes() {
        let res = MeshResult {
            fields: Map::new(),
            bodies: vec![WireBody::Full(body())],
        };
        let frame = encode_binary_reply(&json!("r"), &res, &Limits::default()).expect("fits");
        let hl = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        let header: Value = serde_json::from_slice(&frame[4..4 + hl]).expect("json");
        let mut off = 4 + hl + (4 - hl % 4) % 4;
        assert_eq!(off % 4, 0);
        let bufs = header["result"]["$buffers"].as_array().expect("buffers");
        let lens: Vec<u64> = bufs
            .iter()
            .map(|b| b["len"].as_u64().unwrap_or(0))
            .collect();
        assert_eq!(lens, vec![9, 3, 1, 9, 2]);
        off += 4 * lens.iter().sum::<u64>() as usize;
        assert_eq!(off, frame.len());
        let edges = &header["result"]["bodies"][0]["edges"];
        assert_eq!(edges["smooth"], json!([1]));
        assert_eq!(edges["body"], json!("b1"));
        assert!(header["result"]["bodies"][0].get("normals").is_none());
    }

    #[test]
    fn too_large_refuses() {
        let res = MeshResult {
            fields: Map::new(),
            bodies: vec![WireBody::Full(body())],
        };
        let limits = Limits {
            max_frame: 64,
            chunk_target: 16,
        };
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
        assert_eq!(thousands(1234567), "1,234,567");
        assert_eq!(thousands(999), "999");
    }
}
