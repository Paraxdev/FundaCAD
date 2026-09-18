"""diff_meshes.py, the mesh-level oracle for plugin mesh passes (surface textures).

diff_engines.py compares a rebuild by its mesh volume and bbox, which a displaced
face can match while its triangles are wrong. This compares the meshes themselves,
through both engines over WebSocket, for every body of every corpus document:

  viewport  the rebuild payload (split creases, the viewport density cap): triangle
            count per face id exact, every vertex within VERTEX_TOL of the other
            engine's nearest vertex both ways, every triangle's centroid within
            SURFACE_TOL of the other engine's surface, and the normals of the
            triangles both engines made to NORMAL_TOL.
  export    the `export` op's ASCII STL of the same document (indexed, the export
            density cap): the same triangle count, vertex and surface checks.
  etags     a second rebuild of the same document keeps every etag on its engine; a
            texture's depth changed changes the etag of each body it is on, on both.

A triangle may differ between the engines without the surface differing: scipy's
Delaunay (Qhull) and the Rust port's delaunator break the tie inside a cell whose
four corners are co-circular differently. The surface check is what decides, a
diagonal that mattered would move a centroid off the other engine's surface.

Usage (from sidecar/ with the sidecar venv):
  python tools/diff_meshes.py --corpus ../tests/golden/corpus/corpus_texture.json --rust "path/to/fundacad-engine --ws"
"""

import argparse
import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import numpy as np
import websockets
from scipy.spatial import cKDTree

import harness_util as H

VERTEX_TOL = 1e-5
SURFACE_TOL = 1e-5
NORMAL_TOL = 1e-4
DEGENERATE_AREA = 1e-9
TOLERANCE = 0.1


def default_rust_cmd():
    exe = "fundacad-engine.exe" if os.name == "nt" else "fundacad-engine"
    repo = os.path.dirname(H.SIDECAR_DIR)
    target = os.environ.get("CARGO_TARGET_DIR") or os.path.join(repo, "target")
    path = os.path.join(target, "debug", exe)
    if not os.path.exists(path):
        raise SystemExit(f"no Rust engine at {path}: pass --rust or FUNDACAD_ENGINE_CMD")
    return f'"{path}" --ws'


def deeper(doc):
    """The document with every texture's depth changed, or None without one."""
    d = copy.deepcopy(doc)
    hit = False
    for f in d["features"]:
        if f.get("type") == "texture":
            f["depth"] = float(f.get("depth", 0.4)) * 1.5
            hit = True
    return d if hit else None


async def rebuild_docs(url, docs, outdir, tag):
    out = {}
    async with websockets.connect(url, max_size=H._MAX_WS, compression=None) as ws:
        for i, d in enumerate(docs):
            first = await H.ws_call(ws, "rebuild", f"a{i}", document=d["document"],
                                    tolerance=TOLERANCE, binary=False)
            again = await H.ws_call(ws, "rebuild", f"b{i}", document=d["document"],
                                    tolerance=TOLERANCE, binary=False)
            changed = None
            other = deeper(d["document"])
            if other is not None:
                changed = await H.ws_call(ws, "rebuild", f"c{i}", document=other,
                                          tolerance=TOLERANCE, binary=False)
            out[d["name"]] = {"first": first, "again": again, "changed": changed}
    return out


async def export_docs(url, docs, outdir, tag):
    out = {}
    async with websockets.connect(url, max_size=H._MAX_WS, compression=None) as ws:
        for i, d in enumerate(docs):
            path = os.path.join(outdir, f"{tag}-{i}.stl")
            export = await H.ws_call(ws, "export", f"e{i}", document=d["document"], format="stl",
                                     path=path, mesh={"binary": False})
            out[d["name"]] = {"export": export, "stl": path}
    return out


def spawned(cmd, job, docs, outdir, tag):
    with H.SpawnedServer(cmd=cmd) as srv:
        try:
            return H.run(job(srv.url, docs, outdir, tag))
        finally:
            if sys.platform == "win32" and srv.proc.poll() is None:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(srv.pid)], capture_output=True)


def run_engine(cmd, docs, outdir, tag):
    """The rebuilds and the exports each in a fresh engine. The Python engine keeps
    its built shapes, and OpenCASCADE keeps a shape's finest triangulation for any
    coarser request, so in one session an export would leave its triangles behind
    for the next rebuild's viewport mesh, and a rebuild its own for the export."""
    out = spawned(cmd, rebuild_docs, docs, outdir, tag)
    for name, got in spawned(cmd, export_docs, docs, outdir, tag).items():
        out[name].update(got)
    return out


def absolute_image_paths(docs):
    from diff_engines import absolute_image_paths as absolute

    absolute(docs)


def bodies(reply):
    return {b["id"]: b for b in ((reply or {}).get("result") or {}).get("bodies") or []}


def point_triangle_distance(p, a, b, c):
    """Distance from points p (n,3) to triangles (a, b, c) (n,3 each), exact."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(1), (ac * ap).sum(1)
    bp = p - b
    d3, d4 = (ab * bp).sum(1), (ac * bp).sum(1)
    cp = p - c
    d5, d6 = (ab * cp).sum(1), (ac * cp).sum(1)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    denom = va + vb + vc
    denom = np.where(np.abs(denom) < 1e-300, 1e-300, denom)
    v = vb / denom
    w = vc / denom
    q = a + ab * v[:, None] + ac * w[:, None]
    # outside the face region: fall back to the nearest of the three edges
    def seg(p0, p1):
        d = p1 - p0
        t = np.clip(((p - p0) * d).sum(1) / np.maximum((d * d).sum(1), 1e-300), 0.0, 1.0)
        return np.linalg.norm(p - (p0 + d * t[:, None]), axis=1)
    inside = (va >= 0) & (vb >= 0) & (vc >= 0)
    dist = np.where(inside, np.linalg.norm(p - q, axis=1), np.inf)
    return np.minimum(dist, np.minimum(seg(a, b), np.minimum(seg(b, c), seg(c, a))))


def surface_gap(P, I, Q, J):
    """The largest distance from a triangle centroid of (P, I) to the surface (Q, J)."""
    if not len(I) or not len(J):
        return 0.0 if len(I) == len(J) else float("inf")
    cen = P[I].mean(axis=1)
    qc = Q[J].mean(axis=1)
    k = min(24, len(J))
    _d, near = cKDTree(qc).query(cen, k=k)
    near = near.reshape(len(cen), k)
    worst = np.full(len(cen), np.inf)
    for col in range(k):
        t = J[near[:, col]]
        worst = np.minimum(worst, point_triangle_distance(cen, Q[t[:, 0]], Q[t[:, 1]], Q[t[:, 2]]))
    return float(worst.max())


def vertex_gap(P, Q):
    if not len(P) or not len(Q):
        return 0.0 if len(P) == len(Q) else float("inf")
    return max(float(cKDTree(Q).query(P)[0].max()), float(cKDTree(P).query(Q)[0].max()))


def compare_mesh(P, I, Q, J, what):
    diffs, notes = [], []
    if len(I) != len(J):
        return [f"{what}: {len(J)} triangles vs {len(I)}"], notes
    gap = vertex_gap(P, Q)
    if gap > VERTEX_TOL:
        diffs.append(f"{what}: a vertex {gap:.3g} from the other engine's nearest")
    s = max(surface_gap(P, I, Q, J), surface_gap(Q, J, P, I))
    if s > SURFACE_TOL:
        diffs.append(f"{what}: a triangle {s:.3g} off the other engine's surface")
    moved = unmatched(P[I], Q[J])
    if moved:
        notes.append(f"{what}: {moved} triangle(s) on the other diagonal, same surface")
    return diffs, notes


def unmatched(A, B):
    """Triangles of A (T, 3, 3) that B has no triangle on the same three corners
    for, the corners compared to VERTEX_TOL (one side travels as float32)."""
    if not len(A) or not len(B):
        return len(A)
    _d, j = cKDTree(B.mean(axis=1)).query(A.mean(axis=1))
    near = B[j]
    gaps = np.linalg.norm(A[:, :, None, :] - near[:, None, :, :], axis=3).min(axis=2).max(axis=1)
    return int((gaps > VERTEX_TOL).sum())


def payload_mesh(b):
    P = np.asarray(b.get("positions") or [], dtype=float).reshape(-1, 3)
    I = np.asarray(b.get("indices") or [], dtype=np.int64).reshape(-1, 3)
    F = np.asarray(b.get("faceIds") or [], dtype=np.int64)
    N = np.asarray(b.get("normals") or [], dtype=float).reshape(-1, 3)
    return P, I, F, N


def read_stl(path):
    pts = []
    with open(path, encoding="ascii", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if line.startswith("vertex"):
                pts.append([float(x) for x in line.split()[1:4]])
    P = np.asarray(pts, dtype=float).reshape(-1, 3)
    return P, np.arange(len(P), dtype=np.int64).reshape(-1, 3)


def compare_doc(py, rs):
    diffs, notes = [], []
    if py["first"].get("ok") != rs["first"].get("ok"):
        return [f"rebuild ok {rs['first'].get('ok')} vs {py['first'].get('ok')}"], notes
    pb, rb = bodies(py["first"]), bodies(rs["first"])
    if set(pb) != set(rb):
        return [f"bodies {sorted(rb)} vs {sorted(pb)}"], notes
    for bid in sorted(pb):
        P, I, F, N = payload_mesh(pb[bid])
        Q, J, G, M = payload_mesh(rb[bid])
        hp = np.bincount(F, minlength=1) if len(F) else np.zeros(1, int)
        hr = np.bincount(G, minlength=1) if len(G) else np.zeros(1, int)
        n = max(len(hp), len(hr))
        hp, hr = np.pad(hp, (0, n - len(hp))), np.pad(hr, (0, n - len(hr)))
        if not np.array_equal(hp, hr):
            bad = np.nonzero(hp != hr)[0]
            diffs.append(f"{bid}: face {bad[0]} has {hr[bad[0]]} triangles vs {hp[bad[0]]}"
                         + (f" ({len(bad)} faces differ)" if len(bad) > 1 else ""))
            continue
        d, nt = compare_mesh(P, I, Q, J, f"{bid} viewport")
        diffs += d
        notes += nt
        if len(N) and len(M) and len(N) == len(P) and len(M) == len(Q):
            # normals of the vertices both engines placed at the same point
            tree = cKDTree(P)
            dist, near = tree.query(Q)
            same = dist <= VERTEX_TOL
            # A split crease gives a vertex its triangle's own normal, and a
            # triangle of no area (three nodes on one line of the lattice) has
            # a normal made of rounding noise on either engine: not compared.
            # Measured on the reference's float64 positions.
            area = np.linalg.norm(np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]]), axis=1) / 2
            uses = np.bincount(I.ravel(), minlength=len(P))
            flat = np.zeros(len(P), dtype=bool)
            flat[I[area < DEGENERATE_AREA].ravel()] = True
            flat &= uses == 1
            # a split crease puts several vertices on one point with different
            # normals, so each is matched to the closest normal among them
            worst = 0.0
            for k in np.nonzero(same)[0]:
                cands = tree.query_ball_point(Q[k], VERTEX_TOL)
                gaps = [(float(np.abs(N[c] - M[k]).max()), c) for c in cands]
                gap, best = min(gaps)
                if flat[best]:
                    continue
                worst = max(worst, gap)
            if worst > NORMAL_TOL:
                diffs.append(f"{bid}: a normal off by {worst:.3g}")
        elif bool(len(N)) != bool(len(M)):
            diffs.append(f"{bid}: normals on one engine only")
        slots_p, slots_r = pb[bid].get("faceColorSlots"), rb[bid].get("faceColorSlots")
        if slots_p != slots_r:
            diffs.append(f"{bid}: faceColorSlots {slots_r} vs {slots_p}")
    for name, reply in (("py", py), ("rust", rs)):
        a, b = bodies(reply["first"]), bodies(reply["again"])
        if {k: v.get("etag") for k, v in a.items()} != {k: v.get("etag") for k, v in b.items()}:
            diffs.append(f"{name}: an etag changed on an identical rebuild")
        if reply["changed"] is not None:
            c = bodies(reply["changed"])
            textured = [k for k in a if a[k].get("etag") == c.get(k, {}).get("etag")
                        and a[k].get("positions") != (c.get(k) or {}).get("positions")]
            if textured:
                diffs.append(f"{name}: {textured} kept its etag with a deeper texture")
    if py["export"].get("ok") != rs["export"].get("ok"):
        diffs.append(f"export ok {rs['export'].get('ok')} vs {py['export'].get('ok')}: "
                     f"{rs['export'].get('error')} vs {py['export'].get('error')}")
    elif py["export"].get("ok"):
        wp = (py["export"].get("result") or {}).get("warnings")
        wr = (rs["export"].get("result") or {}).get("warnings")
        if wp != wr:
            diffs.append(f"export warnings {wr} vs {wp}")
        P, I = read_stl(py["stl"])
        Q, J = read_stl(rs["stl"])
        d, nt = compare_mesh(P, I, Q, J, "export")
        diffs += d
        notes += [n for n in nt if "diagonal" not in n]
    return diffs, notes


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
    ap.add_argument("--only", help="comma separated document names")
    args = ap.parse_args()
    with open(args.corpus, encoding="utf-8") as fh:
        docs = json.load(fh)["documents"]
    only = set(n for n in (args.only or "").split(",") if n)
    docs = [d for d in docs if not only or d["name"] in only]
    absolute_image_paths(docs)
    rust_cmd = args.rust or os.environ.get("FUNDACAD_ENGINE_CMD") or default_rust_cmd()
    print(f"rust engine: {rust_cmd}\n")
    work = tempfile.mkdtemp(prefix="diff-meshes-")
    try:
        py = run_engine("", docs, work, "py")
        rs = run_engine(rust_cmd, docs, work, "rs")
        rows, bad = [], 0
        for d in docs:
            diffs, notes = compare_doc(py[d["name"]], rs[d["name"]])
            bad += bool(diffs)
            rows.append([d["name"], "MISMATCH" if diffs else "match", "; ".join(diffs or notes)])
        table(rows, ["document", "status", "detail"])
        print(f"\n{len(rows) - bad} match, {bad} mismatch")
        return 1 if bad else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
