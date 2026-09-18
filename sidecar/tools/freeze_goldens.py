"""freeze_goldens.py, the Python engine's answers written down once, for a checker with no Python.

The differential tools (diff_engines.py, diff_plugin_ops.py, diff_meshes.py,
eval_fillet_corpus.py, eval_selector_survival.py, e2e_coverage.py and the MCP
diff_servers.py) each ask the Python engine and the Rust engine the same question
and compare the answers. This asks only the Python side, reduced to exactly what
each tool compares, and writes it to tests/golden/<name>.golden.json, which
`fundacad-engine golden-check` and crates/fundacad-mcp/tests/parity_golden.rs
compare the Rust engine against with the same rules and tolerances.

The goldens are frozen: this runs while the sidecar still exists, and never again
after it is deleted (docs/RUST-PIVOT.md, "Golden files").

Usage (from sidecar/ with the sidecar venv):
  python tools/freeze_goldens.py                       # every golden
  python tools/freeze_goldens.py --only engines,texture
"""

import argparse
import asyncio
import base64
import copy
import hashlib
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
import zlib

import numpy as np

import harness_util as H

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(H.SIDECAR_DIR)
GOLDEN_DIR = os.path.join(REPO_ROOT, "tests", "golden")
CORPUS_DIR = os.path.join(GOLDEN_DIR, "corpus")
sys.path.insert(0, H.SIDECAR_DIR)


def rel(path):
    return os.path.relpath(path, REPO_ROOT).replace(os.sep, "/")


def corpus_sha256(path):
    """Over the bytes with CRLF folded to LF, so a Windows checkout hashes the same."""
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read().replace(b"\r\n", b"\n")).hexdigest()


def sig(x, digits):
    """x rounded to `digits` significant digits, for a value compared to a tolerance."""
    if x is None or x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{digits}g}")


def fixed(x, places):
    return None if x is None else round(float(x), places) + 0.0


def reference():
    import build123d
    import OCP

    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT,
                            capture_output=True, text=True).stdout.strip()
    return {
        "engine": "python sidecar (sidecar/server.py)",
        "build123d": build123d.__version__,
        "ocp": getattr(OCP, "__version__", "unknown"),
        "sidecarCommit": commit,
        "python": platform.python_version(),
        "platform": platform.platform(),
    }


def write_golden(name, header, cases):
    header = dict(header, reference=reference(), frozen=True)
    path = os.path.join(GOLDEN_DIR, f"{name}.golden.json")
    os.makedirs(GOLDEN_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump({"golden": header, "cases": cases}, fh, sort_keys=True, indent=1, ensure_ascii=True)
        fh.write("\n")
    print(f"wrote {rel(path)}: {len(cases)} cases, {os.path.getsize(path)} bytes")


def normalise(text, roots):
    """A machine's own paths in a message, replaced by the placeholder the checker
    uses too, with the separators after the placeholder written as /."""
    if not isinstance(text, str):
        return text
    for real, token in roots:
        back = real.replace("/", "\\")
        for form in sorted({back.replace("\\", "\\\\"), real, real.replace("\\", "/"), back},
                           key=len, reverse=True):
            text = text.replace(form, token)
    return re.sub(r"(\$(?:WORK|REPO))([^\s'\"]*)",
                  lambda m: m.group(1) + re.sub(r"\\+", "/", m.group(2)), text)


def normalise_all(obj, roots):
    if isinstance(obj, str):
        return normalise(obj, roots)
    if isinstance(obj, list):
        return [normalise_all(x, roots) for x in obj]
    if isinstance(obj, dict):
        return {k: normalise_all(v, roots) for k, v in obj.items()}
    return obj


# --- rebuild corpora (diff_engines.py) ----------------------------------------


async def import_capturing(url, docs):
    """diff_engines.import_all, keeping each import reply."""
    import websockets

    replies = {}
    async with websockets.connect(url, max_size=H._MAX_WS, compression=None) as ws:
        for i, d in enumerate(docs):
            spec = d["importFixture"]
            reply = await H.ws_call(ws, "import", f"seed{i}",
                                    path=os.path.join(H.SIDECAR_DIR, spec["path"]),
                                    format=spec.get("format", "step"))
            if not reply.get("ok"):
                raise SystemExit(f"{d['name']}: the import op refused {spec['path']}: {reply.get('error')}")
            replies[d["name"]] = dict(reply["result"])
            for f in d["document"]["features"]:
                if f.get("id") == spec["feature"]:
                    merged = dict(reply["result"])
                    merged.update(f)
                    f.clear()
                    f.update(merged)
    return replies


def freeze_rebuilds(name, corpus_file):
    import diff_engines as DE

    corpus = os.path.join(CORPUS_DIR, corpus_file)
    docs = DE.load_corpus(corpus, [])
    DE.absolute_image_paths(docs)
    seeded = {}
    blob_dir = None
    wanted = [d for d in docs if d.get("importFixture")]
    if wanted:
        blob_dir = tempfile.mkdtemp(prefix="freeze-blobs-")
        os.environ["FUNDACAD_BLOB_DIR"] = blob_dir
        seeded = DE.run_engine("", wanted, import_capturing)
    try:
        replies = DE.run_engine("", docs)
    finally:
        if blob_dir:
            shutil.rmtree(blob_dir, ignore_errors=True)
    roots = [(REPO_ROOT, "$REPO")]
    cases = {}
    for d in docs:
        o = DE.outcome(replies[d["name"]], lambda t: normalise(t, roots))
        case = {
            "bodies": o["bodies"],
            "volumes": {k: sig(v, 10) for k, v in o["volumes"].items()},
            "bbox": None if o["bbox"] is None else {
                c: [fixed(x, 9) for x in o["bbox"][c]] for c in ("min", "max")},
            "errors": [list(e) for e in o["errors"]],
            "fatal": bool(o["fatal"]),
        }
        if d["name"] in seeded:
            reply = dict(seeded[d["name"]])
            case["import"] = {
                "fixture": rel(os.path.join(H.SIDECAR_DIR, d["importFixture"]["path"])),
                "format": d["importFixture"].get("format", "step"),
                "feature": d["importFixture"]["feature"],
                "pythonGeom": reply.pop("geom"),
                "reply": normalise_all(reply, roots),
            }
        cases[d["name"]] = case
    write_golden(name, {
        "kind": "rebuild",
        "tool": "sidecar/tools/diff_engines.py",
        "corpus": rel(corpus),
        "corpusSha256": corpus_sha256(corpus),
        "rebuildTolerance": DE.REBUILD_TOLERANCE,
        "tolerances": {"volumeRel": DE.VOLUME_REL_TOL, "bboxAbs": DE.BBOX_ABS_TOL,
                       "bboxRelOfDiagonal": DE.BBOX_REL_TOL, "volumeFloor": 1e-9},
        "rules": "body count and body ids exact; each body's mesh volume (signed tetra sum) within "
                 "max(volumeRel * |python|, volumeFloor); every bbox corner within "
                 "max(bboxAbs, bboxRelOfDiagonal * python bbox diagonal); the ordered "
                 "(feature id, error class) list exact, an error class being the message with every "
                 "number masked as # and whitespace collapsed, after the repository root is replaced "
                 "by $REPO. An import fixture is imported through the engine's own import op first; "
                 "the reply's fields other than geom must equal python's.",
    }, cases)


# --- plugin ops (diff_plugin_ops.py) ------------------------------------------


def zip_entry(name, data):
    """An entry's digest, and for a 3MF model what compare_model accepts in place
    of equal bytes: the model with its triangle lists blanked, and per object the
    triangle count, area, signed volume and free edges."""
    import diff_plugin_ops as DP

    entry = {"name": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    if name.endswith(".model"):
        text = data.decode("utf-8")
        skeleton = DP.TRIANGLES.sub("<triangles/>", text)
        objects = []
        for v, t in zip(DP.VERTICES.findall(text), DP.TRIANGLES.findall(text)):
            area, vol, boundary = DP._mesh_measure(v, t)
            objects.append({"triangles": t.count("<triangle"),
                            "trianglesSha256": hashlib.sha256(t.encode("utf-8")).hexdigest(),
                            "area": area, "volume": vol,
                            "freeEdges": [[int(i), int(j)] for i, j in boundary]})
        entry["skeletonSha256"] = hashlib.sha256(skeleton.encode("utf-8")).hexdigest()
        entry["objects"] = objects
    return entry


POINT_QUANTUM = 1e-5


def freeze_plugin_ops(name, corpus_file):
    import diff_plugin_ops as DP

    corpus_path = os.path.join(CORPUS_DIR, corpus_file)
    with open(corpus_path, encoding="utf-8") as fh:
        corpus = json.load(fh)
    exports, shapes = corpus.get("exports", []), corpus.get("shapes", [])
    work = tempfile.mkdtemp(prefix="freeze-plugin-ops-")
    blob_dir = os.path.join(work, "blobs")
    os.makedirs(blob_dir)
    os.environ["FUNDACAD_BLOB_DIR"] = blob_dir
    roots = [(work, "$WORK"), (REPO_ROOT, "$REPO")]
    cases = {}
    try:
        prepared = [DP.prepare_export(e, i, work) for i, e in enumerate(exports)]
        py = DP.run_engine("", prepared, shapes, work, "py")
        for e in prepared:
            path, reply = py[("export", e["name"])]
            case = {"op": "exportWith", "ok": bool(reply.get("ok"))}
            if not reply.get("ok"):
                case["error"] = normalise_all(reply.get("error"), roots)
            else:
                res = reply["result"]
                case["info"] = normalise_all(res.get("info"), roots)
                case["warnings"] = normalise_all(res.get("warnings"), roots)
                with zipfile.ZipFile(path) as z:
                    case["entries"] = [zip_entry(n, z.read(n)) for n in z.namelist()]
            cases[e["name"]] = case
        for s in shapes:
            reply, rebuilt = py[("shape", s["name"])]
            case = {"op": "generateShape", "ok": bool(reply.get("ok"))}
            if not reply.get("ok"):
                case["error"] = normalise_all(reply.get("error"), roots)
            else:
                r = reply["result"]
                for key in ("solid", "solids", "valid", "faces"):
                    case[key] = r.get(key)
                case["volume"] = sig(r["volume"], 15)
                case["bbox"] = {c: [fixed(x, 9) for x in r["bbox"][c]] for c in ("min", "max")}
                if "mesh" in r:
                    m = r["mesh"]
                    points = DP.sorted_points(m)
                    case["mesh"] = {
                        "triangles": len(m["indices"]) // 3,
                        "vertices": len(points),
                        "points": quantised_columns(points, POINT_QUANTUM) if points else "",
                        "normals": bool(m.get("normals")),
                    }
            if rebuilt is not None:
                bodies = ((rebuilt or {}).get("result") or {}).get("bodies") or []
                case["rebuilt"] = {
                    "bodies": len(bodies),
                    "volume": sig(sum(H.mesh_volume(b["positions"], b["indices"]) for b in bodies), 10),
                }
            cases[s["name"]] = case
    finally:
        shutil.rmtree(work, ignore_errors=True)
    write_golden(name, {
        "kind": "plugin-ops",
        "tool": "sidecar/tools/diff_plugin_ops.py",
        "corpus": rel(corpus_path),
        "corpusSha256": corpus_sha256(corpus_path),
        "tolerances": {"volumeRel": DP.VOLUME_REL_TOL, "bboxAbs": DP.BBOX_ABS_TOL,
                       "meshAbs": DP.MESH_ABS_TOL, "importVolumeRel": DP.IMPORT_VOLUME_REL_TOL},
        "rules": "exportWith: ok exact, the error exact, info and warnings exact, the written path's "
                 "file name the requested one, the zip entry names in order and every entry's "
                 "sha256, except that a .model entry whose bytes differ passes when the model with its "
                 "triangle lists blanked is identical and every object has the same triangle count, "
                 "area and signed volume to 1e-9 and the same free edges (the host mesher's other "
                 "diagonal). generateShape: ok and the error exact; solid, solids, valid, faces exact; "
                 "volume within volumeRel * |python|; bbox corners within bboxAbs; the preview mesh's "
                 "triangle count exact and its vertices as a sorted list each within meshAbs; normals "
                 "present on both or neither; a stored blob rebuilt as an import to the same body "
                 "count and a mesh volume within importVolumeRel. $WORK stands for the run's "
                 "temporary folder, $REPO for the repository root. The preview mesh's sorted points "
                 "are integers of pointQuantum, the fifth decimal the engine rounds them to, as IVEC.",
        "pointQuantum": POINT_QUANTUM,
        "encoding": IVEC,
    }, cases)


# --- texture meshes (diff_meshes.py) ------------------------------------------

POSITION_QUANTUM = 1e-6
NORMAL_QUANTUM = 1e-5
IVEC = ("base64 of zlib of the LEB128 varints of the zigzag of the successive differences of "
        "an integer array; an (n, 3) array is stored column by column")


def ivec(values):
    """An integer array as IVEC describes, a tenth of its JSON size or less."""
    a = np.asarray(values, dtype=np.int64).ravel()
    d = np.diff(a, prepend=np.int64(0))
    z = ((d << 1) ^ (d >> 63)).astype(np.uint64)
    out = bytearray()
    for v in z.tolist():
        while v >= 0x80:
            out.append((v & 0x7F) | 0x80)
            v >>= 7
        out.append(v)
    return base64.b64encode(zlib.compress(bytes(out), 9)).decode("ascii")


def quantised_columns(values, quantum):
    a = np.rint(np.asarray(values, dtype=float).reshape(-1, 3) / quantum).astype(np.int64)
    return ivec(a.T)


def mesh_golden(P, I):
    return {"vertices": len(P), "triangles": len(I),
            "positions": quantised_columns(P, POSITION_QUANTUM),
            "indices": ivec(np.asarray(I, dtype=np.int64))}


def flat_vertices(P, I):
    """diff_meshes.py's normal exemption, a once-used vertex of a triangle of no
    area, measured here on the float64 positions as the tool measures it."""
    import diff_meshes as DM

    if not len(I):
        return []
    area = np.linalg.norm(np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]]), axis=1) / 2
    uses = np.bincount(I.ravel(), minlength=len(P))
    flat = np.zeros(len(P), dtype=bool)
    flat[I[area < DM.DEGENERATE_AREA].ravel()] = True
    flat &= uses == 1
    return np.nonzero(flat)[0].tolist()


def indexed_stl(path):
    """An STL's triangles with coincident corners shared, which is lossless for
    every check diff_meshes.py runs on it and a third of the size."""
    import diff_meshes as DM

    P, _ = DM.read_stl(path)
    uniq, inverse = np.unique(P, axis=0, return_inverse=True)
    return uniq, inverse.reshape(-1, 3)


def freeze_meshes(name, corpus_file):
    import diff_meshes as DM

    corpus_path = os.path.join(CORPUS_DIR, corpus_file)
    with open(corpus_path, encoding="utf-8") as fh:
        docs = json.load(fh)["documents"]
    DM.absolute_image_paths(docs)
    work = tempfile.mkdtemp(prefix="freeze-meshes-")
    roots = [(REPO_ROOT, "$REPO"), (work, "$WORK")]
    cases = {}
    try:
        py = DM.run_engine("", docs, work, "py")
        for d in docs:
            got = py[d["name"]]
            first = got["first"]
            case = {"ok": bool(first.get("ok")), "bodies": {}}
            for bid, b in sorted(DM.bodies(first).items()):
                P, I, F, N = DM.payload_mesh(b)
                body = mesh_golden(P, I)
                body["faceTriangles"] = (np.bincount(F).tolist() if len(F) else [])
                body["normals"] = quantised_columns(N, NORMAL_QUANTUM) if len(N) else ""
                body["flatVertices"] = flat_vertices(P, I)
                body["faceColorSlots"] = b.get("faceColorSlots")
                case["bodies"][bid] = body
            a, again = DM.bodies(first), DM.bodies(got["again"])
            case["pythonEtagsStable"] = ({k: v.get("etag") for k, v in a.items()}
                                         == {k: v.get("etag") for k, v in again.items()})
            export = got["export"]
            ex = {"ok": bool(export.get("ok"))}
            if not export.get("ok"):
                ex["error"] = normalise_all(export.get("error"), roots)
            else:
                ex["warnings"] = normalise_all((export.get("result") or {}).get("warnings"), roots)
                P, I = indexed_stl(got["stl"])
                ex.update(mesh_golden(P, I))
            case["export"] = ex
            cases[d["name"]] = case
    finally:
        shutil.rmtree(work, ignore_errors=True)
    write_golden(name, {
        "kind": "meshes",
        "tool": "sidecar/tools/diff_meshes.py",
        "corpus": rel(corpus_path),
        "corpusSha256": corpus_sha256(corpus_path),
        "rebuildTolerance": DM.TOLERANCE,
        "positionQuantum": POSITION_QUANTUM,
        "normalQuantum": NORMAL_QUANTUM,
        "tolerances": {"vertex": DM.VERTEX_TOL, "surface": DM.SURFACE_TOL, "normal": DM.NORMAL_TOL,
                       "degenerateArea": DM.DEGENERATE_AREA, "surfaceNeighbours": 24},
        "rules": "Per body of the viewport rebuild: the body ids exact, the triangle count of every "
                 "face id exact, every vertex within vertex of the other side's nearest vertex both "
                 "ways, every triangle centroid within surface of the other side's surface (the "
                 "nearest of the triangles whose centroids are the surfaceNeighbours closest), the "
                 "normals of vertices both sides placed within vertex of each other within normal "
                 "(the closest of the coincident candidates, skipping a once-used vertex of a "
                 "triangle below degenerateArea), faceColorSlots exact. The ASCII STL export: ok, the "
                 "error and the warnings exact, then the same triangle count, vertex and surface "
                 "checks. Etags, checked on the candidate alone: a second identical rebuild keeps "
                 "every etag, and a texture 1.5 times deeper changes the etag of every body whose "
                 "positions it changed. Positions are stored as integers of positionQuantum and "
                 "normals of normalQuantum, both as IVEC, the STL with coincident corners shared; "
                 "flatVertices are the vertices the normal check skips, taken on python's float64 "
                 "positions.",
        "encoding": IVEC,
    }, cases)


# --- fillet corpora (eval_fillet_corpus.py) -----------------------------------


def freeze_fillet(name, corpus_file):
    import eval_fillet_corpus as EF

    corpus_path = os.path.join(CORPUS_DIR, corpus_file)
    data, cases_in = EF._load(corpus_path)
    cases = {}
    for c in cases_in:
        r = EF.evaluate([c])
        if r["selector_miss"]:
            outcome = "selector-miss"
        elif r["failed"]:
            outcome = "fail"
        else:
            outcome = "pass"
        entry = {"outcome": outcome, "band": c["band"]}
        if outcome == "fail":
            entry["message"] = next(iter(r["error_messages"]))
            entry["taxonomy"] = next(k for k in ("per_edge", "combination", "other") if r[k])
        cases[c["id"]] = entry
    failed = sorted(k for k, v in cases.items() if v["outcome"] == "fail")
    write_golden(name, {
        "kind": "fillet",
        "tool": "sidecar/tools/eval_fillet_corpus.py",
        "corpus": rel(corpus_path),
        "corpusSha256": corpus_sha256(corpus_path),
        "corpusSelfHash": data.get("self_hash"),
        "tolerances": {"volumeRel": EF.VOLUME_TOL},
        "summary": {"count": len(cases), "failed": len(failed),
                    "selectorMiss": sum(v["outcome"] == "selector-miss" for v in cases.values()),
                    "failedIds": failed},
        "rules": "Every case rebuilt and scored as eval_fillet_corpus.py scores it: a selector miss "
                 "(an error saying no edge found) is counted apart, any other error of the blend "
                 "feature fails, and so does a result that is not one valid solid, has fewer faces "
                 "than min_faces (else pre_op_faces + n_edges), or removes a volume that is not "
                 "positive or is more than volumeRel off the reference. Each case's outcome, pass, "
                 "fail or selector-miss, must equal python's.",
    }, cases)


# --- selector survival (eval_selector_survival.py) ----------------------------


def freeze_selectors(name, corpus_file):
    import contextlib

    import eval_selector_survival as ES
    import geom_select as gs

    tuning = os.path.join(H.SIDECAR_DIR, "selector_tuning.json")
    gs.configure(tuning)
    corpus_path = os.path.join(CORPUS_DIR, corpus_file)
    with open(corpus_path, encoding="utf-8") as fh:
        corpus = json.load(fh)
    cases, outcomes = {}, []
    with contextlib.redirect_stdout(sys.stderr):
        for c in corpus["cases"]:
            o = ES.score_case(c)
            outcomes.append((c["category"], o))
            cases[c["id"]] = {"category": c["category"], "outcome": o}
    metrics = ES.aggregate(outcomes)
    write_golden(name, {
        "kind": "selectors",
        "tool": "sidecar/tools/eval_selector_survival.py",
        "corpus": rel(corpus_path),
        "corpusSha256": corpus_sha256(corpus_path),
        "tuning": "the shipped selector tuning (sidecar/selector_tuning.json when frozen)",
        "metrics": metrics,
        "rules": "Every case scored as eval_selector_survival.py scores it: invalid when the frozen "
                 "key does not pin exactly one entity of the rebuilt part, survive when the resolver's "
                 "first pick has the frozen key, else miss. Each case's outcome must equal python's, "
                 "and so must every metric (rates rounded to six places).",
    }, cases)


# --- the MCP server (crates/fundacad-mcp/tools/diff_servers.py) ---------------


def posix_paths(text, args):
    """An absolute POSIX path argument, and its folder, as the server resolved them
    on this machine (a drive letter on Windows) put back as given, which the Rust
    test does to its own replies as well."""
    for value in args.values():
        if isinstance(value, str) and value.startswith("/"):
            for p in (value, os.path.dirname(value)):
                text = text.replace(os.path.abspath(p), p)
    return text


def freeze_mcp(name):
    mcp_tools = os.path.join(REPO_ROOT, "crates", "fundacad-mcp", "tools")
    sys.path.insert(0, mcp_tools)
    import diff_servers as DS
    from client import _load_script

    script_path = os.path.join(mcp_tools, "parity.jsonl")
    script = _load_script(script_path)
    replies = asyncio.run(DS.replies(os.path.join(DS.PY_MCP, "server.py"), script))
    cases = [{"tool": tool, "args": step.get("args") or {}, "text": posix_paths(text, step.get("args") or {}),
              "isError": is_error}
             for step, (tool, text, is_error) in zip(script, replies)]
    write_golden(name, {
        "kind": "mcp",
        "tool": "crates/fundacad-mcp/tools/diff_servers.py",
        "corpus": rel(script_path),
        "corpusSha256": corpus_sha256(script_path),
        "rules": "The script replayed on one fresh server, private (FUNDACAD_MCP_MODE=standalone, a "
                 "session file that cannot exist): every call's text (text blocks joined by a "
                 "newline) and isError must equal python's word for word, after an absolute POSIX path "
                 "argument and its folder, as the server resolved them, are put back as given.",
    }, cases)


# --- op coverage (e2e_coverage.py) --------------------------------------------


def coverage_checks():
    """e2e_coverage.py's EXPLICIT_CHECKS as data, in its order. A measure names a
    procedure the checker runs; an assert is (unit, kind, expected), and a delta
    kind's expected may be {"timesPre": k}, k times the pre measure."""
    from build123d import Box

    from builder import _shape_to_brep_b64

    pi = math.pi

    def box(bid="b", l=20, w=20, h=20):
        return {"id": bid, "type": "box", "length": l, "width": w, "height": h}

    def rect(sid, w, h, plane="XY", x=0, y=0):
        return {"id": sid, "type": "sketch", "plane": plane,
                "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]}

    def rebuild(features, **extra):
        return dict({"proc": "rebuild", "features": features}, **extra)

    top = {"kind": "face", "by": "normal", "dir": [0, 0, 1]}
    zedges = {"kind": "edge", "by": "axis", "axis": "Z"}
    datum = [box(), {"id": "dp", "type": "datumPlane", "plane": "XY", "offset": 5}]
    checks = [
        ("box", None, rebuild([box()]),
         [("box", "volume", 8000.0), ("box", "bbox", [-10, -10, -10, 10, 10, 10])]),
        ("cylinder", None, rebuild([{"id": "c", "type": "cylinder", "radius": 5, "height": 8}]),
         [("cylinder", "volume", pi * 25 * 8)]),
        ("sphere", None, rebuild([{"id": "s", "type": "sphere", "radius": 6}]),
         [("sphere", "volume", 4.0 / 3.0 * pi * 216)]),
        ("extrude", None, rebuild([rect("s", 20, 20), {"id": "e", "type": "extrude", "sketch": "s",
                                                        "distance": 10, "operation": "new"}]),
         [("extrude", "volume", 4000.0)]),
        ("revolve", None, rebuild([rect("s", 4, 10, plane="XZ", x=12),
                                   {"id": "rv", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 360}]),
         [("revolve", "volume", pi * (14 * 14 - 10 * 10) * 10)]),
        ("loft", None, rebuild([rect("s1", 20, 20),
                                {"id": "s2", "type": "sketch",
                                 "plane": {"origin": [0, 0, 15], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
                                 "entities": [{"type": "circle", "radius": 6}]},
                                {"id": "lf", "type": "loft", "sketches": ["s1", "s2"]}]),
         [("loft", "bodies_eq", 1), ("loft", "bbox", [-10, -10, 0, 10, 10, 15])]),
        ("shell", None, rebuild([rect("s", 20, 20),
                                 {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"},
                                 {"id": "sh", "type": "shell", "thickness": 2, "faces": top}]),
         [("shell", "bodies_eq", 1), ("shell", "bbox", [-10, -10, 0, 10, 10, 20])]),
        ("mirror", rebuild([box("b", 4, 4, 4), {"id": "mv", "type": "move", "dx": 20}]),
         rebuild([box("b", 4, 4, 4), {"id": "mv", "type": "move", "dx": 20},
                  {"id": "mr", "type": "mirror", "plane": "YZ"}]),
         [("mirror", "delta_volume", {"timesPre": 2})]),
        ("patternRect", rebuild([box("b", 4, 4, 4)]),
         rebuild([box("b", 4, 4, 4), {"id": "pr", "type": "patternRect", "countX": 3, "countY": 2,
                                      "spacingX": 10, "spacingY": 10}]),
         [("patternRect", "delta_volume", {"timesPre": 6})]),
        ("patternLinear", rebuild([box("b", 4, 4, 4)]),
         rebuild([box("b", 4, 4, 4), {"id": "pl", "type": "patternLinear", "count": 3, "spacing": 10,
                                      "axis": "X"}]),
         [("patternLinear", "delta_volume", {"timesPre": 3})]),
        ("patternCircular", rebuild([box("b", 2, 2, 2), {"id": "mv", "type": "move", "dx": 20}]),
         rebuild([box("b", 2, 2, 2), {"id": "mv", "type": "move", "dx": 20},
                  {"id": "pc", "type": "patternCircular", "count": 4, "angle": 360, "axis": "Z"}]),
         [("patternCircular", "delta_volume", {"timesPre": 4})]),
        ("scale", rebuild([box()]), rebuild([box(), {"id": "sc", "type": "scale", "factor": 2}]),
         [("scale", "delta_volume", {"timesPre": 8})]),
        ("move", rebuild([box()]), rebuild([box(), {"id": "mv", "type": "move", "dx": 50}]),
         [("move", "delta_bbox", [40, -10, -10, 60, 10, 10])]),
        ("removeBody", rebuild([box(), {"id": "c", "type": "cylinder", "radius": 4, "height": 30}]),
         rebuild([box(), {"id": "c", "type": "cylinder", "radius": 4, "height": 30},
                  {"id": "rm", "type": "removeBody", "bodies": ["body2"]}]),
         [("removeBody", "delta_bodies", 1)]),
        ("computeAll", None, rebuild([box()], op="computeAll", extra={"revision": 1}),
         [("computeAll", "bodies_eq", 1), ("computeAll", "volume", 8000.0)]),
        ("interference", None,
         {"proc": "interference", "features": [box("b1"), box("b2"), {"id": "mv", "type": "move", "dx": 10}]},
         [("interference", "pairs_eq", 1)]),
        ("export", None, {"proc": "exportReimport", "features": [box()], "then": []},
         [("export", "volume", 8000.0)]),
        ("fillet", None, rebuild([box(), {"id": "fl", "type": "fillet", "edges": zedges, "radius": 2}]),
         [("fillet", "volume", 8000.0 - 4 * (4 - pi) * 20), ("fillet", "bodies_eq", 1)]),
        ("chamfer", None, rebuild([box(), {"id": "ch", "type": "chamfer", "edges": zedges, "distance": 2}]),
         [("chamfer", "volume", 7840.0), ("chamfer", "bodies_eq", 1)]),
        ("draft", None, rebuild([box(), {"id": "dr", "type": "draft",
                                         "faces": {"kind": "face", "by": "normal", "dir": [1, 0, 0]},
                                         "angle": 10, "axis": "Z"}]),
         [("draft", "volume", 7294.692), ("draft", "bodies_eq", 1)]),
        ("hole", None, rebuild([box(), {"id": "ho", "type": "hole", "diameter": 4, "extent": "through",
                                        "face": {"kind": "face", "by": "nearest", "point": [0, 0, 10]},
                                        "points": [[-5, 0, 10], [5, 0, 10]]}]),
         [("hole", "volume", 8000.0 - 2 * pi * 4 * 20), ("hole", "bodies_eq", 1)]),
        ("sweep", None, rebuild([
            {"id": "pa", "type": "sketch", "plane": "XY",
             "entities": [{"type": "line", "x1": 0, "y1": 0, "x2": 20, "y2": 0}]},
            {"id": "pr", "type": "sketch", "plane": "YZ",
             "entities": [{"type": "circle", "radius": 3, "x": 0, "y": 0}]},
            {"id": "sw", "type": "sweep", "profile": "pr", "path": "pa"}]),
         [("sweep", "volume", pi * 9 * 20), ("sweep", "bodies_eq", 1)]),
        ("simplifyMesh", None, {"proc": "exportReimport", "features": [box()],
                                "then": [{"id": "sm", "type": "simplifyMesh", "tolerance": 1}]},
         [("simplifyMesh", "volume", 8000.0), ("simplifyMesh", "bodies_eq", 1)]),
        ("split", None, rebuild(datum + [{"id": "sp", "type": "split", "planeId": "dp", "keep": "both"}]),
         [("split", "bodies_eq", 2)]),
        ("datumPlane", None, rebuild(datum + [{"id": "sp", "type": "split", "planeId": "dp", "keep": "top"}]),
         [("datumPlane", "volume", 2000.0)]),
        ("sketch", None, rebuild([rect("s", 12, 8), {"id": "e", "type": "extrude", "sketch": "s",
                                                     "distance": 5, "operation": "new"}]),
         [("sketch", "volume", 480.0), ("sketch", "bbox", [-6, -4, 0, 6, 4, 5])]),
        ("boolean", None, rebuild([box("b1"), box("b2"), {"id": "mv", "type": "move", "dx": 10},
                                   {"id": "cb", "type": "boolean", "operation": "join",
                                    "target": "body1", "tools": ["body2"]}]),
         [("boolean", "volume", 12000.0), ("boolean", "bodies_eq", 1)]),
        ("press-pull", None, rebuild([box(), {"id": "pp", "type": "press-pull", "operation": "join",
                                              "distance": 5, "face": top}]),
         [("press-pull", "volume", 10000.0), ("press-pull", "bbox", [-10, -10, -10, 10, 10, 15])]),
        ("offsetFace", None, rebuild([box(), {"id": "of", "type": "offsetFace", "distance": 2, "faces": top}]),
         [("offsetFace", "volume", 8800.0), ("offsetFace", "bbox", [-10, -10, -10, 10, 10, 12])]),
        ("thicken", None, rebuild([box(), {"id": "th", "type": "thicken", "thickness": 3, "faces": top}]),
         [("thicken", "volume", 9200.0), ("thicken", "bodies_eq", 2)]),
        ("deleteFace", None, rebuild([
            {"id": "bx", "type": "box", "length": 20, "width": 20, "height": 10},
            {"id": "ch", "type": "chamfer", "edges": {"kind": "edge", "by": "nearest", "point": [0, 10, 5]},
             "distance": 3},
            {"id": "df", "type": "deleteFace", "face": {"kind": "face", "by": "nearest", "point": [0, 8.5, 3.5]}}]),
         [("deleteFace", "volume", 4000.0), ("deleteFace", "bbox", [-10, -10, -5, 10, 10, 5])]),
        ("texture", None, rebuild([box(), {"id": "tx", "type": "texture", "kind": "ribs", "depth": 0.4,
                                           "scale": 2.0, "faces": top}]),
         [("texture", "volume", 8071.166667)]),
        ("projectGeometry", None, {
            "proc": "projectBbox", "features": [rect("s1", 20, 20), {"id": "e1", "type": "extrude", "sketch": "s1",
                                                                     "distance": 10, "operation": "new"}],
            "plane": "XY", "sources": [{"kind": "faceBoundary", "body": "body1",
                                        "sel": {"kind": "face", "by": "nearest", "point": [0, 0, 10]}}]},
         [("projectGeometry", "bbox", [-10, -10, 0, 10, 10, 0])]),
        ("migrateGeometry", None, {"proc": "migrate", "brep": _shape_to_brep_b64(Box(20, 20, 20))},
         [("migrateGeometry", "volume", 8000.0), ("migrateGeometry", "bbox", [-10, -10, -10, 10, 10, 10])]),
        ("inspect", None, {"proc": "inspectVolume",
                           "features": [{"id": "c1", "type": "cylinder", "radius": 10, "height": 20}]},
         [("inspect", "volume", math.pi * 100 * 20)]),
        ("generateShape", None, {"proc": "shapeVolume", "generator": "fastener", "output": "mesh",
                                 "params": {"kind": "washer", "units": "mm", "name": "w",
                                            "washer": {"type": "plain", "inner": 6.4, "outer": 12,
                                                       "thickness": 1.6}}},
         [("generateShape", "volume", math.pi / 4 * (12 ** 2 - 6.4 ** 2) * 1.6)]),
    ]
    return checks


async def coverage_measure(ws, m, fine):
    """One measure on the Python engine, as e2e_coverage.py's check functions take it."""
    def doc(features):
        return {"parameters": {}, "features": features}

    async def rebuild(features, op="rebuild", extra=None):
        reply = await H.ws_call(ws, op, "c", document=doc(features), tolerance=fine, **(extra or {}))
        if not reply.get("ok"):
            raise RuntimeError(f"{op} not ok: {reply.get('error')}")
        r = reply["result"]
        bodies = r.get("bodies") or []
        bb = r.get("bbox")
        return {"volume": sum(H.mesh_volume(b["positions"], b["indices"]) for b in bodies if b.get("positions")),
                "bodies": len(bodies), "bbox": [*bb["min"], *bb["max"]] if bb else None}

    proc = m["proc"]
    if proc == "rebuild":
        return await rebuild(m["features"], m.get("op", "rebuild"), m.get("extra"))
    if proc == "interference":
        reply = await H.ws_call(ws, "interference", "c", document=doc(m["features"]))
        if not reply.get("ok"):
            raise RuntimeError(f"interference not ok: {reply.get('error')}")
        return {"pairs": len(reply["result"].get("pairs") or [])}
    if proc == "exportReimport":
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "box.stl")
            exp = await H.ws_call(ws, "export", "c", document=doc(m["features"]), format="stl", path=path)
            if not exp.get("ok"):
                raise RuntimeError(f"export not ok: {exp.get('error')}")
            imp = await H.ws_call(ws, "import", "c", path=path, format="stl")
            if not imp.get("ok"):
                raise RuntimeError(f"reimport not ok: {imp.get('error')}")
            geom = imp["result"]["geom"]
        return await rebuild([{"id": "im", "type": "import", "format": "stl", "name": "box", "geom": geom}]
                             + m["then"])
    if proc == "projectBbox":
        reply = await H.ws_call(ws, "projectGeometry", "c", document=doc(m["features"]),
                                plane=m["plane"], sources=m["sources"])
        if not reply.get("ok"):
            raise RuntimeError(f"projectGeometry not ok: {reply.get('error')}")
        res = reply["result"]["results"]
        if not res or not res[0].get("ok"):
            raise RuntimeError(f"source not ok: {res}")
        curves = [e["curve"] for e in res[0]["curves"]]
        if not curves or not all(c.get("kind") == "line" for c in curves):
            raise RuntimeError(f"expected lines, got {curves}")
        xs = [v for c in curves for v in (c["x1"], c["x2"])]
        ys = [v for c in curves for v in (c["y1"], c["y2"])]
        return {"bbox": [min(xs), min(ys), 0, max(xs), max(ys), 0]}
    if proc == "migrate":
        reply = await H.ws_call(ws, "migrateGeometry", "c", items=[{"id": "legacy1", "brep": m["brep"]}])
        if not reply.get("ok") or reply["result"].get("failed") or not reply["result"].get("items"):
            raise RuntimeError(f"migrateGeometry not ok: {reply}")
        return await rebuild([{"id": "im", "type": "import", "format": "brep", "name": "legacy",
                               "geom": reply["result"]["items"][0]["geom"]}])
    if proc == "inspectVolume":
        reply = await H.ws_call(ws, "inspect", "c", document=doc(m["features"]))
        if not reply.get("ok"):
            raise RuntimeError(f"inspect not ok: {reply.get('error')}")
        bodies = reply["result"].get("bodies") or []
        if len(bodies) != 1:
            raise RuntimeError(f"{len(bodies)} bodies, expected 1")
        return {"volume": bodies[0].get("volume")}
    if proc == "shapeVolume":
        reply = await H.ws_call(ws, "generateShape", "c", generator=m["generator"], params=m["params"],
                                output=m["output"])
        if not reply.get("ok"):
            raise RuntimeError(f"generateShape not ok: {reply.get('error')}")
        return {"volume": reply["result"].get("volume")}
    raise ValueError(proc)


MEASURE_OF = {"volume": "volume", "delta_volume": "volume", "bbox": "bbox", "delta_bbox": "bbox",
              "bodies_eq": "bodies", "delta_bodies": "bodies", "pairs_eq": "pairs"}


def freeze_coverage(name):
    import websockets

    import e2e_coverage as E

    checks = coverage_checks()
    universe = sorted((H.parse_feature_handler_keys() | H.plugin_feature_type_keys() | H.parse_server_ops())
                      - E.EXCLUDED_OPS)
    cases = {}

    async def run(url):
        async with websockets.connect(url, max_size=H._MAX_WS) as ws:
            for order, (cname, pre, measure, asserts) in enumerate(checks):
                case = {"order": order, "measure": measure, "pre": pre, "asserts": []}
                try:
                    pre_got = await coverage_measure(ws, pre, E.FINE_TOL) if pre else None
                    got = await coverage_measure(ws, measure, E.FINE_TOL)
                    error = None
                except Exception as ex:
                    pre_got, got, error = None, None, f"{type(ex).__name__}: {ex}"
                for unit, kind, expected in asserts:
                    key = MEASURE_OF[kind]
                    entry = {"unit": unit, "kind": kind, "expected": expected}
                    if got is None:
                        entry["pythonRefused"] = error
                    else:
                        want = expected
                        p = pre_got[key] if pre_got else None
                        if isinstance(expected, dict):
                            want = expected["timesPre"] * p
                        why = E._judge(unit, kind, want, got[key], p)
                        entry["pythonActual"] = got[key]
                        entry["pythonCredited"] = why is None
                        if why:
                            entry["pythonRefused"] = why
                    case["asserts"].append(entry)
                cases[cname] = case

    with H.SpawnedServer() as srv:
        try:
            H.run(run(srv.url))
        finally:
            if sys.platform == "win32" and srv.proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(srv.pid)], capture_output=True)
    covered = sorted({a["unit"] for c in cases.values() for a in c["asserts"] if a.get("pythonCredited")}
                     & set(universe))
    print(f"coverage on the python engine: {len(covered)}/{len(universe)}")
    write_golden(name, {
        "kind": "coverage",
        "tool": "sidecar/tools/e2e_coverage.py",
        "universe": universe,
        "pythonCovered": covered,
        "fineTolerance": E.FINE_TOL,
        "tolerances": {"volumeRel": E.VOL_REL_TOL, "bboxAbs": E.BBOX_ABS_TOL},
        "rules": "e2e_coverage.py's explicit checks, in order, through register()'s gate: a unit is "
                 "credited only by an assertion against its hardcoded expected constant, an exact "
                 "body or pair count, a volume within volumeRel of it or a bbox within bboxAbs per "
                 "component; a transform, pattern, remove, scale or move unit only through a delta "
                 "kind that moved off its pre measure. The universe is python's (builder handlers, "
                 "plugin feature types and server ops, less the excluded ops), and every unit python "
                 "covered must be covered. The expected values are the tool's constants, not python "
                 "answers; pythonActual is kept for reference.",
    }, cases)


GOLDENS = {
    "engines": lambda: freeze_rebuilds("engines", "corpus_engines.json"),
    "plugins": lambda: freeze_rebuilds("plugins", "corpus_plugins.json"),
    "screws_ops": lambda: freeze_plugin_ops("screws_ops", "corpus_screws_ops.json"),
    "printing_ops": lambda: freeze_plugin_ops("printing_ops", "corpus_printing_ops.json"),
    "texture": lambda: freeze_meshes("texture", "corpus_texture.json"),
    "fillet": lambda: freeze_fillet("fillet", "corpus_fillet.json"),
    "fillet_regression": lambda: freeze_fillet("fillet_regression", "corpus_fillet_regression.json"),
    "selectors": lambda: freeze_selectors("selectors", "corpus_selectors.json"),
    "mcp_parity": lambda: freeze_mcp("mcp_parity"),
    "coverage": lambda: freeze_coverage("coverage"),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", help="comma separated: " + ",".join(GOLDENS))
    args = ap.parse_args()
    names = [n for n in (args.only or "").split(",") if n] or list(GOLDENS)
    for n in names:
        if n not in GOLDENS:
            raise SystemExit(f"no golden named {n}")
    for n in names:
        GOLDENS[n]()
    return 0


if __name__ == "__main__":
    sys.exit(main())
