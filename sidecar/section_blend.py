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
from OCP.gp import gp_Pnt, gp_Pnt2d, gp_Vec
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TColgp import TColgp_Array1OfPnt
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_IN, TopAbs_ON, TopAbs_SOLID
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_ListOfShape


class SectionBlendError(ValueError):
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


def _section(P, T, sides, s, kind, size, size2, continuity):
    n1 = sides[0].normal_on_edge_cached
    n2 = sides[1].normal_on_edge_cached
    c = max(-1.0, min(1.0, n1.Dot(n2)))
    if 1 + c < 1e-3:
        raise SectionBlendError("the faces fold back on each other here")
    m = (n1 + n2).Multiplied(1.0 / (1 + c))
    if kind == "chamfer":
        u = [sides[0].inward_cached, sides[1].inward_cached]
        Q = []
        for k, d in enumerate((size, size2 if size2 else size)):
            q = _p(_v(P) + u[k].Multiplied(d))
            got = sides[k].foot(q)
            Q.append(got[0] if got else q)
        normals = [n1, n2]
        curve = GC_MakeSegment(Q[1], Q[0]).Value()
    else:
        r = size * G2_SETBACK if continuity == "G2" else size
        C, feet, normals = _ball(P, T, sides, (n1, n2), s, r)
        Q = [_p(feet[0]), _p(feet[1])]
        if continuity == "G2":
            K = _corner(Q[0], Q[1], normals[0], normals[1], P)
            poles = TColgp_Array1OfPnt(1, 5)
            poles.SetValue(1, Q[1])
            poles.SetValue(2, _p(_v(Q[1]) + (_v(K) - _v(Q[1])).Multiplied(1 - G2_TENSION)))
            poles.SetValue(3, K)
            poles.SetValue(4, _p(_v(Q[0]) + (_v(K) - _v(Q[0])).Multiplied(1 - G2_TENSION)))
            poles.SetValue(5, Q[0])
            curve = Geom_BezierCurve(poles)
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
    e = max(0.02 * size, 0.01)
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
        if not side.contains(_p(_v(P) + d.Multiplied(step)), tol):
            d.Reverse()
        side.inward_cached = d
    return 1 if sides[0].inward_cached.Dot(n2) < 0 else -1


def _edge_tool(shape, edge, kind, size, size2, continuity, tol):
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
            _convexity(P, T, sides, n1, n2, tol)
        wire, inner = _section(P, T, sides, s, kind, size, size2, continuity)
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

    if closed:
        half = len(wires) // 2
        return s, [loft(wires[: half + 1]), loft(wires[half:])]
    tool = loft(wires)
    reach = size * (G2_SETBACK if continuity == "G2" else 1.0) + (size2 or 0.0)
    for keep_inside, trim in _end_trims(shape, edge, faces, 50 * reach + 10):
        op = BRepAlgoAPI_Common() if keep_inside else BRepAlgoAPI_Cut()
        tool = _boolean(op, tool, [trim], max(tol * 10, 1e-5))
    return s, [tool]


def _end_trims(shape, edge, faces, size):
    """Solids that cut a blend off where its edge ends against another face.

    The lofted blend ends square to the edge, so where the edge stops at a face
    running across it (a wall the leg meets the floor beside) the blend would
    hang out past that face. Each such face's surface is made into a solid
    (half-space box, cylinder, sphere) and the blend is kept on the body's side
    of it. Faces tangent to the blend's own two faces carry on from them rather
    than end them, and surfaces with no simple solid are left alone."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeSphere
    from OCP.gp import gp_Ax2, gp_Dir, gp_Lin
    from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Sphere
    from OCP.TopAbs import TopAbs_VERTEX

    vmap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_VERTEX, TopAbs_FACE, vmap)
    own = [_Side(f, edge) for f in faces]
    out = []
    seen = []
    ex = TopExp_Explorer(edge, TopAbs_VERTEX)
    while ex.More():
        vtx = TopoDS.Vertex_s(ex.Current())
        ex.Next()
        idx = vmap.FindIndex(vtx)
        if idx == 0:
            continue
        at = BRep_Tool.Pnt_s(vtx)
        own_normals = []
        for sd in own:
            proj = GeomAPI_ProjectPointOnSurf(at, sd.surf)
            if proj.NbPoints():
                own_normals.append(sd.normal_uv(*proj.LowerDistanceParameters()))
        for f in vmap.FindFromIndex(idx):
            g = TopoDS.Face_s(f)
            if any(g.IsSame(x) for x in faces) or any(g.IsSame(x) for x in seen):
                continue
            seen.append(g)
            side = _Side.__new__(_Side)
            side.face, side.props, side.surf = g, BRepGProp_Face(g), BRep_Tool.Surface_s(g)
            proj = GeomAPI_ProjectPointOnSurf(at, side.surf)
            if proj.NbPoints() == 0:
                continue
            try:
                n = side.normal_uv(*proj.LowerDistanceParameters())
            except SectionBlendError:
                continue
            if any(abs(n.Dot(m)) > 0.9998 for m in own_normals):
                continue
            body_side = _p(_v(at) - n.Multiplied(1e-3 * size))
            ad = BRepAdaptor_Surface(g)
            kind = ad.GetType()
            if kind == GeomAbs_Plane:
                pln = ad.Plane()
                z = gp_Dir(-n.X(), -n.Y(), -n.Z())
                ax = gp_Ax2(pln.Location(), z)
                origin = ax.Location().Translated(
                    gp_Vec(ax.XDirection()).Multiplied(-size) + gp_Vec(ax.YDirection()).Multiplied(-size))
                box = BRepPrimAPI_MakeBox(gp_Ax2(origin, z, ax.XDirection()), 2 * size, 2 * size, size).Shape()
                out.append((True, box))
            elif kind == GeomAbs_Cylinder:
                cyl = ad.Cylinder()
                axis = cyl.Axis()
                base = axis.Location().Translated(gp_Vec(axis.Direction()).Multiplied(-size))
                solid = BRepPrimAPI_MakeCylinder(gp_Ax2(base, axis.Direction()), cyl.Radius(), 2 * size).Shape()
                inside = gp_Lin(axis).Distance(body_side) < cyl.Radius()
                out.append((inside, solid))
            elif kind == GeomAbs_Sphere:
                sph = ad.Sphere()
                solid = BRepPrimAPI_MakeSphere(sph.Location(), sph.Radius()).Shape()
                out.append((sph.Location().Distance(body_side) < sph.Radius(), solid))
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
    return op.Shape()


def _solid_count(shape):
    n = 0
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        n += 1
        ex.Next()
    return n


def section_blend(shape, edges, kind, size, size2=None, continuity="G1", sizes=None):
    """Blend `edges` of the TopoDS solid `shape` by lofted sections, returning a
    new TopoDS shape. `sizes`, when given, is one size per edge in place of
    `size`. Raises SectionBlendError with a sentence when it cannot."""
    sizes = list(sizes) if sizes is not None else [size] * len(edges)
    if any(not (x > 0) for x in sizes) or (size2 is not None and not (size2 > 0)):
        raise SectionBlendError("the size must be greater than 0")
    tol = 1e-6
    for e in edges:
        tol = max(tol, BRep_Tool.Tolerance_s(e))
    cut, fuse = [], []
    for e, sz in zip(edges, sizes):
        s, tools = _edge_tool(shape, e, kind, sz, size2, continuity, tol)
        (cut if s > 0 else fuse).extend(tools)
    fuzz = max(tol * 10, 1e-5)
    out = shape
    if cut:
        out = _boolean(BRepAlgoAPI_Cut(), out, cut, fuzz)
    if fuse:
        out = _boolean(BRepAlgoAPI_Fuse(), out, fuse, fuzz)
    up = ShapeUpgrade_UnifySameDomain(out, True, True, False)
    up.Build()
    out = up.Shape()
    if _solid_count(out) == 0:
        raise SectionBlendError("at this size the blend removes the whole body")
    if not BRepCheck_Analyzer(out).IsValid():
        raise SectionBlendError("at this size the blend makes a body that is not a valid solid")
    return out
