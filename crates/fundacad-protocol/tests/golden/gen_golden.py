"""Regenerate the golden fixtures fundacad-protocol is held to.

Runs sidecar/wire.py's own encoders on the cases in inputs.json and writes what
they send, one .bin per case, each message framed as the engine's stdio framing
lays it out: [u32 LE payload_len][u8 kind][payload], kind 1 text, 2 binary.
The framing is written here independently of the Rust writer on purpose.

Run from the repository's sidecar/ directory with the sidecar's interpreter:
    python ../crates/fundacad-protocol/tests/golden/gen_golden.py
"""

import asyncio
import json
import os
import random
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "sidecar"))
sys.path.insert(0, SIDECAR)

import sysmem  # noqa: E402
import wire  # noqa: E402


def frame(msg):
    if isinstance(msg, str):
        payload, kind = msg.encode("utf-8"), 1
    else:
        payload, kind = bytes(msg), 2
    return struct.pack("<IB", len(payload), kind) + payload


class FakeWs:
    def __init__(self):
        self.sent = []

    async def send(self, msg):
        self.sent.append(msg)


def run_case(case):
    res = case.get("result")
    limits = case.get("limits") or {}
    wire._MAX_FRAME = limits.get("max_frame", 128 * 1024 * 1024)
    wire._CHUNK_TARGET_BYTES = limits.get("chunk_target", 16 * 1024 * 1024)
    kind = case["kind"]
    rid = case["id"]
    if kind == "reply_for":
        return [wire._reply_for(rid, res)]
    if kind == "err":
        return [wire._err(rid, case["message"], case.get("feature_id"))]
    if kind == "building":
        f = case["frame"]
        return [json.dumps({"id": rid, "status": "building", "feature": f[0],
                            "meshed": f[1], "meshTotal": f[2]})]
    if kind == "importing":
        f = case["frame"]
        return [json.dumps({"id": rid, "status": "importing",
                            "phase": f[0], "label": f[1], "pct": f[2]})]
    if kind == "send_reply":
        ws = FakeWs()
        wire.secrets.token_hex = lambda n: case["sid"]
        after = case.get("cancel_after")
        wire._cancelled_now = lambda: after is not None and len(ws.sent) >= after
        asyncio.run(wire._send_reply(ws, rid, res, case["binary"], case["chunked"]))
        return ws.sent
    raise ValueError(kind)


def float_vectors():
    rng = random.Random(20260917)
    vals = [0.0, -0.0, 1.0, -1.0, 0.1, 0.5, 1e-4, 1e-5, 9.999e-5, 1e15, 1e16,
            1234567890123456.0, 12345678901234567.0, 5e-324, 1.7976931348623157e308,
            2.2250738585072014e-308, 1 / 3, 2 / 3, 100.0, 123.456, float("inf"),
            float("-inf"), float("nan"), 16777217.0, 3.4028234663852886e38]
    for _ in range(100):
        vals.append(struct.unpack("<d", struct.pack("<Q", rng.getrandbits(64)))[0])
    for _ in range(100):
        vals.append(rng.uniform(-1, 1) * 10 ** rng.randint(-8, 20))
    for _ in range(40):
        vals.append(float(struct.unpack("<f", struct.pack("<f", rng.uniform(-500, 500)))[0]))
    return [{"bits": "%016x" % struct.unpack("<Q", struct.pack("<d", v))[0],
             "repr": json.dumps(v)} for v in vals]


def size_vectors():
    sizes = [0, 1, 1023, 1024, 1535, 1536, 2560, 3584, 1048575, 1048576,
             134217728, 1073741823, 1073741824, 1342177280, 1395864371, 5 * 1024 ** 3]
    return [{"n": n, "text": sysmem.describe(n)} for n in sizes]


def main():
    with open(os.path.join(HERE, "inputs.json"), encoding="utf-8") as f:
        inputs = json.load(f)
    for case in inputs["cases"]:
        msgs = run_case(case)
        with open(os.path.join(HERE, case["name"] + ".bin"), "wb") as f:
            for m in msgs:
                f.write(frame(m))
    vectors = {"floats": float_vectors(), "sizes": size_vectors()}
    with open(os.path.join(HERE, "vectors.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(vectors, f, indent=0)
        f.write("\n")


if __name__ == "__main__":
    main()
