"""diff_plugin_ops.py, the protocol-level oracle for plugin ops that are not a rebuild.

diff_engines.py compares rebuilds. A plugin can also answer `exportWith` (an exporter
writing a file) and `generateShape` (a solid from parameters, outside any document),
and those replies are compared here, through both engines over WebSocket:

  exportWith     the reply (path, info, warnings, or the error sentence) and the file:
                 its zip entry names in order and every entry's bytes, a numeric token
                 of the mesh XML allowed to differ in its last printed digit only when
                 the two engines' export meshes differ by float noise.
  generateShape  the measured reply (solid, solids, valid, faces exact; volume and bbox
                 to tolerance), the preview mesh (triangle count exact, vertex positions
                 as a sorted set to 1e-5) and, for output "store", the stored blob
                 rebuilt as an import feature on its own engine, volume compared.

The corpus is JSON: {"exports": [...], "shapes": [...]}. An export may carry
"datadir": {relative path: json}, written to a temporary folder whose path replaces
"$DATADIR" anywhere in the options.

Usage (from sidecar/ with the sidecar venv):
  python tools/diff_plugin_ops.py --corpus tools/corpus_printing_ops.json --rust "path/to/fundacad-engine --ws"
"""

import argparse
import copy
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

import websockets

import harness_util as H

VOLUME_REL_TOL = 1e-6
BBOX_ABS_TOL = 1e-4
# one unit of the fifth decimal the preview mesh is rounded to, which float noise
# on either engine can tip a coordinate across
MESH_ABS_TOL = 1e-5 * (1 + 1e-9)
IMPORT_VOLUME_REL_TOL = 0.005

NUM = re.compile(r"-?\d+(?:\.\d+)?(?:e[+-]\d+)?")


def default_rust_cmd():
    exe = "fundacad-engine.exe" if os.name == "nt" else "fundacad-engine"
    repo = os.path.dirname(H.SIDECAR_DIR)
    target = os.environ.get("CARGO_TARGET_DIR") or os.path.join(repo, "target")
    path = os.path.join(target, "debug", exe)
    if not os.path.exists(path):
        raise SystemExit(f"no Rust engine at {path}: pass --rust or FUNDACAD_ENGINE_CMD")
    return f'"{path}" --ws'


def substitute(obj, token, value):
    if isinstance(obj, str):
        return obj.replace(token, value)
    if isinstance(obj, list):
        return [substitute(x, token, value) for x in obj]
    if isinstance(obj, dict):
        return {k: substitute(v, token, value) for k, v in obj.items()}
    return obj


def write_datadir(root, files):
    for rel, content in files.items():
        path = os.path.join(root, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            if isinstance(content, str):
                fh.write(content)
            else:
                json.dump(content, fh)


async def run_ops(url, exports, shapes, outdir, tag):
    replies = {}
    async with websockets.connect(url, max_size=H._MAX_WS, compression=None) as ws:
        for i, e in enumerate(exports):
            path = os.path.join(outdir, f"{tag}-{i}{e.get('suffix', '.3mf')}")
            replies[("export", e["name"])] = (path, await H.ws_call(
                ws, "exportWith", f"x{i}", document=e["document"], path=path,
                exporter=e["exporter"], options=e.get("options") or {}))
        for i, s in enumerate(shapes):
            reply = await H.ws_call(
                ws, "generateShape", f"g{i}", generator=s["generator"], params=s.get("params"),
                output=s.get("output", "mesh"), placement=s.get("placement"))
            rebuilt = None
            if s.get("output") == "store" and reply.get("ok"):
                geom = reply["result"]["geom"]
                doc = {"parameters": {}, "features": [{
                    "id": "f1", "type": "import", "format": "brep", "name": "generated",
                    "geom": geom, "solid": True}]}
                rebuilt = await H.ws_call(ws, "rebuild", f"r{i}", document=doc, tolerance=0.1, binary=False)
            replies[("shape", s["name"])] = (reply, rebuilt)
    return replies


def run_engine(cmd, exports, shapes, outdir, tag):
    with H.SpawnedServer(cmd=cmd) as srv:
        try:
            return H.run(run_ops(srv.url, exports, shapes, outdir, tag))
        finally:
            if sys.platform == "win32" and srv.proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(srv.pid)], capture_output=True)


def compare_text(a, b, what):
    """'' when equal, else the first difference. Numbers may differ in their last
    printed digit only."""
    if a == b:
        return []
    ta, tb = NUM.split(a), NUM.split(b)
    na, nb = NUM.findall(a), NUM.findall(b)
    if ta != tb or len(na) != len(nb):
        i = next((k for k, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
        return [f"{what} differs at char {i}: {b[max(0, i - 40):i + 40]!r} vs {a[max(0, i - 40):i + 40]!r}"]
    worst = 0
    for x, y in zip(na, nb):
        if x == y:
            continue
        fx, fy = float(x), float(y)
        # one unit in the sixth significant digit, what %.6g can move by
        ulp = 10 ** (math.floor(math.log10(max(abs(fx), abs(fy), 1e-300))) - 5)
        if abs(fx - fy) > ulp * 1.0000001:
            return [f"{what}: {y} vs {x}"]
        worst += 1
    return [f"{what}: {worst} numbers in their last digit"] if worst else []


TRIANGLES = re.compile(r"<triangles>(.*?)</triangles>", re.S)
VERTICES = re.compile(r"<vertices>(.*?)</vertices>", re.S)


def _mesh_measure(vertex_xml, triangle_xml):
    v = [tuple(map(float, m)) for m in re.findall(r'x="([^"]+)" y="([^"]+)" z="([^"]+)"', vertex_xml)]
    area = vol = 0.0
    edges = {}
    for t in re.findall(r'v1="(\d+)" v2="(\d+)" v3="(\d+)"', triangle_xml):
        a, b, c = (v[int(i)] for i in t)
        u = [b[k] - a[k] for k in range(3)]
        w = [c[k] - a[k] for k in range(3)]
        n = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
        area += math.sqrt(sum(x * x for x in n)) / 2
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
        for i, j in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            key = (i, j) if int(i) < int(j) else (j, i)
            edges[key] = edges.get(key, 0) + 1
    boundary = sorted(k for k, n in edges.items() if n == 1)
    return area, vol, boundary


def compare_model(a, b):
    """A 3MF model, where the engines' meshers may triangulate a face differently.

    The Python engine links OpenCASCADE 7.9.3 (OCP) and the Rust engine 7.8.1, whose
    BRepMesh can pick the other diagonal inside a planar face from the SAME nodes.
    That is the host's meshing, not the exporter's writing, so the triangles of an
    object may differ only that way: identical vertex XML and triangle count, the same
    area and signed volume to 1e-9 and the same free edges. Everything outside the
    triangle lists must be identical."""
    ta, tb = TRIANGLES.findall(a), TRIANGLES.findall(b)
    got = compare_text(TRIANGLES.sub("<triangles/>", a), TRIANGLES.sub("<triangles/>", b), "model")
    if got and not got[0].endswith("last digit"):
        return got, []
    notes = list(got)
    va, vb = VERTICES.findall(a), VERTICES.findall(b)
    if len(ta) != len(tb):
        return [f"model: {len(tb)} meshes vs {len(ta)}"], notes
    moved = 0
    for k, (x, y) in enumerate(zip(ta, tb)):
        if x == y:
            continue
        if x.count("<triangle") != y.count("<triangle"):
            return [f"model object {k}: {y.count('<triangle')} triangles vs {x.count('<triangle')}"], notes
        ma, mb = _mesh_measure(va[k], x), _mesh_measure(vb[k], y)
        if (abs(ma[0] - mb[0]) > 1e-9 * max(ma[0], 1.0) or abs(ma[1] - mb[1]) > 1e-9 * max(abs(ma[1]), 1.0)
                or ma[2] != mb[2]):
            return [f"model object {k}: area {mb[0]:.9g} volume {mb[1]:.9g} vs {ma[0]:.9g} {ma[1]:.9g}"], notes
        moved += 1
    if moved:
        notes.append(f"{moved} object(s) triangulated across other diagonals by the host mesher, same nodes, area, volume and free edges")
    return [], notes


def compare_export(py, rs):
    (ppath, preply), (rpath, rreply) = py, rs
    diffs, notes = [], []
    if preply.get("ok") != rreply.get("ok"):
        return [f"ok {rreply.get('ok')} vs {preply.get('ok')}: {rreply.get('error')} vs {preply.get('error')}"], notes
    if not preply.get("ok"):
        if preply.get("error") != rreply.get("error"):
            diffs.append(f"error {rreply.get('error')} vs {preply.get('error')}")
        return diffs, notes
    pres, rres = preply["result"], rreply["result"]
    for key in ("info", "warnings"):
        if pres.get(key) != rres.get(key):
            diffs.append(f"{key} {rres.get(key)} vs {pres.get(key)}")
    if os.path.basename(pres.get("path", "")) != os.path.basename(ppath) or \
            os.path.basename(rres.get("path", "")) != os.path.basename(rpath):
        diffs.append(f"path {rres.get('path')} vs {pres.get('path')}")
    with zipfile.ZipFile(ppath) as zp, zipfile.ZipFile(rpath) as zr:
        if zp.namelist() != zr.namelist():
            return diffs + [f"entries {zr.namelist()} vs {zp.namelist()}"], notes
        if zr.testzip() is not None:
            diffs.append("a corrupt zip entry")
        for name in zp.namelist():
            a, b = zp.read(name).decode("utf-8"), zr.read(name).decode("utf-8")
            if name.endswith(".model"):
                got, more = compare_model(a, b)
                diffs.extend(got)
                notes.extend(more)
                continue
            got = compare_text(a, b, name)
            (notes if got and got[0].endswith("last digit") else diffs).extend(got)
    return diffs, notes


def sorted_points(mesh):
    p = mesh.get("positions") or []
    return sorted(tuple(p[i:i + 3]) for i in range(0, len(p), 3))


def compare_shape(py, rs):
    (preply, prebuilt), (rreply, rrebuilt) = py, rs
    diffs = []
    if preply.get("ok") != rreply.get("ok"):
        return [f"ok {rreply.get('ok')} vs {preply.get('ok')}: {rreply.get('error')} vs {preply.get('error')}"]
    if not preply.get("ok"):
        if preply.get("error") != rreply.get("error"):
            diffs.append(f"error {rreply.get('error')} vs {preply.get('error')}")
        return diffs
    p, r = preply["result"], rreply["result"]
    for key in ("solid", "solids", "valid", "faces"):
        if p.get(key) != r.get(key):
            diffs.append(f"{key} {r.get(key)} vs {p.get(key)}")
    if abs(r["volume"] - p["volume"]) > VOLUME_REL_TOL * max(abs(p["volume"]), 1e-9):
        diffs.append(f"volume {r['volume']:.9g} vs {p['volume']:.9g}")
    for corner in ("min", "max"):
        for i in range(3):
            if abs(r["bbox"][corner][i] - p["bbox"][corner][i]) > BBOX_ABS_TOL:
                diffs.append(f"bbox {corner}[{i}] {r['bbox'][corner][i]:.6f} vs {p['bbox'][corner][i]:.6f}")
    if "mesh" in p:
        pm, rm = p["mesh"], r.get("mesh") or {}
        if len(pm["indices"]) != len(rm.get("indices", [])):
            diffs.append(f"triangles {len(rm.get('indices', [])) // 3} vs {len(pm['indices']) // 3}")
        else:
            pp, rp = sorted_points(pm), sorted_points(rm)
            if len(pp) != len(rp):
                diffs.append(f"vertices {len(rp)} vs {len(pp)}")
            else:
                worst = max((max(abs(a - b) for a, b in zip(x, y)) for x, y in zip(pp, rp)), default=0.0)
                if worst > MESH_ABS_TOL:
                    diffs.append(f"vertex positions off by {worst:.3g}")
        if bool(pm.get("normals")) != bool(rm.get("normals")):
            diffs.append("normals present on one engine only")
    if prebuilt is not None or rrebuilt is not None:
        def vol(reply):
            bodies = ((reply or {}).get("result") or {}).get("bodies") or []
            return sum(H.mesh_volume(b["positions"], b["indices"]) for b in bodies), len(bodies)
        (pv, pn), (rv, rn) = vol(prebuilt), vol(rrebuilt)
        if pn != rn or abs(pv - rv) > IMPORT_VOLUME_REL_TOL * max(pv, 1e-9):
            diffs.append(f"stored blob rebuilt to {rn} bodies {rv:.4f} vs {pn} bodies {pv:.4f}")
    return diffs


def table(rows, headers):
    widths = [max(len(str(r[i])) for r in rows + [headers]) for i in range(len(headers))]
    line = lambda r: "  ".join(str(c).ljust(w) for c, w in zip(r, widths)).rstrip()
    print(line(headers))
    print(line(["-" * w for w in widths]))
    for r in rows:
        print(line(r))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--rust", help="command that starts the Rust engine's WebSocket server")
    ap.add_argument("--only", help="comma separated case names")
    args = ap.parse_args()
    with open(args.corpus, encoding="utf-8") as fh:
        corpus = json.load(fh)
    only = set(n for n in (args.only or "").split(",") if n)
    exports = [e for e in corpus.get("exports", []) if not only or e["name"] in only]
    shapes = [s for s in corpus.get("shapes", []) if not only or s["name"] in only]
    rust_cmd = args.rust or os.environ.get("FUNDACAD_ENGINE_CMD") or default_rust_cmd()
    print(f"rust engine: {rust_cmd}\n")

    work = tempfile.mkdtemp(prefix="diff-plugin-ops-")
    blob_dir = os.path.join(work, "blobs")
    os.makedirs(blob_dir)
    os.environ["FUNDACAD_BLOB_DIR"] = blob_dir
    try:
        prepared = []
        for i, e in enumerate(exports):
            e = copy.deepcopy(e)
            if "datadir" in e:
                root = os.path.join(work, f"datadir{i}", "user", "OrcaSlicer")
                write_datadir(root, e["datadir"])
                e = substitute(e, "$DATADIR", root)
            e = substitute(e, "$MISSING", os.path.join(work, "no-such-folder"))
            prepared.append(e)
        py = run_engine("", prepared, shapes, work, "py")
        rs = run_engine(rust_cmd, prepared, shapes, work, "rs")
        rows, bad = [], 0
        for e in prepared:
            diffs, notes = compare_export(py[("export", e["name"])], rs[("export", e["name"])])
            bad += bool(diffs)
            rows.append(["exportWith", e["name"], "MISMATCH" if diffs else "match",
                         "; ".join(diffs or notes)])
        for s in shapes:
            diffs = compare_shape(py[("shape", s["name"])], rs[("shape", s["name"])])
            bad += bool(diffs)
            rows.append(["generateShape", s["name"], "MISMATCH" if diffs else "match", "; ".join(diffs)])
        table(rows, ["op", "case", "status", "detail"])
        print(f"\n{len(rows) - bad} match, {bad} mismatch")
        return 1 if bad else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
