"""Reading what the user picked: cylindrical holes, and circular openings in flat faces."""

import math

from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cylinder, GeomAbs_Plane
from OCP.TopAbs import TopAbs_EDGE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

import ptb_occ as g
from blends import _group_sels_by_body
from geom_select import resolve_faces

_SAMPLES = 16


def picked_faces(f, ctx, label):
    """[(body, [build123d Face])] for the feature's `faces`, grouped by the body each pick names."""
    sel = f.get("faces")
    if not sel:
        raise ValueError(f"{label}: pick at least one face")
    out = []
    for body, sels in _group_sels_by_body(sel, ctx, label):
        if body.get("shape") is None:
            raise ValueError(f"{label}: the target body has no solid")
        faces = resolve_faces(body["shape"], sels, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not faces:
            raise ValueError(f"{label}: the picked face is gone from {body['name']}")
        out.append((body, faces))
    return out


def _pt(p):
    return (p.X(), p.Y(), p.Z())


def edge_points(topods):
    pts = []
    ex = TopExp_Explorer(topods, TopAbs_EDGE)
    while ex.More():
        c = BRepAdaptor_Curve(TopoDS.Edge_s(ex.Current()))
        a, b = c.FirstParameter(), c.LastParameter()
        if math.isfinite(a) and math.isfinite(b):
            for i in range(_SAMPLES + 1):
                pts.append(_pt(c.Value(a + (b - a) * i / _SAMPLES)))
        ex.Next()
    return pts


def _canonical_axis(a):
    for c in a:
        if abs(c) > 1e-9:
            return a if c > 0 else g.mul(a, -1.0)
    return a


def cylinder_of(face):
    """(origin, axis, radius, t0, t1) of a cylindrical face, or None for any other surface."""
    s = BRepAdaptor_Surface(face.wrapped)
    if s.GetType() != GeomAbs_Cylinder:
        return None
    cyl = s.Cylinder()
    ax = cyl.Axis()
    o = _pt(ax.Location())
    a = _canonical_axis(g.unit(_pt(ax.Direction())))
    ts = [g.dot(g.sub(p, o), a) for p in edge_points(face.wrapped)]
    if not ts:
        return None
    return o, a, cyl.Radius(), min(ts), max(ts)


def holes_from_faces(shape, faces, label):
    """Merge picked cylinder faces into holes.

    A hole is often two half faces, and picking both must not cut twice. Each hole is a dict with
    `origin`, `axis`, `radius`, `t0`, `t1`, where the axis runs from t0 to t1.
    """
    holes = []
    for fc in faces:
        cyl = cylinder_of(fc)
        if cyl is None:
            raise ValueError(f"{label}: pick the inside face of a round hole, this face is not cylindrical")
        o, a, r, t0, t1 = cyl
        mid = g.lin(o, ((t0 + t1) / 2, a))
        if g.inside(shape, mid):
            raise ValueError(f"{label}: the picked cylinder is a boss, not a hole")
        tol = max(1e-4, r * 1e-4)
        for h in holes:
            if abs(h["radius"] - r) > tol or abs(abs(g.dot(h["axis"], a)) - 1.0) > 1e-6:
                continue
            off = g.sub(o, h["origin"])
            if g.norm(g.sub(off, g.mul(h["axis"], g.dot(off, h["axis"])))) > tol:
                continue
            s0 = g.dot(g.sub(g.lin(o, (t0, a)), h["origin"]), h["axis"])
            s1 = g.dot(g.sub(g.lin(o, (t1, a)), h["origin"]), h["axis"])
            lo, hi = min(s0, s1), max(s0, s1)
            if lo <= h["t1"] + tol and hi >= h["t0"] - tol:
                h["t0"], h["t1"] = min(h["t0"], lo), max(h["t1"], hi)
                break
        else:
            holes.append({"origin": o, "axis": a, "radius": r, "t0": t0, "t1": t1})
    return holes


def end_is_open(shape, hole, at_start, probe):
    """Whether the hole continues into air past one end, rather than stopping at a blind floor."""
    t = hole["t0"] - probe if at_start else hole["t1"] + probe
    return not g.inside(shape, g.lin(hole["origin"], (t, hole["axis"])))


def _circle_of_wire(wire_topods):
    """(center, radius) when every edge of the wire lies on one circle, else None."""
    center = radius = None
    ex = TopExp_Explorer(wire_topods, TopAbs_EDGE)
    n = 0
    while ex.More():
        c = BRepAdaptor_Curve(TopoDS.Edge_s(ex.Current()))
        if c.GetType() != GeomAbs_Circle:
            return None
        circ = c.Circle()
        cc, rr = _pt(circ.Location()), circ.Radius()
        if center is None:
            center, radius = cc, rr
        elif g.norm(g.sub(cc, center)) > 1e-4 or abs(rr - radius) > 1e-4:
            return None
        n += 1
        ex.Next()
    return (center, radius) if n else None


def plane_of(face):
    """(normal pointing out of the material, a point on the plane) for a planar face, or None."""
    s = BRepAdaptor_Surface(face.wrapped)
    if s.GetType() != GeomAbs_Plane:
        return None
    pln = s.Plane()
    n = g.unit(_pt(pln.Axis().Direction()))
    if face.wrapped.Orientation() == TopAbs_REVERSED:
        n = g.mul(n, -1.0)
    return n, _pt(pln.Location())


def circular_openings(face):
    """(center, radius) for every inner loop of a planar face that is a full circle."""
    out = []
    for w in face.inner_wires():
        circ = _circle_of_wire(w.wrapped)
        if circ is not None:
            out.append(circ)
    return out
