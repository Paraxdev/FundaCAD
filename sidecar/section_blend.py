"""Fillets and chamfers built from their cross-section, for the ones OCCT refuses.

BRepFilletAPI_MakeFillet walks the faces around an edge and gives up the moment
the blend has to leave them: a radius wider than the next face, a sliver face
0.08mm wide beside a cylinder seam, a blend that would have to end inside another
face. None of those make the rounding itself undefined, the section is the same
arc at every point along the edge.

So this builds that section directly. At each sample along the edge, the two
faces' normals give the ball centre, its two contact points and the arc between
them (or a curvature continuous curve for G2, or a straight chord for a chamfer).
The section is closed around the corner a little outside the body, the sections
are lofted into a solid, and the solid is cut from a convex edge or fused onto a
concave one. Whatever it runs into on the way is simply removed or filled, which
is the point: the size decides the shape, not the neighbouring topology.

What it does not do is OCCT's corner patches where several blends meet; each
edge's solid ends square at its own ends. It is the fallback, not the first try.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Curve2d, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepGProp import BRepGProp_Face
from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
from OCP.GC import GC_MakeArcOfCircle, GC_MakeSegment
from OCP.Geom import Geom_BezierCurve
from OCP.GeomAbs import GeomAbs_Line, GeomAbs_Plane
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.gp import gp_Lin, gp_Pnt, gp_Pnt2d, gp_Vec
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TColgp import TColgp_Array1OfPnt
from OCP.TColStd import TColStd_Array1OfReal
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_IN, TopAbs_ON, TopAbs_OUT, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_ListOfShape

from conic_blend import weight_scale


class SectionBlendError(ValueError):
    pass


class _DraftGaveUp(SectionBlendError):
    pass


# A G2 section has zero curvature where it meets the faces, so for the same
# setback it bulges less than an arc. Starting it this much further out makes a
# G2 blend of radius r look about as big as the G1 one.
G2_SETBACK = 1.55
G2_TENSION = 0.5


def _v(p):
    return gp_Vec(p.X(), p.Y(), p.Z())


def _p(v):
    return gp_Pnt(v.X(), v.Y(), v.Z())


class _Side:
    """One of the two faces along the edge: its surface, for normals and for
    projecting a point back onto it."""

    def __init__(self, face, edge):
        self.face = face
        self.props = BRepGProp_Face(face)
        self.surf = BRep_Tool.Surface_s(face)
        self.planar = BRepAdaptor_Surface(face).GetType() == GeomAbs_Plane
        self.pcurve = BRepAdaptor_Curve2d(edge, face)

    def normal_uv(self, u, v):
        p, n = gp_Pnt(), gp_Vec()
        self.props.Normal(u, v, p, n)
        if n.Magnitude() < 1e-12:
            raise SectionBlendError("a face normal degenerates along the edge")
        return n.Normalized()

    def normal_on_edge(self, t):
        uv = self.pcurve.Value(t)
        return self.normal_uv(uv.X(), uv.Y())

    def foot(self, pnt):
        """The nearest point on this face's surface, and the normal there."""
        if self.planar:
            return None
        proj = GeomAPI_ProjectPointOnSurf(pnt, self.surf)
        if proj.NbPoints() == 0:
            return None
        u, v = proj.LowerDistanceParameters()
        return proj.NearestPoint(), self.normal_uv(u, v)

    def contains(self, pnt, tol):
        proj = GeomAPI_ProjectPointOnSurf(pnt, self.surf)
        if proj.NbPoints() == 0:
            return False
        u, v = proj.LowerDistanceParameters()
        st = BRepClass_FaceClassifier(self.face, gp_Pnt2d(u, v), tol).State()
        return st in (TopAbs_IN, TopAbs_ON)


def _faces_of(shape, edge):
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, m)
    idx = m.FindIndex(edge)
    if idx == 0:
        raise SectionBlendError("the edge is not on this body")
    uniq = []
    for f in m.FindFromIndex(idx):
        if not any(f.IsSame(g) for g in uniq):
            uniq.append(TopoDS.Face_s(f))
    if len(uniq) != 2:
        raise SectionBlendError("the edge does not sit between two faces")
    return uniq


def _solve3(rows, rhs):
    (a, b, c), (d, e, f), (g, h, i) = rows
    det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
    if abs(det) < 1e-14:
        return None
    x = (rhs[0] * (e * i - f * h) - b * (rhs[1] * i - f * rhs[2]) + c * (rhs[1] * h - e * rhs[2])) / det
    y = (a * (rhs[1] * i - f * rhs[2]) - rhs[0] * (d * i - f * g) + c * (d * rhs[2] - rhs[1] * g)) / det
    z = (a * (e * rhs[2] - rhs[1] * h) - b * (d * rhs[2] - rhs[1] * g) + rhs[0] * (d * h - e * g)) / det
    return gp_Vec(x, y, z)


def _ball(P, T, sides, n0, s, r):
    """Centre and contact points of a ball of radius r touching both faces at the
    section through P. Exact for planes; on a curved face the contact is
    re-projected a few times so it lands on the surface itself."""
    Pv = _v(P)
    feet = [Pv, Pv]
    normals = list(n0)
    C = None
    for _ in range(4):
        rows = [
            (normals[0].X(), normals[0].Y(), normals[0].Z()),
            (normals[1].X(), normals[1].Y(), normals[1].Z()),
            (T.X(), T.Y(), T.Z()),
        ]
        rhs = [feet[0].Dot(normals[0]) - s * r, feet[1].Dot(normals[1]) - s * r, Pv.Dot(T)]
        nxt = _solve3(rows, rhs)
        if nxt is None:
            raise SectionBlendError("the faces are parallel here, there is no corner to round")
        C = nxt
        moved = False
        for k, side in enumerate(sides):
            got = side.foot(_p(C))
            if got is None:
                feet[k] = C + normals[k].Multiplied(s * r)
                continue
            q, n = got
            if n.Dot(normals[k]) < 0:
                n.Reverse()
            feet[k] = _v(q)
            normals[k] = n
            moved = True
        if not moved:
            break
    return C, feet, normals


def _wire(points, curve):
    """Closed section: the run from Q1 around the corner to Q2, then `curve`
    from Q2 back to Q1."""
    mk = BRepBuilderAPI_MakeWire()
    for a, b in zip(points, points[1:]):
        if a.Distance(b) < 1e-9:
            continue
        mk.Add(BRepBuilderAPI_MakeEdge(GC_MakeSegment(a, b).Value()).Edge())
    mk.Add(BRepBuilderAPI_MakeEdge(curve).Edge())
    if not mk.IsDone():
        raise SectionBlendError("the blend section did not close")
    return mk.Wire()


SKIN_STEPS = 4


def _skin(side, normal, a, b, offset, reach):
    """Points from `a` to `b` laid on `side`'s surface and pushed `offset` along
    its normal, SKIN_STEPS + 1 of them so every section has the same edges."""
    out = []
    for j in range(SKIN_STEPS + 1):
        q = _p(_v(a) + (_v(b) - _v(a)).Multiplied(j / SKIN_STEPS))
        foot, n = q, normal
        got = side.foot(q)
        if got is not None and got[0].Distance(q) < reach:
            foot, n = got
            if n.Dot(normal) < 0:
                n.Reverse()
        out.append(_p(_v(foot) + n.Multiplied(offset)))
    return out


def _corner(Q1, Q2, n1, n2, P):
    """Where the two faces' tangent lines through the contacts meet, in the
    section. P itself on planes; the closest approach of the two lines on
    curved faces, which is what the section's control polygon needs."""
    w1 = _v(P) - _v(Q1)
    w1 = w1 - n1.Multiplied(w1.Dot(n1))
    w2 = _v(P) - _v(Q2)
    w2 = w2 - n2.Multiplied(w2.Dot(n2))
    if w1.Magnitude() < 1e-9 or w2.Magnitude() < 1e-9:
        return P
    w1.Normalize()
    w2.Normalize()
    d = _v(Q1) - _v(Q2)
    a, b, e = w1.Dot(w1), w1.Dot(w2), w2.Dot(w2)
    c, f = w1.Dot(d), w2.Dot(d)
    den = a * e - b * b
    if abs(den) < 1e-12:
        return P
    t1 = (b * f - c * e) / den
    t2 = (a * f - b * c) / den
    m = (_v(Q1) + w1.Multiplied(t1) + _v(Q2) + w2.Multiplied(t2)).Multiplied(0.5)
    return _p(m)


def _clamp_to_axis(Q, K, P, axis):
    """Pull contacts that would reach past a rim's axis back along their tangent
    line onto it, so the face they sit on closes to a point instead of the
    section crossing the axis. True when any contact moved."""
    loc, d = gp_Vec(axis.Location().XYZ()), gp_Vec(axis.Direction())

    def radial(p):
        w = _v(p) - loc
        return w - d.Multiplied(w.Dot(d))

    out = radial(P)
    if out.Magnitude() < 1e-9:
        return False
    out.Normalize()
    rk = radial(K).Dot(out)
    moved = False
    for k in range(2):
        rq = radial(Q[k]).Dot(out)
        if rq >= 0 or rk <= 0:
            continue
        t = rk / (rk - rq)
        Q[k] = _p(_v(K) + (_v(Q[k]) - _v(K)).Multiplied(t))
        moved = True
    return moved


def _contacts(P, T, sides, s, kind, size, size2, continuity):
    """Where the section meets each face, the corner of its control polygon, and
    for a fillet the ball centre and the faces' normals at the contacts."""
    n1 = sides[0].normal_on_edge_cached
    n2 = sides[1].normal_on_edge_cached
    if kind == "chamfer":
        Q = []
        for k, d in enumerate((size, size2 if size2 else size)):
            q = _p(_v(P) + sides[k].inward_cached.Multiplied(d))
            got = sides[k].foot(q)
            Q.append(got[0] if got else q)
        return Q, P, None, [n1, n2]
    r = size * G2_SETBACK if continuity == "G2" else size
    C, feet, normals = _ball(P, T, sides, (n1, n2), s, r)
    Q = [_p(feet[0]), _p(feet[1])]
    return Q, _corner(Q[0], Q[1], normals[0], normals[1], P), C, normals


def _face_limits(P, T, sides, s, kind, size, size2, continuity):
    """How far each contact may sit from the corner before it runs off the end of
    its face, measured once in the middle of the edge, where the face test is
    sound (at the edge's ends the corner itself lies on another boundary).

    Only for a blend that adds material: filling on past a leg's end is trimmed
    flat at the end's plane, and six legs of that made a solid puck instead of
    six flares. A blend that removes material carves on past its faces."""
    for side in sides:
        side.limit = None
    if s > 0:
        return
    Q, K, _C, _n = _contacts(P, T, sides, s, kind, size, size2, continuity)
    tol = 1e-6
    for k, side in enumerate(sides):
        if side.contains(Q[k], tol):
            continue
        lo, hi = 0.0, 1.0
        for _ in range(24):
            mid = 0.5 * (lo + hi)
            if side.contains(_p(_v(K) + (_v(Q[k]) - _v(K)).Multiplied(mid)), tol):
                lo = mid
            else:
                hi = mid
        span = Q[k].Distance(K)
        if lo * span > 1e-6:
            side.limit = max(lo * span - min(1e-3 * size, 1e-2), 0.5 * lo * span)


def _clamp_to_limits(Q, K, sides):
    moved = False
    for k, side in enumerate(sides):
        limit = getattr(side, "limit", None)
        span = Q[k].Distance(K)
        if limit is None or span <= limit:
            continue
        q = _p(_v(K) + (_v(Q[k]) - _v(K)).Multiplied(limit / span))
        got = side.foot(q)
        Q[k] = got[0] if got else q
        moved = True
    return moved


def _conic(Q0, K, Q1, weight):
    poles = TColgp_Array1OfPnt(1, 3)
    poles.SetValue(1, Q0)
    poles.SetValue(2, K)
    poles.SetValue(3, Q1)
    weights = TColStd_Array1OfReal(1, 3)
    weights.SetValue(1, 1.0)
    weights.SetValue(2, weight)
    weights.SetValue(3, 1.0)
    return Geom_BezierCurve(poles, weights)


def _section(P, T, sides, s, kind, size, size2, continuity, profile=0.0, axis=None, margin=1.0):
    n1 = sides[0].normal_on_edge_cached
    n2 = sides[1].normal_on_edge_cached
    c = max(-1.0, min(1.0, n1.Dot(n2)))
    if 1 + c < 1e-3:
        raise SectionBlendError("the faces fold back on each other here")
    m = (n1 + n2).Multiplied(1.0 / (1 + c))
    Q, K, C, normals = _contacts(P, T, sides, s, kind, size, size2, continuity)
    if kind == "chamfer":
        if axis is not None:
            _clamp_to_axis(Q, P, P, axis)
        _clamp_to_limits(Q, P, sides)
        curve = GC_MakeSegment(Q[1], Q[0]).Value()
    else:
        clamped = axis is not None and _clamp_to_axis(Q, K, P, axis)
        clamped = _clamp_to_limits(Q, K, sides) or clamped
        k = weight_scale(profile)
        if continuity == "G2":
            poles = TColgp_Array1OfPnt(1, 5)
            poles.SetValue(1, Q[1])
            poles.SetValue(2, _p(_v(Q[1]) + (_v(K) - _v(Q[1])).Multiplied(1 - G2_TENSION)))
            poles.SetValue(3, K)
            poles.SetValue(4, _p(_v(Q[0]) + (_v(K) - _v(Q[0])).Multiplied(1 - G2_TENSION)))
            poles.SetValue(5, Q[0])
            if abs(k - 1.0) < 1e-9:
                curve = Geom_BezierCurve(poles)
            else:
                # Poles 1-3 and 3-5 stay collinear, so the ends keep zero
                # curvature whatever the middle weight.
                weights = TColStd_Array1OfReal(1, 5)
                for j, w in enumerate((1.0, 1.0, k, 1.0, 1.0), start=1):
                    weights.SetValue(j, w)
                curve = Geom_BezierCurve(poles, weights)
        elif clamped or abs(k - 1.0) > 1e-9:
            # The circle is the conic with middle weight sin(corner / 2); the
            # profile scales that weight exactly as conic_blend does OCCT's.
            a, b = _v(Q[0]) - _v(K), _v(Q[1]) - _v(K)
            if a.Magnitude() < 1e-9 or b.Magnitude() < 1e-9:
                raise SectionBlendError("the blend centre sits on the edge")
            curve = _conic(Q[1], K, Q[0], math.sin(a.Angle(b) / 2) * k)
        else:
            toward = _v(P) - C
            if toward.Magnitude() < 1e-12:
                raise SectionBlendError("the blend centre sits on the edge")
            mid = _p(C + toward.Normalized().Multiplied(size))
            curve = GC_MakeArcOfCircle(Q[1], mid, Q[0]).Value()
    # The section closes a hair beyond the faces, following each face's own
    # surface from its contact back to the edge. A fixed straight run used to
    # need a generous margin to stay clear of a curved face, and that margin
    # poked through thin walls and showed on their far side.
    reach = max(Q[0].Distance(P), Q[1].Distance(P), size)
    e = max(0.02 * size, 0.01) * margin
    K = _p(_v(P) + m.Multiplied(s * e))
    run = [Q[0]]
    run += _skin(sides[0], normals[0], Q[0], P, s * e, reach)[:-1]
    run.append(K)
    run += _skin(sides[1], normals[1], P, Q[1], s * e, reach)[1:]
    run.append(Q[1])
    inner = (_v(Q[0]) + _v(Q[1])).Multiplied(0.5) if kind == "chamfer" else C
    return _wire(run, curve), inner


def _convexity(P, T, sides, n1, n2, tol):
    """+1 where the body is inside the corner (a fillet removes material), -1
    where it is outside (a fillet adds it). Also leaves each side's direction
    INTO its face, which a chamfer measures its distances along."""
    step = max(tol * 20, 1e-4)
    for side, n in zip(sides, (n1, n2)):
        d = n.Crossed(T)
        if d.Magnitude() < 1e-12:
            raise SectionBlendError("the edge runs along a face normal")
        d.Normalize()
        side.inward_sign = 1
        if not side.contains(_p(_v(P) + d.Multiplied(step)), tol):
            d.Reverse()
            side.inward_sign = -1
        side.inward_cached = d
    return 1 if sides[0].inward_cached.Dot(n2) < 0 else -1


def _edge_tool(shape, edge, kind, size, size2, continuity, tol, draft=False, profile=0.0, margin=1.0):
    faces = _faces_of(shape, edge)
    sides = [_Side(f, edge) for f in faces]
    crv = BRepAdaptor_Curve(edge)
    t0, t1 = crv.FirstParameter(), crv.LastParameter()
    straight = crv.GetType() == GeomAbs_Line and all(sd.planar for sd in sides)
    closed = crv.Value(t0).Distance(crv.Value(t1)) < tol * 10

    def frame(t):
        P, V = gp_Pnt(), gp_Vec()
        crv.D1(t, P, V)
        if V.Magnitude() < 1e-12:
            raise SectionBlendError("the edge has a cusp")
        T = V.Normalized()
        n1, n2 = sides[0].normal_on_edge(t), sides[1].normal_on_edge(t)
        return P, T, n1, n2

    Pm, Tm, n1m, n2m = frame(0.5 * (t0 + t1))
    s = _convexity(Pm, Tm, sides, n1m, n2m, tol)
    if s > 0:
        margin = 1.0  # a cut's closing run lies outside the body, where tools meeting is harmless
    sides[0].normal_on_edge_cached = n1m
    sides[1].normal_on_edge_cached = n2m
    _face_limits(Pm, Tm, sides, s, kind, size, size2, continuity)

    axis = _common_axis(crv, faces) if closed else None
    if axis is not None:
        # A rim is its section swept round, and revolving it stays exact up to a
        # radius that reaches the axis, where a loft's sections all collapse
        # onto one point: a cylinder rounded by its own radius is a dome. Past
        # that the contacts stop on the axis and the dome keeps growing.
        P, T, n1, n2 = frame(t0)
        # In the meridian plane a coaxial cone or cylinder is a straight line, so
        # the section is exact without projecting onto the surface, which past
        # the axis lands on the surface's far side.
        for sd in sides:
            sd.planar = True
        sides[0].normal_on_edge_cached = n1
        sides[1].normal_on_edge_cached = n2
        wire, _inner = _section(P, T, sides, s, kind, size, size2, continuity, profile, axis, margin)
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
        from OCP.BRepPrimAPI import BRepPrimAPI_MakeRevol

        face = BRepBuilderAPI_MakeFace(wire, True)
        if face.IsDone():
            rev = BRepPrimAPI_MakeRevol(face.Face(), axis)
            rev.Build()
            if rev.IsDone():
                tools = [rev.Shape()]
                reach = size * (G2_SETBACK if continuity == "G2" else 1.0) + (size2 or 0.0)
                fuzz = max(tol * 10, 1e-5)
                return s, _apply_trims(tools, _trims(shape, edge, faces, s, 50 * reach + 10), fuzz)

    if straight:
        ts = [t0, t1]
    else:
        n = 48 if closed else 24
        ts = [t0 + (t1 - t0) * k / n for k in range(n + 1)]

    wires = []
    prev = None
    for t in ts:
        P, T, n1, n2 = frame(t)
        sides[0].normal_on_edge_cached = n1
        sides[1].normal_on_edge_cached = n2
        if kind == "chamfer":
            # Carried from the middle rather than probed here: at an end the
            # edge meets another boundary and neither direction lies on the face.
            for side, n in zip(sides, (n1, n2)):
                d = n.Crossed(T)
                if d.Magnitude() < 1e-12:
                    raise SectionBlendError("the edge runs along a face normal")
                side.inward_cached = d.Normalized().Multiplied(side.inward_sign)
        wire, inner = _section(P, T, sides, s, kind, size, size2, continuity, profile, margin=margin)
        # Past the edge's own curvature on the inside of a bend, the blend's
        # centre line stops and runs backwards; the loft would cross itself and
        # the boolean can grind for a minute before failing.
        if prev is not None and (inner - prev[0]).Dot(prev[1]) <= 1e-3 * P.Distance(prev[2]):
            raise SectionBlendError("at this size the blend is tighter than the edge's own curve")
        prev = (inner, T, P)
        wires.append(wire)

    def loft(ws):
        mk = BRepOffsetAPI_ThruSections(True, len(ws) == 2, 1e-6)
        mk.CheckCompatibility(False)
        for w in ws:
            mk.AddWire(w)
        mk.Build()
        if not mk.IsDone():
            raise SectionBlendError("the blend sections would not loft")
        return mk.Shape()

    if draft and len(wires) > 4:
        # A live drag: every section still went through the fold check above,
        # a third of them are enough to show the shape.
        keep = list(range(0, len(wires), 3))
        if keep[-1] != len(wires) - 1:
            keep.append(len(wires) - 1)
        if closed and len(wires) // 2 not in keep:
            keep = sorted(set(keep) | {len(wires) // 2})
        mid = keep.index(len(wires) // 2) if closed else 0
        wires = [wires[k] for k in keep]
        tools = [loft(wires[: mid + 1]), loft(wires[mid:])] if closed else [loft(wires)]
    else:
        tools = [loft(wires[: len(wires) // 2 + 1]), loft(wires[len(wires) // 2:])] if closed else [loft(wires)]
    reach = size * (G2_SETBACK if continuity == "G2" else 1.0) + (size2 or 0.0)
    trims = _trims(shape, edge, faces, s, 50 * reach + 10)
    fuzz = max(tol * 10, 1e-5)
    return s, _apply_trims(tools, trims, fuzz)


def _apply_trims(tools, trims, fuzz):
    for keep_inside, trim in trims:
        out = []
        for t in tools:
            if _trim_misses(t, keep_inside, trim):
                out.append(t)
                continue
            if not keep_inside:
                cut = _boolean(BRepAlgoAPI_Cut(), t, [trim], fuzz)
                if _volume(cut) > 1e-9:
                    out.append(cut)
                continue
            # Common can give nothing for a tool whose end lies exactly on the
            # trim's surface (a leg's blend against the round wall it is set
            # into), and keeping the tool whole leaves a flap past the wall. The
            # same trim grown by a micron cuts it cleanly.
            kept = None
            attempts = [(t, trim, fuzz), (t, trim, 0.0), (trim, t, fuzz), (t, _grown(trim, 1e-5), fuzz),
                        (t, _grown(trim, 1e-4), fuzz)]
            for a, b, fz in attempts:
                try:
                    got = _boolean(BRepAlgoAPI_Common(), a, [b], fz)
                except SectionBlendError:
                    continue
                if _volume(got) > 1e-9 and _within(got, trim):
                    kept = got
                    break
            if kept is None and _inside_point(t, trim):
                kept = _outside_removed(t, trim, fuzz)
            if kept is not None:
                out.append(kept)
        tools = out
    return tools


def _outside_removed(tool, trim, fuzz):
    """The tool less everything around it that is not `trim`: the same solid as
    Common, reached through two cuts when Common itself comes back empty."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

    box = Bnd_Box()
    BRepBndLib.Add_s(tool, box)
    box.Enlarge(1.0 + 0.1 * math.sqrt(box.SquareExtent()))
    x0, y0, z0, x1, y1, z1 = box.Get()
    around = BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Shape()
    for fz in (fuzz, 0.0):
        try:
            outside = _boolean(BRepAlgoAPI_Cut(), around, [trim], fz)
            got = _boolean(BRepAlgoAPI_Cut(), tool, [outside], fz)
        except SectionBlendError:
            continue
        if _volume(got) > 1e-9 and BRepCheck_Analyzer(got).IsValid() and _within(got, trim):
            return got
    raise SectionBlendError("the blend could not be trimmed where its face ends")


def _grown(solid, factor):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.gp import gp_Trsf

    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, g)
    tr = gp_Trsf()
    tr.SetScale(g.CentreOfMass(), 1.0 + factor)
    return BRepBuilderAPI_Transform(solid, tr, True).Shape()


def _shrunk(solid, by):
    """`solid` scaled about its centre so its far side moves about `by` mm."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    BRepBndLib.Add_s(solid, box)
    if box.IsVoid():
        return solid
    return _grown(solid, -min(1e-3, by / max(math.sqrt(box.SquareExtent()), 1e-9)))


def _within(shape, trim):
    return _within_by(shape, trim, False) or _within_by(shape, trim, True)


def _within_by(shape, trim, verify):
    """No point of `shape` outside `trim`: a Common can come back holding part of
    the tool it should have cut away, a flap past the wall."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    cls = BRepClass3d_SolidClassifier(trim)
    for p in _points_inside(shape, verify):
        cls.Perform(p, 1e-6)
        if cls.State() == TopAbs_OUT:
            return False
    return True


def _volume(shape):
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, g)
    return g.Mass()


def _inside_point(tool, trim):
    """True when a point inside `tool` is also inside `trim`."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    trim_cls = BRepClass3d_SolidClassifier(trim)
    for p in _points_inside(tool):
        trim_cls.Perform(p, 1e-9)
        return trim_cls.State() == TopAbs_IN
    return False


def _points_inside(tool, verify=True):
    """Points just inside `tool`, under a few spots of each of its faces. A thin
    curved blend has room for almost none of a grid over its box.

    Unverified, a point under a tightly curved face can land outside; the
    checks below use them first because that can only make a check fail, and
    classifying every point against a lofted blend was most of a build."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepTools import BRepTools

    box = Bnd_Box()
    BRepBndLib.Add_s(tool, box)
    if box.IsVoid():
        return
    depth = 1e-3 * math.sqrt(box.SquareExtent())
    cls = BRepClass3d_SolidClassifier(tool) if verify else None
    ex = TopExp_Explorer(tool, TopAbs_FACE)
    while ex.More():
        f = TopoDS.Face_s(ex.Current())
        ex.Next()
        u0, u1, v0, v1 = BRepTools.UVBounds_s(f)
        props = BRepGProp_Face(f)
        for a, b in ((0.5, 0.5), (0.3, 0.7), (0.7, 0.3)):
            pt, n = gp_Pnt(), gp_Vec()
            props.Normal(u0 + (u1 - u0) * a, v0 + (v1 - v0) * b, pt, n)
            if n.Magnitude() < 1e-12:
                continue
            p = _p(_v(pt) - n.Normalized().Multiplied(depth))
            if not verify:
                yield p
                continue
            cls.Perform(p, 1e-9)
            if cls.State() == TopAbs_IN:
                yield p


def _common_axis(crv, faces):
    """The circle's axis when both faces are turned about it (a plane square to
    it, a coaxial cylinder or cone), else None."""
    from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cone, GeomAbs_Cylinder

    if crv.GetType() != GeomAbs_Circle:
        return None
    ax = crv.Circle().Axis()
    for f in faces:
        ad = BRepAdaptor_Surface(f)
        kind = ad.GetType()
        if kind == GeomAbs_Plane:
            if not ad.Plane().Axis().IsParallel(ax, 1e-6):
                return None
        elif kind in (GeomAbs_Cylinder, GeomAbs_Cone):
            other = ad.Cylinder().Axis() if kind == GeomAbs_Cylinder else ad.Cone().Axis()
            # Either direction: an extruded circle's cylinder often points down.
            if not (other.IsParallel(ax, 1e-6) and gp_Lin(ax).Distance(other.Location()) < 1e-6):
                return None
        else:
            return None
    return ax


def _trims(shape, edge, faces, s, size):
    """Solids that cut a blend off where the faces it sits on stop.

    The lofted blend ends square to the edge and runs as far across each face as
    its size says, so it hangs out wherever the geometry stops sooner: past a
    wall the edge ends against, or below the bottom of a leg shorter than the
    blend is wide. Where one of the blend's faces meets another face at a CONVEX
    corner the body ends there, so that face's surface is made into a solid
    (half-space box, cylinder, sphere) and the blend is kept on the body's side
    of it. At a concave corner the body carries on, and nothing is trimmed.

    A blend that adds material is trimmed at every such boundary. One that
    removes material only at the boundaries through the edge's own ends, so a
    large round still carves on past its faces' far edges."""
    ends = []
    ex = TopExp_Explorer(edge, TopAbs_VERTEX)
    while ex.More():
        ends.append(TopoDS.Vertex_s(ex.Current()))
        ex.Next()
    emap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, emap)
    out = []
    keys = []
    seen = list(faces)
    for own in faces:
        ee = TopExp_Explorer(own, TopAbs_EDGE)
        while ee.More():
            bound = TopoDS.Edge_s(ee.Current())
            ee.Next()
            if bound.IsSame(edge) or BRep_Tool.Degenerated_s(bound):
                continue
            if s > 0 and not _touches(bound, ends):
                continue
            idx = emap.FindIndex(bound)
            if not idx:
                continue
            for f in emap.FindFromIndex(idx):
                g = TopoDS.Face_s(f)
                if any(g.IsSame(x) for x in seen):
                    continue
                try:
                    convex, at = _convex_between(own, g, bound)
                except SectionBlendError:
                    continue
                if not convex:
                    continue
                trim = _trim_solid(g, at, size)
                if trim is None:
                    continue
                seen.append(g)
                key = _surface_key(g, trim[0])
                if key is not None and key in keys:
                    continue
                keys.append(key)
                out.append(trim)
    return out


def _surface_key(face, keep_inside):
    """What makes two trims the same cut: a wall split into several faces by
    what joins it gives one trim per face, all on one surface."""
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Sphere

    def r6(*xs):
        return tuple(round(x, 6) + 0.0 for x in xs)

    def canonical(d):
        return d.Reversed() if (d.Z(), d.Y(), d.X()) < (0, 0, 0) else d

    ad = BRepAdaptor_Surface(face)
    kind = ad.GetType()
    if kind == GeomAbs_Plane:
        pl = ad.Plane()
        n = canonical(pl.Axis().Direction())
        return ("plane", r6(*n.Coord()), r6(gp_Vec(n).Dot(gp_Vec(pl.Location().XYZ()))), keep_inside)
    if kind == GeomAbs_Cylinder:
        c = ad.Cylinder()
        ax = c.Axis()
        d = canonical(ax.Direction())
        loc = gp_Vec(ax.Location().XYZ())
        foot = loc - gp_Vec(d).Multiplied(loc.Dot(gp_Vec(d)))
        return ("cyl", r6(*d.Coord()), r6(foot.X(), foot.Y(), foot.Z()), r6(c.Radius()), keep_inside)
    if kind == GeomAbs_Sphere:
        sp = ad.Sphere()
        return ("sph", r6(*sp.Location().Coord()), r6(sp.Radius()), keep_inside)
    return None


def _trim_misses(tool, keep_inside, trim):
    """True when the trim cannot change the tool: kept inside a solid that
    holds the tool's whole box, or cut by one whose box the tool's misses."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    tb, trim_box = Bnd_Box(), Bnd_Box()
    BRepBndLib.Add_s(tool, tb)
    BRepBndLib.Add_s(trim, trim_box)
    if tb.IsVoid():
        return True
    if not keep_inside:
        return tb.IsOut(trim_box)
    x0, y0, z0, x1, y1, z1 = tb.Get()
    for x in (x0, x1):
        for y in (y0, y1):
            for z in (z0, z1):
                if BRepClass3d_SolidClassifier(trim, gp_Pnt(x, y, z), 1e-7).State() != TopAbs_IN:
                    return False
    # Every corner inside a convex solid (box, cylinder, sphere) is the whole box.
    return True


def _touches(edge, vertices):
    ex = TopExp_Explorer(edge, TopAbs_VERTEX)
    while ex.More():
        if any(ex.Current().IsSame(v) for v in vertices):
            return True
        ex.Next()
    return False


def _convex_between(own, g, bound):
    """Whether `own` and `g` meet at a convex corner along `bound`, measured at
    its middle, and that point. Tangent faces count as not convex."""
    tol = max(BRep_Tool.Tolerance_s(bound), 1e-6)
    a, b = _Side(own, bound), _Side(g, bound)
    crv = BRepAdaptor_Curve(bound)
    t = 0.5 * (crv.FirstParameter() + crv.LastParameter())
    P, V = gp_Pnt(), gp_Vec()
    crv.D1(t, P, V)
    if V.Magnitude() < 1e-12:
        raise SectionBlendError("the boundary has a cusp")
    T = V.Normalized()
    na, nb = a.normal_on_edge(t), b.normal_on_edge(t)
    if abs(na.Dot(nb)) > 0.9998:
        return False, P
    return _convexity(P, T, [a, b], na, nb, tol) > 0, P


def _trim_solid(g, at, size):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere
    from OCP.gp import gp_Ax2, gp_Dir, gp_Lin
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Sphere

    proj = GeomAPI_ProjectPointOnSurf(at, BRep_Tool.Surface_s(g))
    if proj.NbPoints() == 0:
        return None
    u, v = proj.LowerDistanceParameters()
    p, n = gp_Pnt(), gp_Vec()
    BRepGProp_Face(g).Normal(u, v, p, n)
    if n.Magnitude() < 1e-12:
        return None
    n.Normalize()
    body_side = _p(_v(at) - n.Multiplied(1e-3 * size))
    ad = BRepAdaptor_Surface(g)
    kind = ad.GetType()
    # Every solid is centred on `at`, not on the surface's own origin, which can
    # sit further along a plane or an axis than the solid reaches.
    if kind == GeomAbs_Plane:
        z = gp_Dir(-n.X(), -n.Y(), -n.Z())
        ax = gp_Ax2(p, z)
        origin = ax.Location().Translated(
            gp_Vec(ax.XDirection()).Multiplied(-size) + gp_Vec(ax.YDirection()).Multiplied(-size))
        return True, BRepPrimAPI_MakeBox(gp_Ax2(origin, z, ax.XDirection()), 2 * size, 2 * size, size).Shape()
    if kind == GeomAbs_Cylinder:
        cyl = ad.Cylinder()
        axis = cyl.Axis()
        along = gp_Vec(axis.Location(), at).Dot(gp_Vec(axis.Direction()))
        base = axis.Location().Translated(gp_Vec(axis.Direction()).Multiplied(along - size))
        solid = BRepPrimAPI_MakeCylinder(gp_Ax2(base, axis.Direction()), cyl.Radius(), 2 * size).Shape()
        return gp_Lin(axis).Distance(body_side) < cyl.Radius(), solid
    if kind == GeomAbs_Sphere:
        sph = ad.Sphere()
        solid = BRepPrimAPI_MakeSphere(sph.Location(), sph.Radius()).Shape()
        return sph.Location().Distance(body_side) < sph.Radius(), solid
    return None


def _ball_corners(shape, blended, continuity="G1", profile=0.0):
    """Where every edge into a corner of three faces is being rounded convex at
    one radius, the corner is the ball rolling into it.

    Each edge's loft ends square at the corner, so on their own the three meet
    in the sharp intersection of their cylinders, and at a radius of half a cube
    that is a tricylinder instead of a sphere. The corner's cell is the
    parallelepiped between the ball centre and the planes touching the faces
    where the ball does; removing the part of it outside the ball is exactly
    the difference, since every point of the ball is within the radius of each
    edge's axis.

    A profiled or G2 blend has no ball. Where the three faces are planes square
    to each other its corner is `_patch_solid` instead, and elsewhere the edges
    still meet as they are."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeSphere
    from OCP.gp import gp_GTrsf, gp_Mat, gp_XYZ

    if len(blended) < 3:
        return []
    weight = weight_scale(profile)
    ball = continuity == "G1" and abs(weight - 1.0) < 1e-9
    vmap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_VERTEX, TopAbs_EDGE, vmap)
    fmap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_VERTEX, TopAbs_FACE, fmap)
    out, done = [], []
    for e, r in blended:
        ex = TopExp_Explorer(e, TopAbs_VERTEX)
        while ex.More():
            v = TopoDS.Vertex_s(ex.Current())
            ex.Next()
            if any(v.IsSame(d) for d in done):
                continue
            done.append(v)
            around = _unique(vmap.FindFromIndex(vmap.FindIndex(v)), degenerate_ok=False)
            radii = []
            for a in around:
                hit = [sz for b, sz in blended if b.IsSame(a)]
                if not hit:
                    break
                radii.append(hit[0])
            if len(around) != 3 or len(radii) != 3 or max(radii) - min(radii) > 1e-9:
                continue
            faces = [TopoDS.Face_s(f) for f in _unique(fmap.FindFromIndex(fmap.FindIndex(v)))]
            if len(faces) != 3:
                continue
            setback = r * G2_SETBACK if continuity == "G2" else r
            # A ball on a curved face overcut a D shape's corner by 10mm3 where
            # the square ends were within 1.2 of the kernel.
            if not all(BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane for f in faces):
                continue
            got = _corner_ball(faces, BRep_Tool.Pnt_s(v), setback)
            if got is None:
                continue
            C, ns = got
            if not ball and any(abs(ns[i].Dot(ns[j])) > 1e-6 for i, j in ((0, 1), (1, 2), (0, 2))):
                continue
            cols = []
            for k in range(3):
                d = ns[(k + 1) % 3].Crossed(ns[(k + 2) % 3])
                along = d.Dot(ns[k])
                if abs(along) < 1e-9:
                    break
                cols.append(d.Multiplied((setback * 1.02 + 1e-3) / along))
            if len(cols) != 3:
                continue
            m = gp_Mat(cols[0].XYZ(), cols[1].XYZ(), cols[2].XYZ())
            g = gp_GTrsf(m, gp_XYZ(C.X(), C.Y(), C.Z()))
            cell = BRepBuilderAPI_GTransform(BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape(), g, True).Shape()
            try:
                kept = BRepPrimAPI_MakeSphere(_p(C), r).Shape() if ball else _patch_solid(C, ns, setback, continuity, weight)
                corner = _boolean(BRepAlgoAPI_Cut(), cell, [kept], 1e-6)
            except SectionBlendError:
                continue
            if BRepCheck_Analyzer(corner).IsValid() and _sane_volume(corner):
                out.append(corner)
    return out


def _section_poles(Qa, K, Qb, continuity, k):
    """Poles and weights of the section `_section` builds between contacts Qa
    and Qb on faces square to each other, whose control corner is K."""
    if continuity == "G2":
        t = 1 - G2_TENSION
        return ([Qa, Qa + (K - Qa).Multiplied(t), K, Qb + (K - Qb).Multiplied(t), Qb],
                [1.0, 1.0, k, 1.0, 1.0])
    return [Qa, K, Qb], [1.0, math.sin(math.pi / 4) * k, 1.0]


def _patch_solid(A, ns, d, continuity, k):
    """What a profiled or G2 blend keeps of a corner where three planes meet
    square: the cell between A, the point `d` in from all three faces, and
    the surface over it.

    Every vertical slice through A's axis along ns[2] is the edges' own
    section, from the pole on the third face down to the section of the edge
    along ns[2]. A section's poles are affine in its contacts and corner, so
    the whole surface is one rational Bezier patch whose rows are that edge's
    section, and it meets all three edge blends exactly. At profile 0 in G1
    it is the ball."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_Sewing
    from OCP.Geom import Geom_BezierSurface
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.TColgp import TColgp_Array2OfPnt
    from OCP.TColStd import TColStd_Array2OfReal

    a, n1, n2, n3 = _v(A), ns[0], ns[1], ns[2]
    up = n3.Multiplied(d)
    pole = a + up
    ring, ws = _section_poles(a + n1.Multiplied(d), a + n1.Multiplied(d) + n2.Multiplied(d), a + n2.Multiplied(d),
                              continuity, k)
    rows = [_section_poles(pole, e + up, e, continuity, k) for e in ring]
    nu, nv = len(ring), len(rows[0][0])
    poles = TColgp_Array2OfPnt(1, nu, 1, nv)
    weights = TColStd_Array2OfReal(1, nu, 1, nv)
    for i, (pts, wv) in enumerate(rows):
        for j in range(nv):
            poles.SetValue(i + 1, j + 1, _p(pts[j]))
            weights.SetValue(i + 1, j + 1, ws[i] * wv[j])
    surf = Geom_BezierSurface(poles, weights)
    faces = [BRepBuilderAPI_MakeFace(surf, 0.0, 1.0, 0.0, 1.0, 1e-7).Face()]
    for crv, ends in ((surf.UIso(0.0), (a + n1.Multiplied(d), pole)),
                      (surf.UIso(1.0), (a + n2.Multiplied(d), pole)),
                      (surf.VIso(1.0), (a + n1.Multiplied(d), a + n2.Multiplied(d)))):
        wire = BRepBuilderAPI_MakeWire()
        wire.Add(BRepBuilderAPI_MakeEdge(crv).Edge())
        corner = BRepBuilderAPI_MakePolygon(_p(ends[1]), _p(a), _p(ends[0]))
        wire.Add(corner.Wire())
        if not wire.IsDone():
            raise SectionBlendError("the corner patch did not close")
        face = BRepBuilderAPI_MakeFace(wire.Wire(), True)
        if not face.IsDone():
            raise SectionBlendError("the corner patch did not close")
        faces.append(face.Face())
    sew = BRepBuilderAPI_Sewing(1e-6)
    for f in faces:
        sew.Add(f)
    sew.Perform()
    shell = TopExp_Explorer(sew.SewedShape(), TopAbs_SHELL)
    if not shell.More():
        raise SectionBlendError("the corner patch did not close")
    fix = ShapeFix_Solid()
    solid = fix.SolidFromShell(TopoDS.Shell_s(shell.Current()))
    if not BRepCheck_Analyzer(solid).IsValid() or not _sane_volume(solid):
        raise SectionBlendError("the corner patch did not close")
    return solid


def _corner_ball(faces, V, r):
    """Centre of the ball of radius r touching all three faces near V, and each
    face's outward normal where it touches, or None where there is none. The
    faces are planes."""
    feet, ns, surfs = [], [], []
    for f in faces:
        surf = BRep_Tool.Surface_s(f)
        got = _surface_normal(f, surf, V)
        if got is None:
            return None
        feet.append(V)
        ns.append(got[1])
        surfs.append(surf)
    C = None
    for _ in range(8):
        C = _solve3([(n.X(), n.Y(), n.Z()) for n in ns], [n.Dot(_v(q)) - r for n, q in zip(ns, feet)])
        if C is None:
            return None
        moved = 0.0
        for k, f in enumerate(faces):
            got = _surface_normal(f, surfs[k], _p(C))
            if got is None:
                return None
            q, n = got
            if n.Dot(ns[k]) < 0:
                n.Reverse()
            moved = max(moved, q.Distance(feet[k]))
            feet[k], ns[k] = q, n
        if moved < 1e-9:
            break
    return C, ns


def _surface_normal(face, surf, pnt):
    proj = GeomAPI_ProjectPointOnSurf(pnt, surf)
    if proj.NbPoints() == 0:
        return None
    u, v = proj.LowerDistanceParameters()
    p, n = gp_Pnt(), gp_Vec()
    BRepGProp_Face(face).Normal(u, v, p, n)
    if n.Magnitude() < 1e-12:
        return None
    return proj.NearestPoint(), n.Normalized()


def _unique(shapes, degenerate_ok=True):
    out = []
    for s in shapes:
        if not degenerate_ok and s.ShapeType() == TopAbs_EDGE and BRep_Tool.Degenerated_s(TopoDS.Edge_s(s)):
            continue
        if not any(s.IsSame(x) for x in out):
            out.append(s)
    return out


def _boolean(op, base, tools, fuzz):
    a = TopTools_ListOfShape()
    a.Append(base)
    b = TopTools_ListOfShape()
    for t in tools:
        b.Append(t)
    op.SetArguments(a)
    op.SetTools(b)
    op.SetFuzzyValue(fuzz)
    op.SetRunParallel(True)
    op.Build()
    if not op.IsDone():
        raise SectionBlendError("the blend would not combine with the body")
    out = op.Shape()
    if isinstance(op, BRepAlgoAPI_Cut) and _solid_count(out) > _solid_count(base):
        # The cut itself was right and left the removed material behind as loose
        # pieces: a D shape's eight 2mm edges came back with 77mm3 of them, and
        # redoing the cut one tool at a time took 24s to get the same body.
        loose = _loose_pieces(out, base, tools)
        if loose:
            from OCP.BRep import BRep_Builder
            from OCP.TopoDS import TopoDS_Compound

            kept = TopoDS_Compound()
            builder = BRep_Builder()
            builder.MakeCompound(kept)
            ex = TopExp_Explorer(out, TopAbs_SOLID)
            while ex.More():
                if not any(ex.Current().IsSame(piece) for piece in loose):
                    builder.Add(kept, ex.Current())
                ex.Next()
            out = kept
    return out


def _boolean_all(op, base, tools, fuzz, one_shot=False):
    """All tools in one boolean, and when the kernel gives up or quietly leaves
    some out: the tools merged into one first, then one at a time with any that
    fail retried after the rest. Large overlapping tools (six legs' blends at
    77mm) fused one at a time fail on one leg in every order the kernel tries,
    and go in as a single merged solid."""
    import time

    started = time.monotonic()
    try:
        out = _boolean(op(), base, tools, fuzz)
        if _sound(out, base) and _applied(op, base, out, tools):
            return out
    except SectionBlendError:
        if len(tools) == 1 and not one_shot:
            raise
    if one_shot:
        raise _DraftGaveUp("the blend would not combine with the body")
    if len(tools) == 1:
        return _boolean_one(op, base, tools[0], fuzz)
    # The retries below can grind for over a minute on a size the kernel will
    # not settle; past this a refusal is the better answer for a live drag.
    budget = max(20.0, 4 * (time.monotonic() - started))

    def out_of_time():
        return time.monotonic() - started > budget

    try:
        merged = tools[0]
        for t in tools[1:]:
            if out_of_time():
                raise SectionBlendError("the blend would not combine with the body")
            merged = _boolean_one(BRepAlgoAPI_Fuse, merged, t, fuzz)
        out = _boolean_one(op, base, merged, fuzz)
        if _applied(op, base, out, tools):
            return out
    except SectionBlendError:
        pass
    # One at a time, in a few orders: which tool the kernel chokes on depends on
    # what is already fused, and at 77mm G2 the forward order failed on the
    # last leg where the reverse built all six.
    n = len(tools)
    orders = [list(range(n)), list(reversed(range(n))), list(range(0, n, 2)) + list(range(1, n, 2))]
    for order in orders:
        cur, pending = base, [tools[i] for i in order]
        while pending:
            failed = []
            for t in pending:
                if out_of_time():
                    raise SectionBlendError("the blend would not combine with the body")
                try:
                    cur = _boolean_one(op, cur, t, fuzz)
                except SectionBlendError:
                    failed.append(t)
            if len(failed) == len(pending):
                break
            pending = failed
        if not pending:
            return cur
    raise SectionBlendError("the blend would not combine with the body")


def _boolean_one(op, base, tool, fuzz):
    """One tool, retried when the kernel returns a valid solid that simply
    leaves the tool out: a leg's blend fused onto a body that already had its
    neighbour's added 7mm3 of its 1258, and came out whole at fuzz 0 or with
    the arguments swapped."""
    attempts = [(base, tool, fuzz), (base, tool, 0.0), (base, tool, max(fuzz * 1000, 1e-2))]
    if op is BRepAlgoAPI_Fuse:
        attempts.insert(2, (tool, base, fuzz))
    # A tool overlaps the body by its closing margin, so a tool a hair smaller
    # still reaches it; one leg's valid blend fused onto a valid body came back
    # empty at every fuzz and whole at 1e-4 smaller.
    attempts += [(base, _shrunk(tool, 2e-3), fuzz), (base, _shrunk(tool, 2e-2), fuzz)]
    for a, b, fz in attempts:
        # On copies: a failed attempt can raise the tolerances of its arguments
        # in place, and every retry after it inherits that.
        try:
            out = _boolean(op(), _copy(a), [_copy(b)], fz)
        except SectionBlendError:
            continue
        if _sound(out, base) and _applied(op, base, out, [tool]):
            return out
    raise SectionBlendError("the blend would not combine with the body")


def _sound(shape, base=None):
    """Valid and holding a solid: a fuse can come back as a valid compound with
    none in it."""
    return (_solid_count(shape) > 0 and BRepCheck_Analyzer(shape).IsValid() and _bounded(shape)
            and _sane_volume(shape) and (base is None or not _has_strip(shape, base)))


def _has_strip(shape, base):
    """A face the boolean made on a blend's loft that has no area but long
    edges: two copies of one curve folded into a strip with solid on both
    sides. Three G2 edges into a box corner at 26.3mm cut to two of them
    running 40mm through the body, valid to BRepCheck and drawn as stray
    triangles. Slivers left of a body's own cylinder are not strips: six 77mm
    leg fills leave five along the wall and draw fine. Faces the body already
    had are not measured, an imported part has tens of thousands."""
    from OCP.GeomAbs import GeomAbs_BSplineSurface
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps
    from OCP.TopTools import TopTools_IndexedMapOfShape

    old = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(base, TopAbs_FACE, old)
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        f = ex.Current()
        ex.Next()
        if old.Contains(f) or BRepAdaptor_Surface(TopoDS.Face_s(f)).GetType() != GeomAbs_BSplineSurface:
            continue
        g = GProp_GProps()
        BRepGProp.SurfaceProperties_s(f, g)
        if abs(g.Mass()) > 1e-3:
            continue
        g = GProp_GProps()
        BRepGProp.LinearProperties_s(f, g)
        if g.Mass() > 1.0:
            return True
    return False


def _bounded(shape):
    """The point at infinity is outside it. A fuse has come back as a valid solid
    of 1e-9mm3 that classifies every point of the old body as inside."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    cls = BRepClass3d_SolidClassifier(shape)
    cls.PerformInfinitePoint(1e-7)
    return cls.State() == TopAbs_OUT


def _applied(op, base, out, tools):
    return _applied_by(op, base, out, tools, False) or _applied_by(op, base, out, tools, True)


def _applied_by(op, base, out, tools, verify):
    """Whether `out` took every tool: points inside a tool that `base` did not
    have are in a fuse's result, and points of it that `base` had are gone from
    a cut's. A dropped tool fails every one of them. Requiring a share of them
    to land refused ordinary 20mm fillets on sampling noise, so one is enough.
    A point landing where another tool also reaches says nothing about this one:
    two of six 77mm leg fills dropped from a drag's fuse, and their samples in
    the neighbours' overlap all landed."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    fuse = op is BRepAlgoAPI_Fuse
    if _solid_count(out) > _solid_count(base) and (fuse or _loose_pieces(out, base, tools)):
        return False
    changed = TopAbs_OUT if fuse else TopAbs_IN
    bc = BRepClass3d_SolidClassifier(base)
    oc = BRepClass3d_SolidClassifier(out)
    for t in tools:
        landed, missed = [], []
        for p in _points_inside(t, verify):
            bc.Perform(p, 1e-9)
            if bc.State() != changed:
                continue
            oc.Perform(p, 1e-9)
            (landed if oc.State() != changed else missed).append(p)
            if len(landed) + len(missed) >= 12:
                break
        if not missed:
            continue
        # Partial loss has only been seen in fuses; overlapping cut tools, a
        # corner cell among its edges' tools, sample too noisily for a share or
        # for telling apart which tool a point belongs to.
        if not fuse:
            if not landed:
                return False
            continue
        # Classifying against the other lofts is slow, so only a tool that
        # missed somewhere pays for it.
        others = _near_tools([u for u in tools if u is not t])

        def alone(p):
            return not others(p, lambda st: st == TopAbs_IN)

        if any(alone(p) for p in missed) and not any(alone(p) for p in landed):
            return False
    return _kept_base(base, out, tools, verify)


def _loose_pieces(out, base, tools):
    """The solids of a cut that its tools should have removed. A cut through a
    thin part can split it for real, but no piece of a cut can lie inside a
    tool: three edges into a box corner at 10mm G2 left 118mm3 of the corner
    loose, every sample of it inside the tools. A piece the unverified samples
    miss is sampled again verified, which only a split body pays for: on Linux
    a 180mm3 piece along a 16mm blend read as outside its loft unverified."""
    near = _near_tools(tools)
    loose = []
    solids = []
    ex = TopExp_Explorer(out, TopAbs_SOLID)
    while ex.More():
        solids.append(ex.Current())
        ex.Next()
    solids.sort(key=_volume, reverse=True)
    for piece in solids[_solid_count(base):]:
        for verify in (False, True):
            inside = checked = 0
            for p in _points_inside(piece, verify):
                inside += near(p, lambda st: st == TopAbs_IN)
                checked += 1
                if checked >= 12:
                    break
            if checked and inside * 2 > checked:
                loose.append(piece)
                break
    return loose


def _swallowed(base, tools):
    """Every point sampled inside `base`, under its faces and through its depth,
    is inside one of the tools. The faces alone are not enough: a 20mm cube
    rounded 12mm on every edge has tools over all of its skin and a core left."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    near = _near_tools(tools)

    def covered(p):
        return near(p, lambda st: st == TopAbs_IN)

    n = 0
    for p in _points_inside(base):
        if not covered(p):
            return False
        n += 1
        if n >= 24:
            break
    box = Bnd_Box()
    BRepBndLib.Add_s(base, box)
    if box.IsVoid():
        return n > 0
    x0, y0, z0, x1, y1, z1 = box.Get()
    bc = BRepClass3d_SolidClassifier(base)
    k = 6
    for i in range(1, k):
        for j in range(1, k):
            for m in range(1, k):
                p = gp_Pnt(x0 + (x1 - x0) * i / k, y0 + (y1 - y0) * j / k, z0 + (z1 - z0) * m / k)
                bc.Perform(p, 1e-9)
                if bc.State() != TopAbs_IN:
                    continue
                if not covered(p):
                    return False
                n += 1
    return n > 0


def _near_tools(tools):
    """`hit(p, test)`: whether a tool whose box holds `p` classifies it so that
    `test(state)`. Classifying against a lofted blend is slow, and most points
    lie outside most tools' boxes."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    boxes = []
    for t in tools:
        box = Bnd_Box()
        BRepBndLib.Add_s(t, box)
        if not box.IsVoid():
            box.Enlarge(1e-3)
            boxes.append((box, t, []))

    def hit(p, test):
        for box, t, cls in boxes:
            if box.IsOut(p):
                continue
            if not cls:
                cls.append(BRepClass3d_SolidClassifier(t))
            cls[0].Perform(p, 1e-9)
            if test(cls[0].State()):
                return True
        return False

    return hit


def _kept_base(base, out, tools, verify=True, most=24):
    """Whether `out` still holds the body the tools did not reach: a fuse has
    come back as a valid 128mm3 of a 135000mm3 body in five pieces."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier

    oc = BRepClass3d_SolidClassifier(out)
    near = _near_tools(tools)
    checked = lost = 0
    for p in _points_inside(base, verify):
        if near(p, lambda st: st != TopAbs_OUT):
            continue
        oc.Perform(p, 1e-9)
        checked += 1
        lost += oc.State() != TopAbs_IN
        if checked >= most:
            break
    # A destroyed body loses nearly every point; one near a curved tool's edge
    # can misclassify.
    return lost * 2 <= checked


def _solid_count(shape):
    n = 0
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        n += 1
        ex.Next()
    return n


def section_blend(shape, edges, kind, size, size2=None, continuity="G1", sizes=None, draft=False, profile=0.0):
    """Blend `edges` of the TopoDS solid `shape` by lofted sections, returning a
    new TopoDS shape. `sizes`, when given, is one size per edge in place of
    `size`, and `profile` is conic_blend's fillet profile. Raises SectionBlendError with a sentence when it cannot."""
    sizes = list(sizes) if sizes is not None else [size] * len(edges)
    if any(not (x > 0) for x in sizes) or (size2 is not None and not (size2 > 0)):
        raise SectionBlendError("the size must be greater than 0")
    if draft:
        # A drag's thinned lofts get one boolean. Two of six 77mm leg fills
        # dropped from theirs, and the retries on thinned lofts took longer
        # than building the full sections, which also match the commit.
        try:
            return _section_blend(shape, edges, kind, size2, continuity, sizes, True, profile)
        except _DraftGaveUp:
            pass
    return _section_blend(shape, edges, kind, size2, continuity, sizes, False, profile)


def _section_blend(shape, edges, kind, size2, continuity, sizes, draft, profile):
    tol = 1e-6
    for e in edges:
        tol = max(tol, BRep_Tool.Tolerance_s(e))
    cut, fuse = [], []
    convex = []
    # Each edge's section closes a slightly different depth inside the body:
    # six legs closing at one depth gave their tools coplanar overlapping faces,
    # and the fuse then refused or dropped a leg depending on thread timing.
    for k, (e, sz) in enumerate(zip(edges, sizes)):
        s, tools = _edge_tool(shape, e, kind, sz, size2, continuity, tol, draft, profile, 1.0 + 0.11 * k)
        (cut if s > 0 else fuse).extend(tools)
        if s > 0:
            convex.append((e, sz))
    corners = _ball_corners(shape, convex, continuity, profile) if kind == "fillet" else []
    if corners:
        # On copies: a boolean that fails can still raise the tolerances of its
        # arguments in place, and the retry without corners would inherit that.
        try:
            return _combine(_copy(shape), [_copy(t) for t in cut] + corners, [_copy(t) for t in fuse], tol, draft)
        except _DraftGaveUp:
            raise
        except SectionBlendError:
            pass  # past the size a ball fits the corner, the edges meet as they are
    return _combine(_copy(shape) if draft else shape, cut, fuse, tol, draft)


def _copy(shape):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy

    return BRepBuilderAPI_Copy(shape, False).Shape()


def _combine(shape, cut, fuse, tol, one_shot=False):
    fuzz = max(tol * 10, 1e-5)
    if cut and _swallowed(shape, cut):
        raise SectionBlendError("at this size the blend removes the whole body")
    out = shape
    if cut:
        out = _boolean_all(BRepAlgoAPI_Cut, out, cut, fuzz, one_shot)
    if fuse:
        out = _boolean_all(BRepAlgoAPI_Fuse, out, fuse, fuzz, one_shot)
    # Tidying only, on a copy: it edits its input's shared topology in place,
    # throws "Courbes non jointives" on some bodies, and merging the faces of a
    # leg's two seam halves turned a valid solid invalid.
    up = ShapeUpgrade_UnifySameDomain(_copy(out), True, True, False)
    try:
        up.Build()
        tidy = up.Shape()
        if _solid_count(tidy) == _solid_count(out) and (
                BRepCheck_Analyzer(tidy).IsValid() or not BRepCheck_Analyzer(out).IsValid()):
            out = tidy
    except Exception:  # noqa: BLE001
        pass
    if _solid_count(out) == 0:
        raise SectionBlendError("at this size the blend removes the whole body")
    if not _sound(out, shape) or not (_kept_base(shape, out, cut + fuse, False) or _kept_base(shape, out, cut + fuse)):
        raise SectionBlendError("at this size the blend makes a body that is not a valid solid")
    return out


def _sane_volume(shape):
    """An inside-out loft can fuse into a solid BRepCheck passes whose volume is
    1e101 and whose faces draw with their normals flipped."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, g)
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    if box.IsVoid():
        return False
    x0, y0, z0, x1, y1, z1 = box.Get()
    box = (x1 - x0) * (y1 - y0) * (z1 - z0)
    return math.isfinite(g.Mass()) and 1e-6 * box < g.Mass() <= 1.01 * box
