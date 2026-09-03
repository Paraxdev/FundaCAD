"""Flattening 3D geometry onto a sketch plane, and recognising it again.

Split out of builder.py. Projecting an edge is the easy half; the hard half is
IDENTITY. A projected curve is a reference the user drew against, so on the next
rebuild it has to be matched back to the curve it came from even though the body
moved, the silhouette slid round a cylinder, or OCCT handed back the same arc
wound the other way. That is what the _curve_* comparisons are for, and why they
compare shape rather than endpoints alone.

Everything here is a LEAF: it takes shapes and a Plane and returns dicts. The
half that needs the feature tree — resolving what to project, and re-running it
per rebuild — stays in builder.py.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import Edge, Plane, Vector

from geom_select import _edge_curve
from sketch_build import _POLY_MAX_SEGS, _POLY_MIN_SEGS, _POLY_MM_PER_SEG

def _r6(v):
    """Round for the wire/document: 6 decimals, -0.0 normalized to 0.0."""
    return round(float(v), 6) + 0.0


def _project_pt(plane, p):
    """A world point projected into the plane's 2D frame (drop the local Z)."""
    l = plane.to_local_coords(p)
    return l.X, l.Y


def _project_edge_to_plane(edge, plane):
    """Project one located 3D edge onto `plane` → a ProjectedCurve dict.

    Exact where exactness survives projection: a line stays a line (degenerate
    view-aligned line → 2-point poly, never an error); a circle whose axis is
    parallel to the plane normal stays a circle (closed) or a 3-point arc
    (open). Everything else (tilted circle, ellipse, bspline) is sampled to a
    poly — build123d's position_at is arc-length parametrized, so samples are
    evenly spaced along the curve."""
    ct = _edge_curve(edge)
    if ct == "line":
        ax, ay = _project_pt(plane, edge.position_at(0))
        bx, by = _project_pt(plane, edge.position_at(1))
        ax, ay, bx, by = _r6(ax), _r6(ay), _r6(bx), _r6(by)
        # Degeneracy check on the ROUNDED endpoints: a ~1.4e-6 diagonal
        # projection passes a raw-value check yet collapses to a zero-length
        # line on the 1e-6 grid (StdFail in _build_sketch's line branch).
        if math.hypot(bx - ax, by - ay) < 1e-6:
            # edge parallel to the view direction: projects to a point
            return {"kind": "poly", "pts": [[ax, ay], [bx, by]]}
        return {"kind": "line", "x1": ax, "y1": ay, "x2": bx, "y2": by}
    if ct == "circle":
        from OCP.BRepAdaptor import BRepAdaptor_Curve

        circ = BRepAdaptor_Curve(edge.wrapped).Circle()
        d = circ.Axis().Direction()
        axis = Vector(d.X(), d.Y(), d.Z())
        if abs(axis.dot(plane.z_dir)) > 1 - 1e-6:
            if edge.is_closed:
                cx, cy = _project_pt(plane, edge.arc_center)
                return {"kind": "circle", "x": _r6(cx), "y": _r6(cy), "r": _r6(circ.Radius())}
            (x1, y1), (mx, my), (x2, y2) = (
                _project_pt(plane, edge.position_at(t)) for t in (0, 0.5, 1)
            )
            return {"kind": "arc", "x1": _r6(x1), "y1": _r6(y1), "x2": _r6(x2), "y2": _r6(y2),
                    "mx": _r6(mx), "my": _r6(my)}
    # tilted circle / ellipse / bspline / anything else: sampled fallback
    try:
        n = int(min(_POLY_MAX_SEGS, max(_POLY_MIN_SEGS, edge.length / _POLY_MM_PER_SEG)))
        samples = [edge.position_at(i / n) for i in range(n + 1)]
    except Exception:
        # length/position_at both run GCPnts_AbscissaPoint, which raises
        # Standard_ConstructionError on degenerate seam/pole edges (sphere seam
        # meridian, revolve pole) — the hazard tessellate._sample_by_param
        # hardens; walk the raw curve parameter instead
        from tessellate import _sample_by_param

        raw = _sample_by_param(edge, _POLY_MIN_SEGS)
        if raw is None:
            raise
        samples = [Vector(*q) for q in raw]
    pts = []
    for p in samples:
        x, y = _project_pt(plane, p)
        pts.append([_r6(x), _r6(y)])
    return {"kind": "poly", "pts": pts}


def _curve_close(a, b, tol=1e-4):
    """Structural compare of two ProjectedCurve dicts: same kind and every number
    within `tol` (the projection-refresh change tolerance). Polys compare
    pointwise; a length mismatch is a change."""
    if a.get("kind") != b.get("kind"):
        return False
    if a.get("kind") == "poly":
        pa, pb = a.get("pts") or [], b.get("pts") or []
        if len(pa) != len(pb):
            return False
        return all(
            abs(p[0] - q[0]) <= tol and abs(p[1] - q[1]) <= tol for p, q in zip(pa, pb)
        )
    return all(abs(a[k] - b[k]) <= tol for k in a if k != "kind")


def _curve_reversed(c):
    """The same ProjectedCurve traversed the other way (HLR can emit the same
    outline segment with either orientation across buckets/rebuilds)."""
    k = c.get("kind")
    if k == "line":
        return {"kind": "line", "x1": c["x2"], "y1": c["y2"], "x2": c["x1"], "y2": c["y1"]}
    if k == "arc":
        return {**c, "x1": c["x2"], "y1": c["y2"], "x2": c["x1"], "y2": c["y1"]}
    if k == "poly":
        return {"kind": "poly", "pts": list(reversed(c.get("pts") or []))}
    return c  # circle: orientation-free


def _curve_rep(c):
    """Three representative points (end, end, mid) for the nearest-curve metric.
    A circle has no ends: center twice + a radius-displaced point stand in."""
    k = c.get("kind")
    if k == "line":
        return (c["x1"], c["y1"]), (c["x2"], c["y2"]), \
            ((c["x1"] + c["x2"]) / 2, (c["y1"] + c["y2"]) / 2)
    if k == "arc":
        return (c["x1"], c["y1"]), (c["x2"], c["y2"]), (c["mx"], c["my"])
    if k == "circle":
        return (c["x"], c["y"]), (c["x"], c["y"]), (c["x"] + c["r"], c["y"])
    pts = c.get("pts") or [[0.0, 0.0]]
    return tuple(pts[0]), tuple(pts[-1]), tuple(pts[len(pts) // 2])


def _pt_dist(p, q):
    """Euclidean distance between two 2D points given as (x, y) pairs."""
    return math.hypot(p[0] - q[0], p[1] - q[1])


def _curve_dist(a, b):
    """Distance between two ProjectedCurves for silhouette nearest-matching:
    endpoint distances (orientation-insensitive) + midpoint distance. Different
    kinds never match (inf) — a resized cylinder's silhouette LINE must track a
    line, not the nearest rim poly."""
    if a.get("kind") != b.get("kind"):
        return float("inf")
    (a1, a2, am), (b1, b2, bm) = _curve_rep(a), _curve_rep(b)
    return min(
        _pt_dist(a1, b1) + _pt_dist(a2, b2),
        _pt_dist(a1, b2) + _pt_dist(a2, b1),
    ) + _pt_dist(am, bm)


def _curve_close_either(a, b):
    """_curve_close, orientation-insensitive: `a` matches `b` as-is or reversed."""
    return _curve_close(a, b) or _curve_close(_curve_reversed(a), b)


def _curve_oriented(c, cached):
    """`c` or its reverse — whichever endpoint order lies nearer `cached`'s.
    Matching is orientation-insensitive, but the ASSIGNED curve must keep the
    cached endpoint order: an HLR orientation flip on unchanged geometry would
    otherwise swap point indices 0/1 under endpoint-attached constraints/dims
    (and trip the orientation-sensitive emission gate in
    _recompute_projections)."""
    (c1, c2, _cm), (q1, q2, _qm) = _curve_rep(c), _curve_rep(cached)
    if _pt_dist(c1, q2) + _pt_dist(c2, q1) < _pt_dist(c1, q1) + _pt_dist(c2, q2):
        return _curve_reversed(c)
    return c


def _project_silhouette(shape, plane):
    """The visible outline (HLR) of a body projected onto `plane`, as a list of
    ProjectedCurve dicts in the plane's 2D frame.

    HLRBRep_Algo with an HLRAlgo_Projector built from the sketch plane's exact
    right-handed frame (gp_Ax2 sets Y = normal x xdir, matching the plane's
    y_dir) returns edges ALREADY in projector 2D coordinates (x, y, z=0) — no
    to_local_coords pass; _project_edge_to_plane against Plane.XY reuses the
    line/circle/arc-exactness + sampled-poly mapping unchanged.

    Buckets: VCompound (visible sharp edges) + OutLineVCompound (surface
    silhouettes). The probe's seam pitfall — a cylinder seam lying ON a
    silhouette generator moves that line INTO VCompound — is covered by this
    union, and probing shows OCCT promotes ANY outline-coincident regular edge
    the same way (a tangent edge seen edge-on lands in V too). Rg1LineV/RgNLineV
    are deliberately EXCLUDED: probing shows they only ever carry visible smooth/
    sewn edges NOT on the outline (a sphere's seam meridian, a tilted cylinder's
    seam generator) — stray interior curves that would split regions and break
    the sphere-projects-to-its-exact-circle contract."""
    from OCP.BRepLib import BRepLib
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
    from OCP.HLRAlgo import HLRAlgo_Projector
    from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    o, n, x = plane.origin, plane.z_dir, plane.x_dir
    ax2 = gp_Ax2(gp_Pnt(o.X, o.Y, o.Z), gp_Dir(n.X, n.Y, n.Z), gp_Dir(x.X, x.Y, x.Z))
    algo = HLRBRep_Algo()
    algo.Add(shape.wrapped if hasattr(shape, "wrapped") else shape)
    algo.Projector(HLRAlgo_Projector(ax2))
    algo.Update()
    algo.Hide()  # required — without it the visible/hidden buckets are empty
    hlr = HLRBRep_HLRToShape(algo)
    curves = []
    for comp in (hlr.VCompound(), hlr.OutLineVCompound()):
        if comp is None or comp.IsNull():
            continue
        ex = TopExp_Explorer(comp, TopAbs_EDGE)
        while ex.More():
            ed = TopoDS.Edge_s(ex.Current())
            ex.Next()
            # HLR edges carry only 2D curve-on-surface data; materialize a 3D
            # curve first — build123d's length/position_at SEGFAULT without it
            BRepLib.BuildCurves3d_s(ed)
            c = _project_edge_to_plane(Edge(ed), Plane.XY)
            if c["kind"] == "poly":
                xs = [p[0] for p in c["pts"]]
                ys = [p[1] for p in c["pts"]]
                if max(xs) - min(xs) < 1e-6 and max(ys) - min(ys) < 1e-6:
                    continue  # an edge seen end-on projects to a point: no curve
            # dedupe near-identical curves either way round (HLR emits the same
            # segment in several buckets for coincident geometry)
            if any(_curve_close_either(c, q) for q in curves):
                continue
            curves.append(c)
    return curves


def _assign_silhouette(sibs, fresh):
    """Assign one silhouette group's FRESH curve list to its sibling entities
    (the correspondence rule — documented in _recompute_projections' docstring).
    Returns {entity_id: curve-or-None}; None = stale. `sibs` arrive shortlex-
    sorted; `fresh` is None when the body itself no longer resolves."""
    if not fresh:
        return {e["id"]: None for e in sibs}
    remaining = list(fresh)
    out = {}
    movers = []
    for e in sibs:  # pass 1: cached-curve match (steady state / tiny drift)
        cached = e.get("curve") or {}
        m = next((c for c in remaining if _curve_close_either(c, cached)), None)
        if m is not None:
            out[e["id"]] = _curve_oriented(m, cached)
            remaining.remove(m)
        else:
            movers.append(e)
    # pass 2: nearest same-kind curve (a resized body's movers track), pairs
    # consumed in globally ascending _curve_dist order — greedy-per-sibling
    # would let a shortlex-earlier sibling steal another mover's clearly
    # nearer curve on an asymmetric move. Exact ties stay deterministic:
    # (dist, sibling shortlex position, HLR position).
    pairs = []
    for i, e in enumerate(movers):
        cached = e.get("curve") or {}
        for j, c in enumerate(remaining):
            dist = _curve_dist(c, cached)
            if dist < float("inf"):
                pairs.append((dist, i, j))
    taken_sibs = set()
    taken_curves = set()
    for _dist, i, j in sorted(pairs):
        if i in taken_sibs or j in taken_curves:
            continue
        e = movers[i]
        out[e["id"]] = _curve_oriented(remaining[j], e.get("curve") or {})
        taken_sibs.add(i)
        taken_curves.add(j)
    unmatched = [e for i, e in enumerate(movers) if i not in taken_sibs]
    remaining = [c for j, c in enumerate(remaining) if j not in taken_curves]
    for i, e in enumerate(unmatched):  # pass 3: positional; beyond the fresh set -> stale
        out[e["id"]] = remaining[i] if i < len(remaining) else None
    # Fresh curves left with NO sibling are DROPPED: a shape change can grow new
    # outline curves, but a refresh only updates existing entities — re-run the
    # Project pick to bring the new curves in (auto-adding entities from a
    # rebuild refresh is deferred).
    return out
