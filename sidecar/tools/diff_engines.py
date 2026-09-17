"""diff_engines.py, the differential oracle between the Python and the Rust engine.

Starts `python server.py` and the Rust engine (`fundacad-engine --ws`), rebuilds
every document of a corpus through both over WebSocket with JSON replies, and
compares what golden_corpus.py records: body count, per-body mesh volume, the
document bbox and the ordered (feature_id, error class) pairs. The Python engine
is the reference until it is deleted (docs/RUST-PIVOT.md, section 5).

Tolerances are literals in this file on purpose, like golden_corpus.py.

Usage (from sidecar/ with the sidecar venv):
  python tools/diff_engines.py                       # both engines, nonzero on any mismatch
  python tools/diff_engines.py --allow-unported      # a feature the Rust side has not ported is a skip
  python tools/diff_engines.py --python-only         # check the corpus itself builds cleanly
  python tools/diff_engines.py --rust "path/to/fundacad-engine --ws" --only box,cone

The Rust command is `--rust`, else FUNDACAD_ENGINE_CMD, else the debug build,
fundacad-engine(.exe) with `--ws` under $CARGO_TARGET_DIR/debug or <repo>/target/debug.
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import websockets

import harness_util as H

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(H.SIDECAR_DIR)
DEFAULT_CORPUS = os.path.join(TOOLS_DIR, "corpus_engines.json")

VOLUME_REL_TOL = 0.005
BBOX_ABS_TOL = 1e-4
BBOX_REL_TOL = 0.001
REBUILD_TOLERANCE = 0.1

UNPORTED = re.compile(r"\bnot ported\b", re.IGNORECASE)


def default_rust_cmd():
    exe = "fundacad-engine.exe" if os.name == "nt" else "fundacad-engine"
    target = os.environ.get("CARGO_TARGET_DIR") or os.path.join(REPO_ROOT, "target")
    path = os.path.join(target, "debug", exe)
    if not os.path.exists(path):
        raise SystemExit(f"no Rust engine at {path}: run `cargo build -p fundacad-cli`, "
                         "or pass --rust or FUNDACAD_ENGINE_CMD")
    return f'"{path}" --ws'


def load_corpus(path, only):
    with open(path, encoding="utf-8") as fh:
        docs = json.load(fh)["documents"]
    if only:
        wanted = set(only)
        missing = wanted - {d["name"] for d in docs}
        if missing:
            raise SystemExit(f"no corpus document named {', '.join(sorted(missing))}")
        docs = [d for d in docs if d["name"] in wanted]
    return docs


def outcome(reply):
    """The compared invariants of one rebuild reply, fatal refusals included."""
    if not reply.get("ok"):
        err = reply.get("error") or {}
        message = err.get("message", "") if isinstance(err, dict) else str(err)
        return {
            "fatal": message or "no reply",
            "bodies": 0,
            "volumes": {},
            "bbox": None,
            "errors": [(err.get("feature_id") if isinstance(err, dict) else None,
                        H.error_class(message))],
            "messages": [message],
        }
    result = reply.get("result") or {}
    bodies = result.get("bodies") or []
    volumes = {}
    for b in bodies:
        pos, idx = b.get("positions"), b.get("indices")
        volumes[b["id"]] = H.mesh_volume(pos, idx) if (pos and idx) else 0.0
    ferrs = result.get("featureErrors") or []
    return {
        "fatal": None,
        "bodies": len(bodies),
        "volumes": volumes,
        "bbox": result.get("bbox"),
        "errors": [(e.get("feature_id"), H.error_class(e.get("message", ""))) for e in ferrs],
        "messages": [e.get("message", "") for e in ferrs],
    }


def compare(py, rs):
    """Every difference between the reference and the candidate, as text."""
    diffs = []
    if py["bodies"] != rs["bodies"]:
        diffs.append(f"bodies {rs['bodies']} vs {py['bodies']}")
    if set(py["volumes"]) != set(rs["volumes"]):
        diffs.append(f"body ids {sorted(rs['volumes'])} vs {sorted(py['volumes'])}")
    for bid, pv in py["volumes"].items():
        rv = rs["volumes"].get(bid)
        if rv is not None and abs(rv - pv) > max(abs(pv) * VOLUME_REL_TOL, 1e-9):
            diffs.append(f"{bid} volume {rv:.4f} vs {pv:.4f}")
    pb, rb = py["bbox"], rs["bbox"]
    if (pb is None) != (rb is None):
        diffs.append("bbox missing" if rb is None else "bbox where the reference has none")
    elif pb is not None:
        tol = max(BBOX_ABS_TOL, BBOX_REL_TOL * H.bbox_diagonal(pb))
        for corner in ("min", "max"):
            for i in range(3):
                if abs(rb[corner][i] - pb[corner][i]) > tol:
                    diffs.append(f"bbox {corner}[{i}] {rb[corner][i]:.6f} vs {pb[corner][i]:.6f}")
    if py["errors"] != rs["errors"]:
        diffs.append(f"errors {rs['errors']} vs {py['errors']}")
    return diffs


async def rebuild_all(url, docs):
    replies = {}
    async with websockets.connect(url, max_size=H._MAX_WS, compression=None) as ws:
        for i, d in enumerate(docs):
            replies[d["name"]] = await H.ws_call(
                ws, "rebuild", f"diff{i}", document=d["document"],
                tolerance=REBUILD_TOLERANCE, binary=False)
    return replies


async def import_all(url, docs):
    async with websockets.connect(url, max_size=H._MAX_WS, compression=None) as ws:
        for i, d in enumerate(docs):
            spec = d["importFixture"]
            reply = await H.ws_call(ws, "import", f"seed{i}",
                                    path=os.path.join(H.SIDECAR_DIR, spec["path"]),
                                    format=spec.get("format", "step"))
            if not reply.get("ok"):
                raise SystemExit(f"{d['name']}: the import op refused {spec['path']}: {reply.get('error')}")
            for f in d["document"]["features"]:
                if f.get("id") == spec["feature"]:
                    merged = dict(reply["result"])
                    merged.update(f)
                    f.clear()
                    f.update(merged)


def seed_imports(docs):
    """A document naming an `importFixture` gets that file imported through the
    Python engine's `import` op, into a blob directory both engines then read,
    so the import FEATURE is compared on identical stored geometry."""
    wanted = [d for d in docs if d.get("importFixture")]
    if not wanted:
        return None
    blob_dir = tempfile.mkdtemp(prefix="diff-engines-blobs-")
    os.environ["FUNDACAD_BLOB_DIR"] = blob_dir
    run_engine("", wanted, import_all)
    return blob_dir


def run_engine(cmd, docs, job=None):
    with H.SpawnedServer(cmd=cmd) as srv:
        try:
            return H.run((job or rebuild_all)(srv.url, docs))
        finally:
            # server.py leaves process pool workers behind a plain terminate on Windows.
            if sys.platform == "win32" and srv.proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(srv.pid)], capture_output=True)


def table(rows, headers):
    widths = [max(len(str(r[i])) for r in rows + [headers]) for i in range(len(headers))]
    line = lambda r: "  ".join(str(c).ljust(w) for c, w in zip(r, widths)).rstrip()
    print(line(headers))
    print(line(["-" * w for w in widths]))
    for r in rows:
        print(line(r))


def python_only(docs):
    replies = run_engine("", docs)
    rows, bad = [], 0
    for d in docs:
        o = outcome(replies[d["name"]])
        problems = []
        if o["fatal"]:
            problems.append(f"refused: {o['fatal']}")
        if d.get("expectError"):
            if not o["messages"] and not o["fatal"]:
                problems.append("expected a feature error, built cleanly")
        elif o["messages"] and not o["fatal"]:
            problems.append("feature errors: " + "; ".join(o["messages"]))
        if o["bodies"] == 0 and not o["fatal"]:
            problems.append("no bodies")
        bad += bool(problems)
        vol = sum(o["volumes"].values())
        rows.append([d["name"], o["bodies"], f"{vol:.2f}", "FAIL" if problems else "ok",
                     "; ".join(problems)])
    table(rows, ["document", "bodies", "volume", "status", "detail"])
    print(f"\n{len(docs) - bad} of {len(docs)} build cleanly on the Python engine")
    return 1 if bad else 0


def differential(docs, rust_cmd, allow_unported):
    py_replies = run_engine("", docs)
    rs_replies = run_engine(rust_cmd, docs)
    rows, matched, mismatched, skipped = [], [], [], []
    for d in docs:
        name = d["name"]
        py, rs = outcome(py_replies[name]), outcome(rs_replies[name])
        unported = [m for m in rs["messages"] if UNPORTED.search(m)]
        if unported and allow_unported:
            skipped.append((name, unported[0]))
            status, detail = "skip", unported[0]
        else:
            diffs = compare(py, rs)
            (mismatched if diffs else matched).append(name)
            status, detail = ("MISMATCH", "; ".join(diffs)) if diffs else ("match", "")
        rows.append([name, py["bodies"], rs["bodies"], status, detail])
    table(rows, ["document", "py bodies", "rust bodies", "status", "detail"])
    print(f"\n{len(matched)} match, {len(mismatched)} mismatch, {len(skipped)} skipped as not ported")
    if skipped:
        print("\nnot ported on the Rust engine:")
        for name, message in skipped:
            print(f"  {name}: {message}")
    return 1 if mismatched else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--corpus", default=DEFAULT_CORPUS)
    ap.add_argument("--rust", help="command that starts the Rust engine's WebSocket server")
    ap.add_argument("--python-only", action="store_true",
                    help="only check that every corpus document builds cleanly on the Python engine")
    ap.add_argument("--allow-unported", action="store_true",
                    help="a Rust error saying a feature is not ported yet is a skip, not a mismatch")
    ap.add_argument("--only", help="comma separated document names")
    args = ap.parse_args()

    docs = load_corpus(args.corpus, [n for n in (args.only or "").split(",") if n])
    blob_dir = seed_imports(docs)
    try:
        return run(args, docs)
    finally:
        if blob_dir:
            shutil.rmtree(blob_dir, ignore_errors=True)


def run(args, docs):
    if args.python_only:
        return python_only(docs)
    rust_cmd = args.rust or os.environ.get("FUNDACAD_ENGINE_CMD") or default_rust_cmd()
    print(f"rust engine: {rust_cmd}\n")
    return differential(docs, rust_cmd, args.allow_unported)


if __name__ == "__main__":
    sys.exit(main())
