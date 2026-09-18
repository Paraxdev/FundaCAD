"""FundaCAD document files on disk, in either format.

`.funda` is pretty JSON, `.fundab` is the binary format 2 (docs/FUNDA-FORMAT.md),
and a reader decides by the first bytes, never the name. Imported geometry is not
part of the document object: a JSON file carries it in a trailing `geometry` map,
a binary file in sections, and both land in the blob store the sidecar builds
from, each blob published only once its bytes prove its hash.

Writing the binary format needs Reed-Solomon parity that only the app computes,
so a `.fundab` save here is refused with the way round it rather than written
without its error correction.
"""

import base64
import hashlib
import json
import os
import struct
import zipfile
import zlib

import app_session

BINARY_EXT = ".fundab"
GEOMETRY_KEY = "geometry"
MAGIC = b"FUNDACAD"
TAIL_MAGIC = b"FNDATAIL"
KIND_DOCUMENT = 1
KIND_GEOMETRY = 2
MAX_TOTAL = 8 << 30


class DocumentFileError(Exception):
    pass


def blob_dir():
    """The store the sidecar reads, as sidecar_link hands it over."""
    for prefix in ("FUNDACAD_", "SINDRI_", "SINDRICAD_"):
        val = os.environ.get(prefix + "BLOB_DIR")
        if val:
            return val
    return os.path.join(app_session.app_data_dir(), "blobs")


def is_binary_path(path):
    return os.path.splitext(path)[1].lower() == BINARY_EXT


def _hash(data):
    return hashlib.blake2b(data, digest_size=16).hexdigest()


def _is_hash(s):
    return isinstance(s, str) and len(s) == 32 and all(c in "0123456789abcdef" for c in s)


def _publish(root, digest, data):
    if _hash(data) != digest:
        raise DocumentFileError(
            "this document's geometry does not match its hash, the file is damaged or was modified")
    os.makedirs(root, exist_ok=True)
    dest = os.path.join(root, digest + ".bbrep")
    if os.path.exists(dest):
        return
    tmp = f"{dest}.tmp-{os.getpid()}"
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, dest)


def read(path, root=None):
    """The document object, and how many geometry blobs were published."""
    root = root or blob_dir()
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw[:8] == MAGIC or raw[-64:-56] == TAIL_MAGIC:
        doc, blobs = _read_fnda(raw)
    elif raw[:2] == b"PK":
        doc, blobs = _read_zip(path)
    else:
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as ex:
            raise DocumentFileError(f"{path} is not a FundaCAD document: {ex}") from ex
        blobs = {}
        if isinstance(doc, dict) and isinstance(doc.get(GEOMETRY_KEY), dict):
            total = 0
            for digest, b64 in doc.pop(GEOMETRY_KEY).items():
                if not _is_hash(digest) or not isinstance(b64, str):
                    raise DocumentFileError("this document's embedded geometry is damaged")
                total += len(b64) // 4 * 3
                if total > MAX_TOTAL:
                    raise DocumentFileError("this document expands to more than 8 GiB and was refused")
                blobs[digest] = base64.b64decode(b64)
    if not isinstance(doc, dict) or "features" not in doc:
        raise DocumentFileError(f"{path} is not a FundaCAD document (no `features`).")
    for digest, data in blobs.items():
        _publish(root, digest, data)
    return doc, len(blobs)


def referenced_geometry(doc):
    out = []
    for f in doc.get("features") or []:
        if isinstance(f, dict) and f.get("type") == "import" and _is_hash(f.get("geom")):
            if f["geom"] not in out:
                out.append(f["geom"])
    return out


def write(path, doc, root=None):
    """Write `doc` as JSON with its referenced geometry embedded. Returns the
    number of blobs embedded."""
    if is_binary_path(path):
        raise DocumentFileError(
            "a .fundab file carries error correction only the FundaCAD app writes. "
            "Save as .funda here, then open it in FundaCAD and Save As .fundab.")
    root = root or blob_dir()
    body = {k: v for k, v in doc.items() if k != GEOMETRY_KEY}
    geometry = {}
    missing = []
    for digest in referenced_geometry(body):
        p = os.path.join(root, digest + ".bbrep")
        if not os.path.exists(p):
            missing.append(digest)
            continue
        with open(p, "rb") as fh:
            geometry[digest] = base64.b64encode(fh.read()).decode("ascii")
    if missing:
        raise DocumentFileError(
            f"{len(missing)} imported bodies have no geometry in the blob store ({root}), "
            "so saving was stopped rather than writing a file that opens without them.")
    if geometry:
        body[GEOMETRY_KEY] = geometry
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(body, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    return len(geometry)


# --- format 2, read without repair --------------------------------------------
# The data shards are the stored bytes, so concatenating them and checking each
# section's hash is a complete reader for an undamaged file (FUNDA-FORMAT.md,
# "Reading", last paragraph). A damaged one is reported, and the app repairs it.

def _read_fnda(raw):
    table = None
    for at in (0, len(raw) - 64):
        head = raw[at:at + 64]
        if len(head) < 64 or head[:8] not in (MAGIC, TAIL_MAGIC):
            continue
        if zlib.crc32(head[:56]) != struct.unpack_from("<I", head, 56)[0]:
            continue
        major = struct.unpack_from("<H", head, 8)[0]
        if major > 2:
            raise DocumentFileError("this document was written by a newer FundaCAD")
        ta, tb, tl = struct.unpack_from("<QQQ", head, 16)
        crc = struct.unpack_from("<I", head, 40)[0]
        for off in (ta, tb):
            t = raw[off:off + tl]
            if len(t) == tl and zlib.crc32(t) == crc and t[:4] == b"FTBL":
                table = t
                break
        if table:
            break
    if table is None:
        raise DocumentFileError("this .fundab file is damaged, open it in FundaCAD to repair it")

    doc, blobs = None, {}
    count = struct.unpack_from("<I", table, 4)[0]
    p = 8
    for _ in range(count):
        kind, codec, nl = struct.unpack_from("<BBH", table, p)
        p += 4
        name = table[p:p + nl].decode("utf-8")
        p += nl
        off, stored, rawlen = struct.unpack_from("<QQQ", table, p)
        p += 24
        digest = table[p:p + 16].hex()
        p += 16
        shard, k, m = struct.unpack_from("<IHH", table, p)
        p += 8
        if kind not in (KIND_DOCUMENT, KIND_GEOMETRY):
            continue
        if rawlen > MAX_TOTAL:
            raise DocumentFileError("this document expands to more than 8 GiB and was refused")
        groups = -(-stored // (shard * k))
        parts, q = [], off
        for _g in range(groups):
            parts.append(raw[q:q + shard * k])
            q += (k + m) * shard
        data = b"".join(parts)[:stored]
        try:
            body = zlib.decompress(data, -15) if codec == 1 else data
        except zlib.error:
            body = b""
        if len(body) != rawlen or _hash(body) != digest:
            raise DocumentFileError("this .fundab file is damaged, open it in FundaCAD to repair it")
        if kind == KIND_DOCUMENT:
            doc = _cbor(body)
        elif name == digest:
            blobs[digest] = body
    if doc is None:
        raise DocumentFileError("this .fundab file has no document in it")
    return doc, blobs


def _read_zip(path):
    blobs = {}
    with zipfile.ZipFile(path) as z:
        total = sum(i.file_size for i in z.infolist())
        if total > MAX_TOTAL:
            raise DocumentFileError("this document expands to more than 8 GiB and was refused")
        manifest = json.loads(z.read("manifest.json"))
        doc = json.loads(z.read("document.json"))
        for row in manifest.get("blobs") or []:
            if _is_hash(row.get("hash")):
                blobs[row["hash"]] = z.read(row["entry"])
    return doc, blobs


def _cbor(b):
    value, _ = _cbor_item(b, 0)
    return value


def _cbor_len(b, p, ai):
    if ai < 24:
        return ai, p
    if ai == 24:
        return b[p], p + 1
    if ai == 25:
        return struct.unpack_from(">H", b, p)[0], p + 2
    if ai == 26:
        return struct.unpack_from(">I", b, p)[0], p + 4
    if ai == 27:
        return struct.unpack_from(">Q", b, p)[0], p + 8
    if ai == 31:
        return None, p
    raise DocumentFileError("this .fundab file's document is not valid CBOR")


def _cbor_item(b, p):
    ib = b[p]
    p += 1
    major, ai = ib >> 5, ib & 31
    if major == 7:
        if ai == 20:
            return False, p
        if ai == 21:
            return True, p
        if ai in (22, 23):
            return None, p
        if ai == 25:
            return struct.unpack_from(">e", b, p)[0], p + 2
        if ai == 26:
            return struct.unpack_from(">f", b, p)[0], p + 4
        if ai == 27:
            return struct.unpack_from(">d", b, p)[0], p + 8
        raise DocumentFileError("this .fundab file's document is not valid CBOR")
    n, p = _cbor_len(b, p, ai)
    if major == 0:
        return n, p
    if major == 1:
        return -1 - n, p
    if major in (2, 3):
        if n is None:
            parts = []
            while b[p] != 0xFF:
                part, p = _cbor_item(b, p)
                parts.append(part)
            p += 1
            return ("".join(parts) if major == 3 else b"".join(parts)), p
        chunk = b[p:p + n]
        return (chunk.decode("utf-8") if major == 3 else bytes(chunk)), p + n
    if major == 4:
        out = []
        while (len(out) < n) if n is not None else (b[p] != 0xFF):
            item, p = _cbor_item(b, p)
            out.append(item)
        return out, (p if n is not None else p + 1)
    if major == 5:
        out = {}
        i = 0
        while (i < n) if n is not None else (b[p] != 0xFF):
            key, p = _cbor_item(b, p)
            out[key], p = _cbor_item(b, p)
            i += 1
        return out, (p if n is not None else p + 1)
    return _cbor_item(b, p)  # a tag: the tagged value is what matters here
