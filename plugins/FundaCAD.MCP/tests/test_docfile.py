"""Document files in both formats: `.funda` JSON and `.fundab` binary.

The binary case builds a format 2 file by the spec in docs/FUNDA-FORMAT.md, with
parity shards the reader must step over, since the app's own writer is Rust.

Run: uv run python mcp/tests/test_docfile.py
"""

import _bootstrap  # noqa: F401
import _run

import hashlib
import json
import os
import struct
import tempfile
import zlib

import docfile

GEOMETRY = bytes((i * 2654435761 >> 13) & 0xFF for i in range(20_000))
DIGEST = hashlib.blake2b(GEOMETRY, digest_size=16).hexdigest()
DOC = {"version": 9, "parameters": {"w": 12.5},
       "features": [{"id": "im", "type": "import", "geom": DIGEST, "name": "Speaker"}]}


def _cbor(v):
    def head(major, n):
        if n < 24:
            return bytes([major << 5 | n])
        for ai, fmt in ((24, ">B"), (25, ">H"), (26, ">I"), (27, ">Q")):
            if n < 1 << (8 * struct.calcsize(fmt)):
                return bytes([major << 5 | ai]) + struct.pack(fmt, n)
    if isinstance(v, bool):
        return b"\xf5" if v else b"\xf4"
    if isinstance(v, int):
        return head(0, v) if v >= 0 else head(1, -1 - v)
    if isinstance(v, float):
        return b"\xf9" + struct.pack(">e", v) if struct.unpack(">e", struct.pack(">e", v))[0] == v \
            else b"\xfb" + struct.pack(">d", v)
    if isinstance(v, str):
        e = v.encode()
        return head(3, len(e)) + e
    if isinstance(v, list):
        return head(4, len(v)) + b"".join(_cbor(x) for x in v)
    if isinstance(v, dict):
        return head(5, len(v)) + b"".join(_cbor(k) + _cbor(x) for k, x in v.items())
    raise TypeError(v)


def _fundab(path, doc, blobs):
    shard, k, m = 4096, 8, 4
    body, entries = bytearray(b"\0" * 64), []
    for kind, name, raw in [(1, "document", _cbor(doc))] + [(2, h, b) for h, b in blobs.items()]:
        stored = zlib.compressobj(9, zlib.DEFLATED, -15)
        stored = stored.compress(raw) + stored.flush()
        off = len(body)
        groups = -(-len(stored) // (shard * k))
        padded = stored.ljust(groups * shard * k, b"\0")
        for g in range(groups):
            body += padded[g * shard * k:(g + 1) * shard * k]
            body += b"\xaa" * (m * shard)
        body += b"\0" * (4 * groups * (k + m))
        entries.append((kind, name, off, len(stored), len(raw), hashlib.blake2b(raw, digest_size=16).digest()))
    table = bytearray(b"FTBL" + struct.pack("<I", len(entries)))
    for kind, name, off, sl, rl, h in entries:
        n = name.encode()
        table += struct.pack("<BBH", kind, 1, len(n)) + n + struct.pack("<QQQ", off, sl, rl) + h
        table += struct.pack("<IHH", shard, k, m)
    ta = len(body)
    body += table
    tb = len(body)
    body += table
    head = bytearray(64)
    head[:8] = b"FUNDACAD"
    struct.pack_into("<HHI", head, 8, 2, 0, 0)
    struct.pack_into("<QQQI", head, 16, ta, tb, len(table), zlib.crc32(table))
    struct.pack_into("<I", head, 56, zlib.crc32(bytes(head[:56])))
    body[:64] = head
    tail = bytearray(head)
    tail[:8] = b"FNDATAIL"
    struct.pack_into("<I", tail, 56, zlib.crc32(bytes(tail[:56])))
    body += tail
    with open(path, "wb") as fh:
        fh.write(body)


def test_json_round_trips_with_geometry_embedded_last():
    with tempfile.TemporaryDirectory() as tmp:
        store = os.path.join(tmp, "blobs")
        os.makedirs(store)
        with open(os.path.join(store, DIGEST + ".bbrep"), "wb") as fh:
            fh.write(GEOMETRY)
        path = os.path.join(tmp, "part.funda")
        assert docfile.write(path, DOC, root=store) == 1
        text = open(path, encoding="utf-8").read()
        assert text.index('"features"') < text.index('"geometry"'), "the feature tree reads first"

        fresh = os.path.join(tmp, "fresh")
        doc, n = docfile.read(path, root=fresh)
        assert n == 1 and doc == DOC
        assert open(os.path.join(fresh, DIGEST + ".bbrep"), "rb").read() == GEOMETRY


def test_reads_a_binary_file_and_publishes_its_geometry():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "part.fundab")
        _fundab(path, DOC, {DIGEST: GEOMETRY})
        store = os.path.join(tmp, "blobs")
        doc, n = docfile.read(path, root=store)
        assert doc == DOC, doc
        assert n == 1
        assert open(os.path.join(store, DIGEST + ".bbrep"), "rb").read() == GEOMETRY


def test_the_extension_does_not_decide_how_a_file_is_read():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "misnamed.funda")
        _fundab(path, DOC, {})
        assert docfile.read(path, root=os.path.join(tmp, "b"))[0] == DOC


def test_damaged_binary_and_wrong_geometry_are_refused():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "part.fundab")
        _fundab(path, DOC, {DIGEST: GEOMETRY})
        raw = bytearray(open(path, "rb").read())
        raw[70] ^= 0xFF
        open(path, "wb").write(raw)
        try:
            docfile.read(path, root=os.path.join(tmp, "b"))
            raise AssertionError("a damaged section was accepted")
        except docfile.DocumentFileError:
            pass

        bad = dict(DOC, geometry={DIGEST: "AAAA" * 10})
        jpath = os.path.join(tmp, "bad.funda")
        open(jpath, "w").write(json.dumps(bad))
        store = os.path.join(tmp, "b2")
        try:
            docfile.read(jpath, root=store)
            raise AssertionError("geometry that does not match its hash was accepted")
        except docfile.DocumentFileError:
            pass
        assert not os.path.exists(os.path.join(store, DIGEST + ".bbrep"))


def test_saving_binary_is_refused_with_the_way_round_it():
    with tempfile.TemporaryDirectory() as tmp:
        try:
            docfile.write(os.path.join(tmp, "part.fundab"), DOC, root=tmp)
            raise AssertionError("wrote a .fundab without parity")
        except docfile.DocumentFileError as ex:
            assert "Save As .fundab" in str(ex)


def test_saving_with_missing_geometry_is_refused():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "part.funda")
        try:
            docfile.write(path, DOC, root=os.path.join(tmp, "empty"))
            raise AssertionError("saved a document whose geometry is nowhere")
        except docfile.DocumentFileError:
            pass
        assert not os.path.exists(path)


if __name__ == "__main__":
    _run.run(globals(), "docfile")
