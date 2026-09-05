"""Putting a reply on the socket.

Split out of server.py. A rebuild's answer is mostly float arrays — vertices,
normals, edge polylines — and JSON is the wrong shape for them twice over: it
triples the bytes and it makes the frontend parse numbers one at a time. So a
binary reply is a small JSON envelope followed by raw little-endian buffers the
browser can hand straight to a GPU buffer, and this module is the packing,
chunking and streaming of that.

The size limits here are the reason a huge assembly does not simply fail: a
reply too large for one frame is split into chunks a body at a time, and a
SINGLE body too large for even that gets a message saying so rather than a
dropped connection.

Cancellation lives here too, because a stream is the one place that has to keep
asking: a cancelled export must stop mid-send instead of pushing another two
hundred megabytes at a client that stopped listening.
"""

import contextvars
import json
import secrets
import struct
import sys
import traceback

import numpy as np

import sysmem

# Per-request cancel token, bound to the dispatch task's context (see
# _serialized). _run/_run_stall consult it so a killed worker is reported as a
# cancellation rather than a crash.
_CANCEL: contextvars.ContextVar = contextvars.ContextVar("funda_cancel", default=None)


def _cancelled_result():
    """The result shape for a cancelled op. `ok:false` keeps older clients
    treating it as a (harmless) failure; the `cancelled` flag lets a current one
    tell 'you stopped it' apart from 'it broke'."""
    return {"cancelled": True, "error": {"message": "cancelled"}}

def _ok(req_id, result):
    return json.dumps({"id": req_id, "ok": True, "result": result})


def _err(req_id, message, feature_id=None):
    error = {"message": message or "internal error (no message)"}
    if feature_id is not None:
        error["feature_id"] = feature_id
    return json.dumps({"id": req_id, "ok": False, "error": error})


def _reply_for(req_id, res):
    """Turn a worker result dict into the wire reply (error vs ok)."""
    if res.get("cancelled"):
        return json.dumps({
            "id": req_id, "ok": False, "cancelled": True,
            "error": {"message": "cancelled"},
        })
    if "error" in res:
        return _err(req_id, res["error"]["message"], res["error"].get("feature_id"))
    return _ok(req_id, res)


# The largest frame the websocket server will accept or emit. A security control
# (sidecar DoS surface), deliberately lowered from 512 MiB in the 2026-07-02
# hardening round — raise it only with that in mind. Enforced on the way IN by
# websockets.serve(max_size=...) and on the way OUT by _reply_bytes.
_MAX_FRAME = 128 * 1024 * 1024

# Binary mesh reply (opt-in via `"binary": true` on rebuild/computeAll requests).
# Wire layout, all integers little-endian:
#   [u32 header_len][header_len bytes UTF-8 JSON header][pad to 4][buf0][buf1]...
# The header is the normal {"id","ok","result"} envelope except each per-body
# mesh array (positions/normals -> f32, indices/faceIds -> u32) is replaced by
# {"$buf": i} referencing result.$buffers[i] = {"dtype","len"} (len = element
# count) in on-wire order; the client computes offsets sequentially. Both
# dtypes are 4 bytes/element, so after the single header pad every buffer is
# 4-aligned for free — INVARIANT: adding a wider dtype requires per-buffer
# padding. NOTE the unit of that invariant is ONE FRAME, and with `"chunked":
# true` a reply is several frames: each carries its own header, its own pad and
# its own $buffers table, so the guarantee holds per chunk, not per reply.
# f32 is lossless vs today's end state (the client always builds
# Float32BufferAttributes). A body's EDGE polylines are packed the same way
# (see _pack_edges) into {"$pts","$counts","body"}; everything else (stubs,
# faceOwners, bbox, diagnostics) stays inline JSON in the header.
_WIRE_F32 = np.dtype("<f4")
_WIRE_U32 = np.dtype("<u4")


def _pack_edges(edges, take, body):
    """Move one body's edge polylines out of the inline JSON header and into two
    binary buffers: all point triples flattened (f32) plus a per-edge POINT count
    (u32) the client walks to re-split them.

    Edge polylines are the largest single component of a large assembly's reply
    AND the one part tessellation tolerance cannot shrink — they sample at the
    fixed _EDGE_DEFLECTION, not at the viewport tolerance. Measured on the 356 MiB
    reference assembly: 97.1 MiB across 1,726,523 points, byte-identical at every
    point of a 5-step tolerance sweep, i.e. a hard floor under the 128 MiB frame
    cap that no adaptive-tolerance scheme can lift. As JSON text a point costs
    59 bytes against 12 as f32, so this is the cheapest large saving available and
    it costs no visual fidelity.

    `body` is the owning body id, taken from the envelope rather than re-derived
    from the polylines: every list reaching here comes from a SINGLE-body
    edge_polylines_by_body([b]) call, which stamps that same id on each edge."""
    counts, flat = [], []
    for e in edges or ():
        pts = e.get("points") or ()
        counts.append(len(pts))
        for p in pts:
            flat.extend(p)
    return {
        "$pts": take(flat, _WIRE_F32, "f32"),
        "$counts": take(counts, _WIRE_U32, "u32"),
        "body": body,
    }


class _ReplyTooLarge(Exception):
    """The encoded frame would exceed _MAX_FRAME. Carries the size so the caller
    can say how far over it was, and is raised BEFORE the buffers are joined so
    the doomed frame is never actually materialised."""

    def __init__(self, size):
        super().__init__(size)
        self.size = size


def _taker():
    """A `take` callable plus the buffer list and metadata it fills, scoped to
    ONE frame. Buffer indices are frame-local: the client resolves offsets by
    walking $buffers sequentially through the frame it just received, so a
    table spanning frames would have nothing to walk."""
    buffers = []
    buf_meta = []

    def take(vals, dtype, tag):
        arr = np.asarray(vals, dtype=dtype)
        # memoryview, not .tobytes(): join copies either way, so a bytes copy
        # here would put TWO full payloads in the parent at once — ~245 MiB at
        # the shipping tier. The array stays alive through the view.
        buffers.append(memoryview(arr).cast("B"))
        buf_meta.append({"dtype": tag, "len": int(arr.size)})
        return {"$buf": len(buf_meta) - 1}

    return take, buffers, buf_meta


def _pack_bodies(bodies, take):
    """Swap each full body's mesh arrays for {"$buf": i} refs; stubs pass through
    untouched. Shared by the single-frame encoder and the chunked one so a body's
    on-wire payload is identical either way — which is what lets the chunked
    round-trip test assert equality against the single-frame reply."""
    out = []
    for b in bodies:
        if b.get("unchanged"):
            out.append(b)
            continue
        nb = dict(b)
        nb["positions"] = take(b["positions"], _WIRE_F32, "f32")
        if "normals" in b:
            nb["normals"] = take(b["normals"], _WIRE_F32, "f32")
        nb["indices"] = take(b["indices"], _WIRE_U32, "u32")
        nb["faceIds"] = take(b["faceIds"], _WIRE_U32, "u32")
        nb["edges"] = _pack_edges(b.get("edges"), take, b.get("id"))
        out.append(nb)
    return out


def _frame_bytes(envelope, buffers):
    """Lay one frame out: [u32 header_len][JSON header][pad to 4][buffers...].

    Sizes the frame from its parts and refuses BEFORE joining: the join is a
    second full-size allocation, and on an over-cap frame every byte of it is
    discarded to send a short error string."""
    header = json.dumps(envelope).encode("utf-8")
    pad = (-len(header)) % 4
    parts = [struct.pack("<I", len(header)), header, b"\x00" * pad]
    parts.extend(buffers)
    total = sum(len(p) for p in parts)
    if total >= _MAX_FRAME:
        raise _ReplyTooLarge(total)
    return b"".join(parts)


def _encode_binary_reply(req_id, res):
    """Encode a successful protocol-2 rebuild result as one binary frame.
    Raises on anything unexpected — _reply_bytes falls back to the JSON text
    reply, so an encode bug can never break a rebuild."""
    take, buffers, buf_meta = _taker()
    header_obj = dict(res)
    header_obj["bodies"] = _pack_bodies(res.get("bodies", []), take)
    header_obj["$buffers"] = buf_meta
    return _frame_bytes({"id": req_id, "ok": True, "result": header_obj}, buffers)


def _too_large_error(req_id, size, n_bodies):
    """The reply exceeded the frame cap. websockets closes the connection with
    1009 "message too big" when a frame exceeds max_size, which reaches the user
    as the app dying mid-rebuild with no explanation — the failure mode of GH #4.
    _viewport_profile coarsens a large document's mesh to stay under the cap, but
    it keys off BODY COUNT, and bodies vary enormously in face count; this is the
    backstop for when that proxy is wrong."""
    print("[rebuild] reply %s over the %s frame cap (%d bodies)"
          % (sysmem.describe(size), sysmem.describe(_MAX_FRAME), n_bodies),
          file=sys.stderr, flush=True)
    return _err(
        req_id,
        "This model is too detailed to display: the rebuilt geometry came to "
        f"{sysmem.describe(size)} across {n_bodies:,} bodies, over the "
        f"{sysmem.describe(_MAX_FRAME)} limit. Hide some bodies or simplify "
        "the model.",
    )


def _reply_bytes(req_id, res, binary):
    """Dispatch a rebuild/computeAll result to its wire form: binary frame when
    the client opted in and the result is a successful mesh reply; the plain
    JSON text reply otherwise (errors, resync, opt-out, or encoder failure).

    Either form is refused if it would exceed the frame cap — see
    _too_large_error for why that must not reach websockets. Clients that also
    opt into `chunked` never reach here for a successful mesh reply; they go
    through _stream_binary_reply, which has no such cliff."""
    n_bodies = len(res.get("bodies") or ())
    if not binary or "error" in res or res.get("resync"):
        reply = _reply_for(req_id, res)
    else:
        try:
            reply = _encode_binary_reply(req_id, res)
        except _ReplyTooLarge as over:
            return _too_large_error(req_id, over.size, n_bodies)
        except Exception:
            reply = _reply_for(req_id, res)
    if len(reply) >= _MAX_FRAME:
        return _too_large_error(req_id, len(reply), n_bodies)
    return reply


# Target size for one chunk of a streamed reply. An eighth of _MAX_FRAME, so a
# single body far over target still has 8x of headroom before its chunk becomes
# unsendable, and the browser's largest single ArrayBuffer allocation drops from
# 128 MiB to ~16. Only a packing hint: _frame_bytes still enforces _MAX_FRAME
# per chunk, because _body_wire_size is an estimate.
_CHUNK_TARGET_BYTES = 16 * 1024 * 1024


def _wire_len(v):
    """len() of a mesh array field, 0 when absent.

    Deliberately NOT `len(x or ())`: today these are Python lists, but on a
    numpy array `or` evaluates __bool__ and raises "truth value of an array
    with more than one element is ambiguous". Handing numpy across the pool
    boundary is a named follow-up (it would cut the pickle ~8x), and this is
    the one place it would have blown up on arrival."""
    return 0 if v is None else len(v)


def _body_wire_size(b):
    """Estimate one body's encoded size, for packing decisions only."""
    if b.get("unchanged"):
        return 128  # a stub is a handful of short JSON fields
    n = (_wire_len(b.get("positions")) + _wire_len(b.get("indices"))
         + _wire_len(b.get("faceIds")) + _wire_len(b.get("normals")))
    for e in b.get("edges") or ():
        n += 3 * _wire_len(e.get("points")) + 1
    # 4 bytes per binary element, plus the inline JSON riding in the header —
    # faceOwners dominates that, at one short string or null per B-rep face.
    return 4 * n + 24 * _wire_len(b.get("faceOwners")) + 256


def _manifest_entry(b):
    """One manifest row. The manifest names every body of the reply in final
    order and ships in the head frame, so the client can plan every array
    offset and faceStart BEFORE any payload arrives — which is what makes chunk
    writes order-independent and byte-identical to the single-frame path.

    Sizes are present only for FULL bodies. For a stub the sidecar genuinely
    does not know them: the arrays live in the client's own bodyMesh cache,
    which is the entire point of a stub. The client resolves them from there,
    which it must do anyway to decide whether it can still back that etag."""
    e = {"id": b["id"], "name": b.get("name"), "etag": b.get("etag")}
    if b.get("nodeRef") is not None:
        e["nodeRef"] = b["nodeRef"]
    if b.get("unchanged"):
        e["unchanged"] = True
        return e
    e["faceCount"] = b.get("faceCount", 0)
    e["nVerts3"] = _wire_len(b.get("positions"))
    e["nIdx"] = _wire_len(b.get("indices"))
    e["nTris"] = _wire_len(b.get("faceIds"))
    e["nEdges"] = _wire_len(b.get("edges"))
    if "normals" in b:
        e["hasNormals"] = True
    return e


def _chunk_bodies(bodies, target):
    """Group bodies into chunks of roughly `target` bytes, IN ORDER.

    Order is load-bearing all the way to the screen: the client accumulates
    faceStart by manifest order, and partitionMesh/buildBodyMesh key face
    picking off those ranges. A body over target gets a chunk to itself rather
    than being split — the body is the indivisible unit here, which is what
    keeps every chunk independently decodable."""
    chunk, size = [], 0
    for b in bodies:
        n = _body_wire_size(b)
        if chunk and size + n > target:
            yield chunk
            chunk, size = [], 0
        chunk.append(b)
        size += n
    if chunk:
        yield chunk


def _body_too_large_error(req_id, chunk, size):
    """One body's own payload exceeds the frame cap — the single case chunking
    cannot fix, because a body is the indivisible unit of a chunk. Distinct from
    _too_large_error because its advice has to be: this ONE body is the problem.
    Reachable in practice: _viewport_profile coarsens by body COUNT, so a
    one-body document holding a huge imported mesh gets no coarsening at all."""
    worst = max(chunk, key=_body_wire_size)
    label = worst.get("name") or worst.get("id") or "a body"
    print("[rebuild] body %r alone is %s, over the %s frame cap"
          % (label, sysmem.describe(size), sysmem.describe(_MAX_FRAME)),
          file=sys.stderr, flush=True)
    return _err(
        req_id,
        f"The body “{label}” is too detailed to display on its own: it "
        f"came to {sysmem.describe(size)}, over the "
        f"{sysmem.describe(_MAX_FRAME)} limit for a single body. Simplify or "
        "re-import that body at a lower resolution.",
    )


def _cancelled_now():
    """Whether THIS task's request has been cancelled, read fresh each call.

    _serialized binds the token to the task context, so a long send loop can
    check between frames without threading the token through. Unlike the
    `cancelled` closures in _run/_run_stall (which capture the token once
    before submitting a pool job), this re-reads it, which is what a caller
    outside the submit path needs."""
    token = _CANCEL.get()
    return bool(token and token["cancelled"])


async def _stream_binary_reply(ws, req_id, res, cancelled=None):
    """Send a successful protocol-2 result as a STREAM of binary frames instead
    of one. Returns True once the head frame is away — from that point the reply
    is committed and the caller must not send anything else.

    Frame 0 (the head) carries every non-body field plus the manifest; frames
    1..N carry contiguous slices of `bodies`. Non-final frames carry
    `status: "chunk"` and no `ok`, so a client that does not understand them
    treats them as informational rather than as the reply — the same rule the
    `building` progress frame already relies on. The final frame carries
    `ok: true` and resolves the request.

    Two properties this depends on, neither of them local:
      * _serialized holds its lock across every send in _dispatch, so two
        streams can never interleave on the wire.
      * _run_stall has already returned before the first frame goes out, so no
        `building` frame can land mid-stream and the worker (which may be
        reaped or respawned at any time) is no longer involved at all.
    Raises _ReplyTooLarge from the head frame only, i.e. before anything is
    sent, so the caller can still fall back."""
    bodies = res.get("bodies") or []
    head = {k: v for k, v in res.items() if k != "bodies"}
    head["manifest"] = [_manifest_entry(b) for b in bodies]
    chunks = list(_chunk_bodies(bodies, _CHUNK_TARGET_BYTES))
    sid = secrets.token_hex(8)

    def envelope(seq, final, result):
        env = {"id": req_id, "stream": {"sid": sid, "seq": seq, "final": final}}
        if final:
            env["ok"] = True
        else:
            env["status"] = "chunk"
        env["result"] = result
        return env

    # Built (and cap-checked) before the first send, so a head that cannot be
    # framed leaves the caller free to answer some other way.
    head_frame = _frame_bytes(envelope(0, not chunks, head), [])
    await ws.send(head_frame)
    del head_frame

    for i, chunk in enumerate(chunks, start=1):
        if cancelled is not None and cancelled():
            # Shaped exactly like _reply_for's cancelled branch, so the client
            # needs no new handling. Without this a user who cancels still waits
            # out the whole reply, after the worker has already been killed.
            await ws.send(json.dumps({
                "id": req_id, "ok": False, "cancelled": True,
                "error": {"message": "cancelled"},
            }))
            return True
        take, buffers, buf_meta = _taker()
        result = {"bodies": _pack_bodies(chunk, take), "$buffers": buf_meta}
        try:
            frame = _frame_bytes(envelope(i, i == len(chunks), result), buffers)
        except _ReplyTooLarge as over:
            await ws.send(_body_too_large_error(req_id, chunk, over.size))
            return True
        # One frame alive at a time: this is the whole memory argument for
        # streaming. Awaiting the send between chunks also gives websockets a
        # point to flush, which a single 128 MiB frame never offered.
        await ws.send(frame)
        del frame, buffers, buf_meta, result, take
    return True


async def _send_reply(ws, req_id, res, binary, chunked):
    """Send a rebuild/computeAll result, streamed across frames when the client
    opted into `chunked` and the result is a successful mesh reply.

    Streaming is used for EVERY such reply once opted in, not just large ones: a
    size-conditional path would first run on a user's oversized assembly and
    never in CI. A small reply is simply a head frame plus one chunk."""
    if chunked and binary and "error" not in res and not res.get("resync"):
        try:
            if await _stream_binary_reply(ws, req_id, res, _cancelled_now):
                return
        except _ReplyTooLarge as over:
            await ws.send(_too_large_error(req_id, over.size, len(res.get("bodies") or ())))
            return
        except Exception:
            traceback.print_exc()
            # Fall through to the single-frame path. If this failed while
            # building the head, nothing has been sent and the fallback is the
            # whole reply. If it failed mid-loop the head is already out, and
            # the fallback frame lands on top of a half-received stream — which
            # is safe, because a terminal reply SUPERSEDES a partial stream on
            # the client (see Geometry.dropStream): the caller gets one complete
            # answer either way, rather than a wedged request.
    await ws.send(_reply_bytes(req_id, res, binary))
