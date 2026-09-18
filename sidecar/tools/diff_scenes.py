"""diff_scenes.py, the differential oracle over real saved documents.

diff_engines.py compares synthetic documents written for the port. This one
takes documents a person actually saved, a directory of .funda files, and
rebuilds each on both engines. A scene carries what a corpus document cannot:
the feature mix, the parameter tables and the imported bodies of real work.

A .funda is either the pretty JSON form or the zip container (manifest.json,
document.json, geom/<hash>.bbrep). Both are read here. The binary .fundab is
read by the Rust crates only, so it is reported as unsupported rather than
skipped quietly.

  python tools/diff_scenes.py <dir or file> --rust "fundacad-engine.exe --ws"
"""

import argparse
import json
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import diff_engines as D  # noqa: E402
import harness_util as H  # noqa: E402

DOC_KEYS = ("parameters", "paramDefs", "paramExtras", "features", "version",
            "suppressed", "rollback", "bodyIds")


def document_of(raw):
    """The document the engine is sent, side maps left out."""
    return {k: raw[k] for k in DOC_KEYS if k in raw}


def read_scene(path, blob_dir):
    """(document, note). Embedded geometry is written into `blob_dir`, which
    both engines read through FUNDACAD_BLOB_DIR, so an import feature resolves
    to the same bytes on each side."""
    if path.lower().endswith(".fundab"):
        return None, "the binary .fundab format is read by the Rust crates only"
    with open(path, "rb") as fh:
        head = fh.read(2)
    if head == b"PK":
        with zipfile.ZipFile(path) as z:
            raw = json.loads(z.read("document.json"))
            for name in z.namelist():
                if name.startswith("geom/"):
                    with open(os.path.join(blob_dir, os.path.basename(name)), "wb") as out:
                        out.write(z.read(name))
        return document_of(raw), None
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    for key, b64 in (raw.get("geometry") or {}).items():
        import base64
        with open(os.path.join(blob_dir, f"{key}.bbrep"), "wb") as out:
            out.write(base64.b64decode(b64))
    return document_of(raw), None


def scenes_in(target):
    if os.path.isfile(target):
        return [target]
    out = []
    for name in sorted(os.listdir(target)):
        if name.lower().endswith((".funda", ".fundab")):
            out.append(os.path.join(target, name))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", help="a .funda file or a directory of them")
    ap.add_argument("--rust", default=D.default_rust_cmd(),
                    help="command that starts the Rust engine's WebSocket server")
    ap.add_argument("--python-only", action="store_true")
    ap.add_argument("--tolerance", type=float, default=D.REBUILD_TOLERANCE)
    args = ap.parse_args()

    blob_dir = tempfile.mkdtemp(prefix="diff-scenes-blobs-")
    os.environ["FUNDACAD_BLOB_DIR"] = blob_dir
    docs, unsupported = [], []
    for path in scenes_in(args.target):
        doc, note = read_scene(path, blob_dir)
        if doc is None:
            unsupported.append((os.path.basename(path), note))
            continue
        docs.append({"name": os.path.basename(path), "document": doc})
    if not docs:
        raise SystemExit("no readable scene found")

    print(f"scenes: {len(docs)}    blobs: {blob_dir}")
    py = D.run_engine(None, docs)
    if args.python_only:
        rows = []
        for d in docs:
            o = D.outcome(py[d["name"]])
            rows.append([d["name"], o["bodies"], f"{sum(o['volumes'].values()):.2f}",
                         o["fatal"] or ("; ".join(o["messages"]) or "ok")])
        D.table(rows, ["scene", "bodies", "volume", "status"])
        return

    print(f"rust engine: {args.rust}")
    rs = D.run_engine(args.rust, docs)
    rows, bad, refused = [], 0, []
    for d in docs:
        name = d["name"]
        p, r = D.outcome(py[name]), D.outcome(rs[name])
        diffs = D.compare(p, r)
        if diffs:
            bad += 1
        refused += [(name, side, o["fatal"]) for side, o in (("python", p), ("rust", r)) if o["fatal"]]
        rows.append([name, p["bodies"], r["bodies"],
                     "MISMATCH" if diffs else "match", "; ".join(diffs)[:140]])
    D.table(rows, ["scene", "py bodies", "rust bodies", "status", "detail"])
    for name, note in unsupported:
        print(f"unsupported: {name}, {note}")
    print(f"\n{len(docs) - bad} match, {bad} mismatch")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main() or 0)
