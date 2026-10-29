"""G3 fillet research probe (backlog nvc2hn0h), not a product test.

1. Measures every tangent (G1) edge of the BREP bodies g3_probe.rs wrote: the
   normal curvature across the edge on both faces, and its rate along that
   direction, from the surfaces' own second derivatives.
2. Rebuilds the straight edge section build the way blend_section.hxx does it
   (ball feet, corner K, Bezier section, skin offset, ruled ThruSections, cut or
   fuse) for the product's G2 quartic and for G3 candidates, and measures them
   the same way.
3. Lofts an arc rim through 25 sections (the non ruled ThruSections path) to see
   what the approximation leaves of each profile's continuity.

Run with the sidecar Python that has OCP:
python measure.py <dir with the .brep files>
python measure.py --scan    (septic leg spacings, peak curvature and setback)
python measure.py --sweep   (G2 and the septic G3 on wedges of 30 to 170 degrees)
"""

import math
import sys
import time

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import (BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace,
                                BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeWire,
                                BRepBuilderAPI_Transform)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepGProp import BRepGProp
from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism, BRepPrimAPI_MakeRevol
from OCP.BRepTools import BRepTools
from OCP.BRep import BRep_Builder
from OCP.Geom import Geom_BezierCurve
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
from OCP.GProp import GProp_GProps
from OCP.TColgp import TColgp_Array1OfPnt
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_IN, TopAbs_ON, TopAbs_REVERSED
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Shape
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

G2_SETBACK = 1.55
SKIPPED = [0]


def vec(p):
    return [p.X(), p.Y(), p.Z()]


def sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def add(a, b):
    return [a[i] + b[i] for i in range(3)]


def mul(a, k):
    return [x * k for x in a]


def dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def norm(a):
    return math.sqrt(dot(a, a))


def unit(a):
    n = norm(a)
    return [x / n for x in a]


def pnt(a):
    return gp_Pnt(*a)


# --- measuring ---------------------------------------------------------------


def surface_at(face, p):
    surf = BRep_Tool.Surface_s(face)
    proj = GeomAPI_ProjectPointOnSurf(pnt(p), surf)
    if proj.NbPoints() == 0:
        return None
    u, v = proj.LowerDistanceParameters()
    return surf, u, v


def normal_curvature(face, p, d):
    """Curvature of the face at p in tangent direction d, positive where it bends away from the outward normal."""
    got = surface_at(face, p)
    if got is None:
        return None
    surf, u, v = got
    P, Su, Sv, Suu, Svv, Suv = gp_Pnt(), gp_Vec(), gp_Vec(), gp_Vec(), gp_Vec(), gp_Vec()
    surf.D2(u, v, P, Su, Sv, Suu, Svv, Suv)
    su, sv = vec(Su), vec(Sv)
    n = unit(cross(su, sv))
    if face.Orientation() == TopAbs_REVERSED:
        n = mul(n, -1)
    e, f, g = dot(su, su), dot(su, sv), dot(sv, sv)
    r1, r2 = dot(su, d), dot(sv, d)
    det = e * g - f * f
    a, b = (r1 * g - r2 * f) / det, (e * r2 - f * r1) / det
    t = add(mul(su, a), mul(sv, b))
    second = add(add(mul(vec(Suu), a * a), mul(vec(Suv), 2 * a * b)), mul(vec(Svv), b * b))
    tt = dot(t, t)
    return (-dot(second, n) / tt if tt > 1e-24 else 0.0), vec(P), n


def inside(face, p, eps):
    """p lies on the face: projecting it moves it far less than eps and lands inside the bounds.
    A point past a B-spline face's boundary projects onto the boundary, eps away."""
    surf = BRep_Tool.Surface_s(face)
    proj = GeomAPI_ProjectPointOnSurf(pnt(p), surf)
    if proj.NbPoints() == 0 or proj.LowerDistance() > 0.05 * eps:
        return False
    u, v = proj.LowerDistanceParameters()
    from OCP.gp import gp_Pnt2d
    st = BRepClass_FaceClassifier(face, gp_Pnt2d(u, v), 1e-7).State()
    return st in (TopAbs_IN, TopAbs_ON)


def polyfit(xs, ys, deg):
    n = deg + 1
    a = [[sum(x ** (i + j) for x in xs) for j in range(n)] for i in range(n)]
    b = [sum(y * x ** i for x, y in zip(xs, ys)) for i in range(n)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(a[r][c]))
        a[c], a[piv], b[c], b[piv] = a[piv], a[c], b[piv], b[c]
        for r in range(n):
            if r != c:
                k = a[r][c] / a[c][c]
                a[r] = [a[r][j] - k * a[c][j] for j in range(n)]
                b[r] -= k * b[c]
    return [b[i] / a[i][i] for i in range(n)]


def profile_across(face, p, t, reach):
    """kappa(0) and dkappa/ds(0) walking from edge point p into the face, normal to edge tangent t."""
    _, _, n = normal_curvature(face, p, unit(cross([0, 0, 1], t)) if abs(t[2]) < 0.9 else [1, 0, 0])
    d = unit(cross(n, t))
    eps = 1e-3 * reach
    if not inside(face, add(p, mul(d, eps)), eps):
        d = mul(d, -1)
        if not inside(face, add(p, mul(d, eps)), eps):
            raise RuntimeError("neither side of the edge lies on the face")
    ss, ks = [], []
    for k in range(0, 9):
        s = reach * 0.04 * k / 8
        q = add(p, mul(d, s))
        got = normal_curvature(face, q, d)
        if got is None:
            continue
        ss.append(s)
        ks.append(got[0])
    c = polyfit(ss, ks, 3)
    return c[0], c[1]


def tangent_edges(shape):
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, m)
    out = []
    for i in range(1, m.Extent() + 1):
        edge = TopoDS.Edge_s(m.FindKey(i))
        faces = [TopoDS.Face_s(f) for f in m.FindFromIndex(i)]
        uniq = []
        for f in faces:
            if not any(f.IsSame(g) for g in uniq):
                uniq.append(f)
        if len(uniq) != 2 or BRep_Tool.Degenerated_s(edge):
            continue
        c = BRepAdaptor_Curve(edge)
        t0, t1 = c.FirstParameter(), c.LastParameter()
        p = vec(c.Value(0.5 * (t0 + t1)))
        if c.Value(t0).Distance(c.Value(t1)) < 1.0 and c.GetType() != 1:
            pass
        na = normal_curvature(uniq[0], p, [1, 0, 0])
        nb = normal_curvature(uniq[1], p, [1, 0, 0])
        if na is None or nb is None:
            continue
        if dot(na[2], nb[2]) > 1 - 1e-6:
            out.append((edge, uniq))
    return out


def worst_crease(shape):
    """Largest angle in degrees between the faces at a near tangent edge (normals within 25 degrees)."""
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, m)
    worst = 0.0
    for i in range(1, m.Extent() + 1):
        edge = TopoDS.Edge_s(m.FindKey(i))
        faces = [TopoDS.Face_s(f) for f in m.FindFromIndex(i)]
        if len(faces) != 2 or faces[0].IsSame(faces[1]) or BRep_Tool.Degenerated_s(edge):
            continue
        c = BRepAdaptor_Curve(edge)
        for w in (0.25, 0.5, 0.75):
            p = vec(c.Value(c.FirstParameter() + (c.LastParameter() - c.FirstParameter()) * w))
            na = normal_curvature(faces[0], p, [1, 0, 0])
            nb = normal_curvature(faces[1], p, [1, 0, 0])
            if na is None or nb is None:
                continue
            d = max(-1.0, min(1.0, dot(na[2], nb[2])))
            if d > math.cos(math.radians(25)):
                worst = max(worst, math.degrees(math.acos(d)))
    return worst


def measure_edge(edge, faces, reach, at=(0.25, 0.5, 0.75)):
    c = BRepAdaptor_Curve(edge)
    t0, t1 = c.FirstParameter(), c.LastParameter()
    rows = []
    for w in at:
        P, T = gp_Pnt(), gp_Vec()
        c.D1(t0 + (t1 - t0) * w, P, T)
        p, t = vec(P), unit(vec(T))
        try:
            a = profile_across(faces[0], p, t, reach)
            b = profile_across(faces[1], p, t, reach)
        except RuntimeError:
            SKIPPED[0] += 1
            continue
        rows.append((abs(a[0] - b[0]), abs(a[1] + b[1]), a, b))
    return rows


def jumps(shape, radius):
    """Worst curvature jump (times R) and curvature rate jump (times R^2) over the tangent edges.
    The rates add because each face's rate is taken walking away from the edge."""
    worst_k, worst_dk = 0.0, 0.0
    for edge, faces in tangent_edges(shape):
        for dk, ddk, _, _ in measure_edge(edge, faces, radius * 2):
            worst_k = max(worst_k, dk * radius)
            worst_dk = max(worst_dk, ddk * radius * radius)
    return worst_k, worst_dk


def facts(shape):
    g = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, g)
    nf = 0
    tol = 0.0
    ex = TopExp_Explorer(shape, TopAbs_FACE)
    while ex.More():
        nf += 1
        ex.Next()
    ex = TopExp_Explorer(shape, TopAbs_EDGE)
    while ex.More():
        tol = max(tol, BRep_Tool.Tolerance_s(TopoDS.Edge_s(ex.Current())))
        ex.Next()
    return g.Mass(), nf, tol, BRepCheck_Analyzer(shape).IsValid()


def read(path):
    s = TopoDS_Shape()
    BRepTools.Read_s(s, path, BRep_Builder())
    return s


# --- profiles ----------------------------------------------------------------


def g2_quartic(qa, k, qb):
    return [qa, add(qa, mul(sub(k, qa), 0.5)), k, add(qb, mul(sub(k, qb), 0.5)), qb]


def g3_poles(qa, k, qb, fr):
    """Degree 2n+2 (K shared, len(fr) = n) or 2n+1 (K absent) Bezier whose first n+1 poles lie on the leg to K."""
    shared = fr[-1] == 1.0
    leg_a = [add(qa, mul(sub(k, qa), f)) for f in [0.0] + fr]
    leg_b = [add(qb, mul(sub(k, qb), f)) for f in [0.0] + fr]
    if shared:
        return leg_a + leg_b[-2::-1]
    return leg_a + leg_b[::-1]


def bezier(poles):
    arr = TColgp_Array1OfPnt(1, len(poles))
    for i, p in enumerate(poles):
        arr.SetValue(i + 1, pnt(p))
    return Geom_BezierCurve(arr)


def depth_share(poles_fn):
    """Midpoint depth of a unit 90 degree section, over the leg length, for setback matching."""
    qa, k, qb = [1, 0, 0], [0, 0, 0], [0, 1, 0]
    c = bezier(poles_fn(qa, k, qb))
    m = vec(c.Value(0.5))
    return norm(m)


def curve_stats(poles_fn, setback):
    """Peak curvature times R and end jumps of a 90 degree section of radius 1 (legs = setback)."""
    qa, k, qb = [setback, 0, 0], [0, 0, 0], [0, setback, 0]
    c = bezier(poles_fn(qa, k, qb))
    peak = 0.0
    from OCP.GeomLProp import GeomLProp_CLProps
    for i in range(0, 201):
        pr = GeomLProp_CLProps(c, i / 200, 2, 1e-9)
        peak = max(peak, pr.Curvature())
    return peak


# --- straight edge builds ------------------------------------------------------


def prism(points, height):
    poly = BRepBuilderAPI_MakePolygon()
    for p in points:
        poly.Add(pnt(p))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire()).Face()
    return BRepPrimAPI_MakePrism(face, gp_Vec(0, 0, height)).Shape()


def section_wire(curve_poles, qa, qb, na, nb, corner, mid_normal, s, e):
    """Bezier from qb to qa, closed by the skin offset s*e like blend_section.hxx's run."""
    run = [qa, add(qa, mul(na, s * e)), add(corner, mul(mid_normal, s * e)), add(qb, mul(nb, s * e)), qb]
    wire = BRepBuilderAPI_MakeWire()
    wire.Add(BRepBuilderAPI_MakeEdge(bezier(curve_poles)).Edge())
    poly = BRepBuilderAPI_MakePolygon()
    for p in run:
        poly.Add(pnt(p))
    wire.Add(poly.Wire())
    return wire.Wire()


def straight_tool(poles_fn, ua, ub, radius, setback, s, height):
    """A ruled loft of the section at z = 0 and z = height, corner at the origin, legs along ua and ub."""
    half = math.acos(max(-1.0, min(1.0, dot(ua, ub)))) / 2
    leg = radius * setback / math.tan(half)
    qa, qb, k = mul(ua, leg), mul(ub, leg), [0.0, 0.0, 0.0]
    z = [0.0, 0.0, 1.0]
    na, nb = unit(cross(ua, z)), unit(cross(ub, z))
    if dot(na, ub) > 0:
        na = mul(na, -1)
    if dot(nb, ua) > 0:
        nb = mul(nb, -1)
    m = unit(add(na, nb))
    e = max(0.02 * radius, 0.01)
    wires = []
    for h in (0.0, height):
        lift = lambda p: add(p, [0, 0, h])
        poles = [lift(p) for p in poles_fn(qb, k, qa)]
        wires.append(section_wire(poles, lift(qa), lift(qb), na, nb, lift(k), m, 1, e))
    mk = BRepOffsetAPI_ThruSections(True, True, 1e-6)
    mk.CheckCompatibility(False)
    for w in wires:
        mk.AddWire(w)
    mk.Build()
    return mk.Shape()


def wedge(angle):
    t = math.radians(angle)
    return prism([[0, 0, 0], [-50, 0, 0], [-50 * math.cos(t), -50 * math.sin(t), 0]], 40), \
        [-1.0, 0.0, 0.0], [-math.cos(t), -math.sin(t), 0.0]


def inside_corner():
    a = prism([[-50, -50, 0], [50, -50, 0], [50, 0, 0], [0, 0, 0], [0, 50, 0], [-50, 50, 0]], 40)
    return a, [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]


def build_straight(body, ua, ub, poles_fn, setback, radius, convex):
    tool = straight_tool(poles_fn, ua, ub, radius, setback, 1 if convex else -1, 40)
    t = time.perf_counter()
    op = BRepAlgoAPI_Cut(body, tool) if convex else BRepAlgoAPI_Fuse(body, tool)
    out = op.Shape()
    return out, (time.perf_counter() - t) * 1000


# --- arc rim through a non ruled loft -----------------------------------------


def rim_tools(poles_fn, setback, radius, rc, sweep, n):
    """Sections of a convex 90 degree rim (top plane z=0, cylinder of radius rc about Z) lofted
    over `sweep` radians through n+1 sections, and the same section revolved."""
    leg = radius * setback
    e = max(0.02 * radius, 0.01)

    def wire_at(phi):
        r = [math.cos(phi), math.sin(phi), 0.0]
        p = mul(r, rc)
        qa = add(p, mul(r, -leg))
        qb = add(p, [0, 0, -leg])
        poles = poles_fn(qb, p, qa)
        return section_wire(poles, qa, qb, [0, 0, 1], r, p, unit(add([0, 0, 1], r)), 1, e)

    mk = BRepOffsetAPI_ThruSections(True, False, 1e-6)
    mk.CheckCompatibility(False)
    for i in range(n + 1):
        mk.AddWire(wire_at(sweep * i / n))
    mk.Build()
    loft = mk.Shape()
    face = BRepBuilderAPI_MakeFace(wire_at(0.0), True).Face()
    rev = BRepPrimAPI_MakeRevol(face, gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), sweep).Shape()
    return loft, rev


def rim_body(rc, sweep):
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCylinder
    from OCP.gp import gp_Ax2
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, -30), gp_Dir(0, 0, 1)), rc, 30, sweep).Shape()


def bezier_face_rate(shape, radius, at):
    """Measure only the edges where a Bezier or BSpline face meets the body's own faces."""
    rows = []
    for edge, faces in tangent_edges(shape):
        for dk, ddk, a, b in measure_edge(edge, faces, radius * 2, at):
            rows.append((dk * radius, ddk * radius * radius))
    if not rows:
        return None
    return max(r[0] for r in rows), max(r[1] for r in rows)


# --- three edge corner (ball_corners and patch_solid) --------------------------


def edge_tool(poles_fn, origin, axis, ua, ub, radius, setback, length):
    """A ruled loft along a straight convex 90 degree edge from origin along axis, legs along ua and ub."""
    leg = radius * setback
    na, nb = mul(ub, -1), mul(ua, -1)
    m = unit(add(na, nb))
    e = max(0.02 * radius, 0.01)
    wires = []
    for h in (0.0, length):
        at = add(origin, mul(axis, h))
        qa, qb = add(at, mul(ua, leg)), add(at, mul(ub, leg))
        wires.append(section_wire(poles_fn(qb, at, qa), qa, qb, na, nb, at, m, 1, e))
    mk = BRepOffsetAPI_ThruSections(True, True, 1e-6)
    mk.CheckCompatibility(False)
    for w in wires:
        mk.AddWire(w)
    mk.Build()
    return mk.Shape()


def patch_solid(poles_fn, a, ns, d):
    from OCP.Geom import Geom_BezierSurface
    from OCP.TColgp import TColgp_Array2OfPnt
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
    from OCP.ShapeFix import ShapeFix_Solid
    n1, n2, n3 = ns
    up = mul(n3, d)
    pole = add(a, up)
    ring = poles_fn(add(a, mul(n1, d)), add(add(a, mul(n1, d)), mul(n2, d)), add(a, mul(n2, d)))
    rows = [poles_fn(pole, add(e, up), e) for e in ring]
    arr = TColgp_Array2OfPnt(1, len(ring), 1, len(rows[0]))
    for i, row in enumerate(rows):
        for j, q in enumerate(row):
            arr.SetValue(i + 1, j + 1, pnt(q))
    surf = Geom_BezierSurface(arr)
    faces = [BRepBuilderAPI_MakeFace(surf, 0.0, 1.0, 0.0, 1.0, 1e-7).Face()]
    isos = [(surf.UIso(0.0), add(a, mul(n1, d)), pole), (surf.UIso(1.0), add(a, mul(n2, d)), pole),
            (surf.VIso(1.0), add(a, mul(n1, d)), add(a, mul(n2, d)))]
    for crv, e0, e1 in isos:
        w = BRepBuilderAPI_MakeWire()
        w.Add(BRepBuilderAPI_MakeEdge(crv).Edge())
        w.Add(BRepBuilderAPI_MakePolygon(pnt(e1), pnt(a), pnt(e0)).Wire())
        faces.append(BRepBuilderAPI_MakeFace(w.Wire(), True).Face())
    sew = BRepBuilderAPI_Sewing(1e-6)
    for f in faces:
        sew.Add(f)
    sew.Perform()
    from OCP.TopAbs import TopAbs_SHELL
    ex = TopExp_Explorer(sew.SewedShape(), TopAbs_SHELL)
    return ShapeFix_Solid().SolidFromShell(TopoDS.Shell_s(ex.Current()))


def corner3(poles_fn, setback, radius):
    """The product's three edge corner on a 50 x 50 x 40 block whose corner is the origin, in one cut."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.TopTools import TopTools_ListOfShape
    body = BRepPrimAPI_MakeBox(gp_Pnt(-50, -50, -40), gp_Pnt(0, 0, 0)).Shape()
    x, y, z = [1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]
    neg = lambda v: mul(v, -1)
    tools = [edge_tool(poles_fn, [-50, 0, 0], x, neg(y), neg(z), radius, setback, 50),
             edge_tool(poles_fn, [0, -50, 0], y, neg(z), neg(x), radius, setback, 50),
             edge_tool(poles_fn, [0, 0, -40], z, neg(x), neg(y), radius, setback, 40)]
    d = radius * setback
    c = [-d, -d, -d]
    kept = patch_solid(poles_fn, c, [x, y, z], d)
    side = d * 1.02 + 1e-3
    cell = BRepPrimAPI_MakeBox(pnt(c), pnt(add(c, [side] * 3))).Shape()
    tools.insert(0, BRepAlgoAPI_Cut(cell, kept).Shape())
    # One cut with all four tools dropped the corner tool's material (97646 mm3, product 96817),
    # the product's boolean_all verifies and retries; here the tools go one at a time. With G3
    # sections, edges then corner came back empty or invalid for 3 of 5 profiles at every fuzz
    # from 0 to 1e-4, corner first was valid for all of them, so the corner goes first.
    t0 = time.perf_counter()
    out = body
    for t in tools:
        args, tl = TopTools_ListOfShape(), TopTools_ListOfShape()
        args.Append(out)
        tl.Append(t)
        op = BRepAlgoAPI_Cut()
        op.SetArguments(args)
        op.SetTools(tl)
        op.SetFuzzyValue(1e-5)
        op.Build()
        out = op.Shape()
    return out, (time.perf_counter() - t0) * 1000


def septic(qa, k, qb):
    """The recommended G3 section: degree 7, four poles evenly spaced on each leg, K itself not a pole."""
    return g3_poles(qa, k, qb, [0.25, 0.5, 0.75])


def scan(share_g2):
    """Septic leg spacings, each with its setback matched to the G2 midpoint depth at 90 degrees."""
    from OCP.GeomLProp import GeomLProp_CLProps

    def stats(fn, sb):
        c = bezier(fn([sb, 0, 0], [0, 0, 0], [0, sb, 0]))
        ks = [GeomLProp_CLProps(c, i / 400, 2, 1e-9).Curvature() for i in range(401)]
        pts = [vec(c.Value(i / 400)) for i in range(401)]
        rate = max(abs(ks[i + 1] - ks[i]) / norm(sub(pts[i + 1], pts[i])) for i in range(400))
        return max(ks), rate

    rows = []
    steps = [i / 20 for i in range(1, 20)]
    for a in steps:
        for b in steps:
            for c in steps:
                if a < b < c:
                    fn = (lambda fr: lambda p, k, q: g3_poles(p, k, q, fr))([a, b, c])
                    sb = share_g2 / depth_share(fn)
                    rows.append((*stats(fn, sb), sb, [a, b, c]))
    for title, key in (("lowest peak curvature", 0), ("lowest peak curvature rate", 1)):
        print(title)
        for r in sorted(rows, key=lambda r: r[key])[:4]:
            print(f"  peak {r[0]:.3f}/R  max rate {r[1]:.3f}/R^2  setback {r[2]:.3f}R  legs {r[3]}")
    for name, fn, sb in (("G2 quartic", g2_quartic, G2_SETBACK), ("septic 1/4 1/2 3/4", septic, share_g2 / depth_share(septic))):
        pk, rate = stats(fn, sb)
        print(f"{name}: peak {pk:.3f}/R  max rate {rate:.3f}/R^2  setback {sb:.4f}R")


def sweep(share_g2):
    sb3 = share_g2 / depth_share(septic)
    print("angle  R    | G2 valid kL     dk/ds L^2  ms | G3 valid kL     dk/ds L^2  ms   (L = setback along the face)")
    for ang in (30, 45, 60, 90, 120, 150, 170):
        for radius in (0.5, 5, 10, 20, 40):
            line = []
            for fn, sb in ((g2_quartic, G2_SETBACK), (septic, sb3)):
                leg = radius * sb / math.tan(math.radians(ang) / 2)
                if leg > 45:
                    line = None
                    break
                body, ua, ub = wedge(ang)
                out, ms = build_straight(body, ua, ub, fn, sb, radius, True)
                v, nf, tol, ok = facts(out)
                k, dk = jumps(out, leg)
                line.append(f"{str(ok and nf == 6 and tol <= 1e-5):5s} {k:.1e} {dk:.1e} {ms:4.0f}")
            if line:
                print(f"{ang:5d} {radius:4.1f} | " + " | ".join(line))


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "."
    print("== product bodies (g3_probe.rs) ==")
    import glob
    import os
    for path in sorted(glob.glob(os.path.join(src, "*.brep"))):
        name = os.path.basename(path)[:-5]
        radius = 3.0 if name.startswith("plane_cyl_arc") else 10.0
        if "_r" in name and name.startswith("plane_cyl_line"):
            radius = float(name.split("_r")[1].split("_")[0])
        shape = read(path)
        v, nf, tol, ok = facts(shape)
        k, dk = jumps(shape, radius)
        print(f"{name:26s} vol {v:11.4f} faces {nf:3d} tol {tol:.1e} valid {ok}  max jump kR {k:.4f}  "
              f"dk/ds R^2 {dk:.4f}  crease {worst_crease(shape):.3f} deg")

    profiles = {
        "G2 quartic (product)": (g2_quartic, G2_SETBACK),
    }
    share_g2 = depth_share(g2_quartic) * G2_SETBACK
    candidates = {
        "G3 sextic 1/3 2/3": [1 / 3, 2 / 3, 1.0],
        "G3 sextic 1/2 3/4": [0.5, 0.75, 1.0],
        "G3 sextic 0.4 0.7": [0.4, 0.7, 1.0],
        "G3 septic 1/4 1/2 3/4": [0.25, 0.5, 0.75],
        "G3 septic 0.4 0.7 0.9": [0.4, 0.7, 0.9],
    }
    for name, fr in candidates.items():
        fn = (lambda fr: lambda a, k, b: g3_poles(a, k, b, fr))(fr)
        profiles[name] = (fn, share_g2 / depth_share(fn))

    print("\n== profiles at 90 degrees, setback matched to the G2 midpoint depth ==")
    for name, (fn, sb) in profiles.items():
        print(f"{name:24s} setback {sb:.3f} R   peak curvature {curve_stats(fn, sb):.3f} / R")

    print("\n== straight edge section builds (Python replica of blend_section.hxx) ==")
    cases = [("wedge90", wedge(90), True), ("wedge120", wedge(120), True), ("wedge60", wedge(60), True),
             ("inside90", inside_corner(), False)]
    for cname, (body, ua, ub), convex in cases:
        for name, (fn, sb) in profiles.items():
            out, ms = build_straight(body, ua, ub, fn, sb, 10.0, convex)
            v, nf, tol, ok = facts(out)
            k, dk = jumps(out, 10.0)
            print(f"{cname:9s} {name:24s} vol {v:11.4f} faces {nf:3d} tol {tol:.1e} valid {ok} "
                  f"boolean {ms:6.1f} ms  jump kR {k:.2e}  dk/ds R^2 {dk:.2e}")

    print("\n== three edge corner, 50 x 50 x 40 block, R 10, corner tool then edge tools, one at a time ==")
    for name, (fn, sb) in profiles.items():
        out, ms = corner3(fn, sb, 10.0)
        v, nf, tol, ok = facts(out)
        k, dk = jumps(out, 10.0)
        print(f"{name:24s} vol {v:11.4f} faces {nf:3d} tol {tol:.1e} valid {ok} boolean {ms:6.1f} ms  "
              f"jump kR {k:.2e}  dk/ds R^2 {dk:.2e}  crease {worst_crease(out):.3f} deg")

    print("\n== rim arc, 90 degree plane and cylinder rc 15, R 3, 150 degrees: loft of 25 sections vs revolve ==")
    rc, sweep = 15.0, math.radians(150)
    for name, (fn, sb) in profiles.items():
        loft, rev = rim_tools(fn, sb, 3.0, rc, sweep, 24)
        body = rim_body(rc, sweep)
        for kind, tool in (("loft", loft), ("revolve", rev)):
            t = time.perf_counter()
            out = BRepAlgoAPI_Cut(body, tool).Shape()
            ms = (time.perf_counter() - t) * 1000
            v, nf, tol, ok = facts(out)
            got = bezier_face_rate(out, 3.0, (0.21, 0.5, 0.52, 0.79))
            k, dk = got if got else (float("nan"), float("nan"))
            print(f"{name:24s} {kind:7s} vol {v:10.4f} faces {nf:3d} tol {tol:.1e} valid {ok} "
                  f"boolean {ms:6.1f} ms  jump kR {k:.2e}  dk/ds R^2 {dk:.2e}")


if __name__ == "__main__":
    if "--scan" in sys.argv:
        scan(depth_share(g2_quartic) * G2_SETBACK)
    elif "--sweep" in sys.argv:
        sweep(depth_share(g2_quartic) * G2_SETBACK)
    else:
        main()
    print(f"edge samples skipped (no face side found): {SKIPPED[0]}")
