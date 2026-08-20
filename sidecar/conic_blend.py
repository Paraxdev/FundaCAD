"""Conic-profile edge blends — the fillet/chamfer family as one continuous knob.

A circular fillet and a 45-degree chamfer are the two ends of a single family of
sections. Kernels that expose that family as a single parameter allow travel
between the two without changing the feature. OCCT does not:
`BRepFilletAPI_MakeFillet` offers a radius and nothing about the section's shape
(`ChFi3d_FilletShape` picks how the CIRCLE is approximated, not what curve to
use), and its blend functions are circular, chamfer or ruled only.

But it does not need to offer it, because of one fact about circular arcs:

    an arc of sweep theta IS a rational quadratic Bezier with poles
    (P1, apex, P2) and middle weight cos(theta / 2)

and OCCT builds its blend faces out of exactly those arcs. Convert a blend face
to NURBS and it comes back degree 2 across the section with three pole rows and
that weight sitting in the middle. So the whole conic family is reachable by
scaling one row of weights — no lofting, no fitting, no surface of our own:

    profile  0  ->  k = 1        the circular fillet, untouched
    profile -1  ->  k = 0        the chord: a chamfer
    profile +1  ->  k = infinity the control polygon: no blend, a sharp corner

with `k` below. Two properties make this worth doing the awkward way round
(fillet first, then reweight) rather than building blend surfaces directly:

  * No pole moves and no knot changes, so the tangency curves onto the supporting
    faces are bit-identical to OCCT's and every pcurve stays valid. We inherit
    OCCT's tangency, its handling of tangent chains, and its corner patches.
  * A spherical corner patch is the tensor product of two arcs — its weights are
    the outer product of (1, cos(theta/2), 1) with itself — so scaling every
    middle weight converts tubes and corners by the same rule, and the shared
    boundaries still agree because both sides scaled identically.

What we DO have to repair: an edge running across a section moves (its arc
becomes a conic). Its pcurve is still right, so the new 3D curve is recovered
from (pcurve, new surface), which is the definition of the curve we want.

That last step rests on every boundary of a blend face being one of two things:
a tangency rail (an arc END pole, which does not move) or a whole section (which
moves inside its own plane, so its pcurve still describes it). Two other kinds
exist, and they are not the same problem.

A MITRE SEAM is where OCCT runs two blends the full length of their edges and
trims them against each other instead of inserting a corner patch — which is
what it does for the four top edges of a box, so it is two clicks away. Such a
seam runs ACROSS the sections and is a whole section on neither side, so both
faces' pcurves go stale and each face ends up describing a different curve
(measured: 2.7mm apart on a 4mm blend at profile 0.9, while both ENDS still
agree exactly, since they sit on poles). It is recoverable, because the section
PLANES do not move: the two planes still meet in the same line, the old seam
point is still on that line, and each new section crosses it at one solvable
place. See `_reseam`.

A BOOLEAN TRIM is not recoverable. When a blend runs off the end of one of its
supports it is cut by whatever it hits, and that trim is a genuine
surface/surface intersection: it lands on a different pcurve once the section
changes shape, and its corner vertices move with it (measured: on a 4.8mm blend,
up to 2.8mm at profile 0.95). Re-cutting is a different operation from
reweighting, so such a blend is refused rather than approximated — see
`ConicNotApplicable`.

Caveat for callers: `BRepGProp.VolumeProperties` integrates in parameter space
and is unreliable on these surfaces at large |profile| — weights spanning two
orders of magnitude defeat its quadrature. It reported a blend that removes ~2mm3
of a box as removing 450mm3. Measure such solids from the tessellation instead;
the geometry is exact, the integrator is not.
"""

from OCP.BRep import BRep_Tool, BRep_Builder
from OCP.BRepAdaptor import BRepAdaptor_Curve2d
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepLib import BRepLib
from OCP.BRepTools import BRepTools, BRepTools_ReShape
from OCP.Geom import Geom_RectangularTrimmedSurface
from OCP.Geom2dAPI import Geom2dAPI_Interpolate
from OCP.GeomConvert import GeomConvert
from OCP.ShapeFix import ShapeFix_Shape
from OCP.TColgp import TColgp_HArray1OfPnt2d
from OCP.TColStd import TColStd_HArray1OfReal
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_WIRE
from OCP.TopExp import TopExp
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Face
from OCP.TopTools import TopTools_IndexedMapOfShape
from OCP.gp import gp_Pnt2d, gp_Vec

TOL = 1e-7

#: Below this, a profile is the plain circular fillet. Not a nicety: k == 1 makes
#: every step here a no-op, so routing it to OCCT's own result skips the rebuild
#: entirely and keeps the common case exactly as robust as it was.
PROFILE_EPS = 1e-6

#: The slider is open at both ends — a profile of exactly 1 is a sharp corner (no
#: feature at all) and exactly -1 is a degenerate zero weight. Clamp inside.
PROFILE_LIMIT = 0.999


class ConicNotApplicable(ValueError):
    """This blend is not a member of the conic family, at any profile.

    Its own class rather than a bare ValueError because callers must tell it
    apart from "we tried and broke it". Nothing is wrong with the fillet, the
    solid or the request — the reweighting identity simply does not describe
    this face, so the only honest answers are the plain fillet or nothing. A
    caller that catches this can fall back to profile 0; a caller that catches
    ValueError generally is catching real breakage as well.
    """


def clamp_profile(p):
    """Hold a profile inside the open interval the maths is defined on."""
    try:
        v = float(p)
    except (TypeError, ValueError):
        return 0.0
    if v != v:  # NaN
        return 0.0
    return max(-PROFILE_LIMIT, min(PROFILE_LIMIT, v))


def weight_scale(profile):
    """Middle-weight multiplier for a profile in (-1, 1).

    Deliberately independent of the corner angle: the angle is already baked into
    the weight being scaled (it IS cos(theta/2)), so one factor is correct for a
    90-degree box edge and a shallow one alike. That is what lets a single number
    drive every blend face of a feature, including its corner patches.
    """
    p = clamp_profile(profile)
    return (1.0 + p) if p <= 0 else 1.0 / (1.0 - p)


def _sub(shape, kind):
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, m)
    return [m.FindKey(i) for i in range(1, m.Size() + 1)]


def _nurbs_of(face):
    """The face's surface as a BSpline over exactly the face's own UV box."""
    surf = BRep_Tool.Surface_s(face)
    u0, u1, v0, v1 = BRepTools.UVBounds_s(face)
    return GeomConvert.SurfaceToBSplineSurface_s(
        Geom_RectangularTrimmedSurface(surf, u0, u1, v0, v1))


def _arc_dirs(bs):
    """Which parameter directions carry a single rational quadratic arc.

    Degree 2, three poles, and the (1, cos(theta/2), 1) signature. A tube blend
    has one such direction; a spherical corner patch has both. A toroidal blend's
    spine is a FULL circle and so has six poles — which is why the test is on the
    pole structure and not merely "is this direction quadratic".
    """
    out = []
    for along_u in (True, False):
        deg = bs.UDegree() if along_u else bs.VDegree()
        n = bs.NbUPoles() if along_u else bs.NbVPoles()
        if deg != 2 or n != 3:
            continue
        w = (lambda i: bs.Weight(i, 1)) if along_u else (lambda j: bs.Weight(1, j))
        if abs(w(1) - w(3)) < 1e-9 and w(2) < w(1) - 1e-9:
            out.append(along_u)
    return out


def _reweight(bs, along_u, k):
    """Scale the middle pole row. Mutates `bs` in place."""
    if along_u:
        for j in range(1, bs.NbVPoles() + 1):
            bs.SetWeight(2, j, bs.Weight(2, j) * k)
    else:
        for i in range(1, bs.NbUPoles() + 1):
            bs.SetWeight(i, 2, bs.Weight(i, 2) * k)


def _blend_faces(sharp, mk, result):
    """Result faces that are not descendants of an input face — the blend."""
    kept = []
    for f in _sub(sharp, TopAbs_FACE):
        kept += list(mk.Modified(f))
        if not mk.IsDeleted(f):
            kept.append(f)
    return [TopoDS.Face_s(f) for f in _sub(result, TopAbs_FACE)
            if not any(f.IsSame(k) for k in kept)]


def _reskin(face, newsurf):
    """The same face on a new surface: same wires, same edges, same pcurves.

    Sound only because reweighting leaves the UV domain alone — every pcurve
    already on these edges still describes the right curve against the new
    surface, so the shell still closes and the neighbours never notice.
    """
    b = BRep_Builder()
    nf = TopoDS_Face()
    b.MakeFace(nf, newsurf, TopLoc_Location(), TOL)
    for w in _sub(face, TopAbs_WIRE):
        for e in _sub(w, TopAbs_EDGE):
            edge = TopoDS.Edge_s(e)
            pc = BRep_Tool.CurveOnSurface_s(edge, face, 0.0, 0.0)
            if pc is not None:
                b.UpdateEdge(edge, pc, nf, TOL)
        b.Add(nf, TopoDS.Wire_s(w))
    nf.Orientation(face.Orientation())
    return nf


def _trace(edge, face, surf, samples=12):
    """Where this edge's pcurve on `face` lands, evaluated on `surf`.

    With the face's own surface it retraces the edge; with the reweighted one it
    shows where the UNCHANGED pcurve now points, which is the only thing that
    decides whether a pcurve survived the reweight.
    """
    ad = BRepAdaptor_Curve2d(edge, face)
    a, z = ad.FirstParameter(), ad.LastParameter()
    return [surf.Value(uv.X(), uv.Y()) for uv in
            (ad.Value(a + (z - a) * i / samples) for i in range(samples + 1))]


def _moved_edges(face, oldsurf, newsurf, samples=12):
    """Edges of this face whose 3D curve moved under the reweight.

    Measured rather than reasoned about: evaluate the (unchanged) pcurve on both
    surfaces and see if the point moved. Deciding instead by "which iso is the
    section" would have to be right for cylinders, tori and sphere patches
    separately, and each of those puts the section on a different parameter.
    """
    out = []
    for e in _sub(face, TopAbs_EDGE):
        edge = TopoDS.Edge_s(e)
        old = _trace(edge, face, oldsurf, samples)
        new = _trace(edge, face, newsurf, samples)
        if any(p.Distance(q) > 1e-9 for p, q in zip(old, new)):
            out.append(edge)
    return out


def _plane_normal(c):
    """The normal of the plane a 3-pole section lies in.

    Three poles always span a plane, and reweighting moves none of them, so this
    plane is the same before and after — which is the whole reason the crossing
    below can be solved in closed form.
    """
    p1, p2, p3 = c.Pole(1), c.Pole(2), c.Pole(3)
    return gp_Vec(p1, p2).Crossed(gp_Vec(p1, p3))


def _roots(a, b, c):
    """Real roots of a s^2 + b s + c, by the form that does not cancel."""
    scale = max(abs(a), abs(b), abs(c))
    if scale == 0.0:
        return []
    if abs(a) < 1e-15 * scale:
        return [] if abs(b) < 1e-15 * scale else [-c / b]
    disc = b * b - 4 * a * c
    # A seam ENDS on a pole of its own section, where the line is tangent and the
    # true discriminant is exactly 0 — so it arrives as a small negative number
    # and the endpoint reads as "these blends do not meet", which is the one
    # place the answer is known in advance. Round-off only, at 1e-49 of the
    # coefficients here, so the clamp does not reach a genuine near miss.
    if disc < 0.0:
        if disc > -1e-12 * scale * scale:
            disc = 0.0
        else:
            return []
    # -b +/- sqrt(disc) loses the small root to cancellation when b dominates.
    # Take the root that adds, then get the other from the product of roots.
    q = -0.5 * (b + (disc ** 0.5 if b >= 0 else -(disc ** 0.5)))
    return [q / a] if abs(q) < 1e-15 * scale else [q / a, c / q]


def _section_crosses(c, x, e2, hint):
    """The parameter on section `c` where it crosses the line through `x`.

    `e2` is the in-plane direction the line is perpendicular to, so the crossing
    is where (C(s) - x) . e2 vanishes. A rational quadratic Bezier makes that a
    quadratic in s with the weights as coefficients, which is why this is
    arithmetic rather than a search: OCCT's curve/curve extrema gives the same
    answer, at about 2ms a call and several hundred calls per seam.

    `hint` is the stale parameter, used only to choose between two crossings.
    """
    if e2.Magnitude() <= 0.0:
        return None
    e2 = e2.Normalized()  # so the coefficients below are millimetres, not areas
    w = [c.Weight(i) for i in (1, 2, 3)]
    q = [gp_Vec(x, c.Pole(i)).Dot(e2) for i in (1, 2, 3)]
    w0q0, w1q1, w2q2 = w[0] * q[0], w[1] * q[1], w[2] * q[2]
    found = [s for s in _roots(w0q0 - 2 * w1q1 + w2q2, 2 * (w1q1 - w0q0), w0q0)
             if -1e-9 <= s <= 1 + 1e-9]
    if not found:
        return None
    lo, hi = c.FirstParameter(), c.LastParameter()
    s = min(found, key=lambda s: abs(lo + s * (hi - lo) - hint))
    return lo + min(1.0, max(0.0, s)) * (hi - lo)


def _arc_of(bs, along_u, uv):
    """The section arc of `bs` running through (u, v).

    `along_u` says the arc runs along U, so the section is selected by holding V.
    OCCT names an isocurve by the parameter it HOLDS FIXED, so the arc along U is
    the V-isocurve, not the U one.
    """
    return bs.VIso(uv.Y()) if along_u else bs.UIso(uv.X())


def _sides_agree(edge, sides, samples=12):
    """Do both blend faces still describe this shared edge the same way?

    Pass 2 rebuilds one representative face per shared edge, on the grounds that
    where two blend faces share an edge they agree. That holds when the edge is a
    whole SECTION on both sides: it moves inside its own plane, so each face's
    pcurve still describes it. It does not hold for a MITRE seam, where two
    blends were trimmed against each other and the seam crosses the sections
    instead of being one. Then the stale pcurve names a point that is not on the
    other face at all, and the two sides part company by millimetres.

    So test the claim instead of assuming it.
    """
    (fa, ba), (fb, bb) = sides[0], sides[1]
    scale = max(_extent(ba), _extent(bb))
    return all(p.Distance(q) <= scale * 1e-7 for p, q in
               zip(_trace(edge, fa, ba, samples), _trace(edge, fb, bb, samples)))


def _extent(bs):
    """How big this blend face is, from its control polygon.

    A local length to judge gaps against, so the judgement travels: the same
    blend modelled in metres and in millimetres has to be called the same thing.
    The poles bound the surface, and reading them costs nothing next to sampling
    it.
    """
    lo = [1e300] * 3
    hi = [-1e300] * 3
    for i in range(1, bs.NbUPoles() + 1):
        for j in range(1, bs.NbVPoles() + 1):
            p = bs.Pole(i, j)
            for c, x in enumerate((p.X(), p.Y(), p.Z())):
                lo[c], hi[c] = min(lo[c], x), max(hi[c], x)
    return max(TOL, sum((hi[c] - lo[c]) ** 2 for c in range(3)) ** 0.5)


def _pair_vertices(edge, start, end):
    """The edge's vertices, ordered to match a curve running `start` -> `end`.

    Reuse the original vertices — a section's endpoints are corner poles, and
    corner poles do not move, so the neighbouring faces still meet us exactly
    there. Pair them by POSITION: an edge's stored first/last follow its own
    curve, which need not agree with its sense inside this wire, and getting
    that backwards fails the build with DifferentsPointAndParameter.

    Score the two assignments whole rather than asking only "which vertex is
    nearer the start". On a short section the two vertices can sit closer to
    each other than either is to the wrong end, and the one-sided test then
    picks by a difference that is pure rounding; using both ends makes the
    decision the sum of two agreements, which no near-coincidence can flip.
    """
    v1, v2 = TopExp.FirstVertex_s(edge), TopExp.LastVertex_s(edge)
    a, b = BRep_Tool.Pnt_s(v1), BRep_Tool.Pnt_s(v2)
    if (a.Distance(start) + b.Distance(end)
            > b.Distance(start) + a.Distance(end)):
        return v2, v1, b, a
    return v1, v2, a, b


def _settle_ends(edge, start, end, scale, too_far):
    """The edge's vertices, ordered and reconciled with a curve start -> end.

    A corner that no longer lands where the rebuilt curve starts is one of two
    completely different things, and the size of the gap tells them apart.

    Round-off, at a millionth of the face: a section endpoint sits on an END
    pole, which no reweight moves, but it sits there through a pcurve value and a
    UV box that were each rounded once, so it can land a hair inside the arc —
    where the reweight does move it, by a hair times k. OCCT already has the word
    for "the curves meet here, within this much": the vertex's own tolerance.
    Widen it rather than refusing a corner blend over a nanometre.

    Otherwise the blend is bounded by something that has to be re-intersected
    rather than reweighted (see the module docstring), and no tolerance can
    honestly cover that — the same corner walks millimetres as the profile
    sweeps. Refuse by name here, where the measurement is in hand, instead of
    letting MakeEdge report a bare DifferentsPointAndParameter. Measured: 1e-6 of
    the face for round-off against 0.2 of it for a real cut.
    """
    v1, v2, a, b = _pair_vertices(edge, start, end)
    for v, p, q in ((v1, a, start), (v2, b, end)):
        gap = p.Distance(q)
        if gap <= max(BRep_Tool.Tolerance_s(v), TOL):
            continue
        if gap > scale * 1e-4:
            raise ConicNotApplicable(too_far(gap))
        BRep_Builder().UpdateVertex(TopoDS.Vertex_s(v), gap * 2.0)
    return v1, v2


#: How closely the fitted seam has to reproduce the solved crossings, as a
#: fraction of the blend's own size. The crossings themselves are exact; a cubic
#: through them is not, so the fit is refined until it agrees to this. Relative,
#: so the same blend in metres and in millimetres gets the same answer.
SEAM_FIT = 1e-7

#: Refuse rather than ship a seam this far out even after refining. Same
#: threshold `_rebuild_edge` uses to tell round-off from a genuine re-cut.
SEAM_LIMIT = 1e-4

#: Refining stops at this many samples on one seam. Generous, because refinement
#: is local: reaching it means the seam is not something a piecewise cubic
#: converges on at all, which is the SEAM_LIMIT case.
SEAM_SAMPLES_MAX = 400


def _reseam(edge, sides, samples=24):
    """A mitre seam re-solved section by section, with both pcurves rewritten.

    A seam that is a whole section on both sides needs none of this. A mitre
    seam — where two blends were trimmed against each other so the seam runs
    ACROSS the sections rather than being one — does: its stale pcurves point
    somewhere that is no longer on the other face. Measured on a 4mm blend
    around a box's top face at profile 0.9, the two sides' ideas of the seam
    diverge by 2.7mm in the middle while both ENDS still agree exactly, which is
    why the endpoint check in `_rebuild_edge` cannot see it. Picking one side
    arbitrarily then left SameParameter to widen the edge's tolerance until the
    other side fitted inside it, and a tolerance that wide is a licence for the
    mesher to wander: the seam rendered as a visible wobble.

    Re-solving is possible because the reweight moves each point WITHIN its own
    section and never across sections. So on the seam the section index of each
    stale pcurve is still correct, and only the arc parameter is stale. Hold each
    section, take the two arcs, and ask where they now cross. Both faces are
    solved from that one crossing, so they agree by construction rather than by
    assumption.

    Raises ConicNotApplicable when the two arcs do not meet: then no reweighted
    seam exists and the blend is genuinely outside the family.
    """
    (fa, ba, da), (fb, bb, db) = sides[0], sides[1]
    if len(da) != 1 or len(db) != 1:
        # A section that is an arc in BOTH parameters is a sphere patch, and
        # there is then no single "section index" to hold fixed. No mitred corner
        # patch has turned up to measure, so refuse rather than guess.
        raise ConicNotApplicable(
            "two blends meet here along a corner patch, which has no single "
            "section to re-solve — use profile 0 for a plain fillet here")

    aa, ab = BRepAdaptor_Curve2d(edge, fa), BRepAdaptor_Curve2d(edge, fb)
    lo, hi = aa.FirstParameter(), aa.LastParameter()
    olda, oldb = BRep_Tool.Surface_s(fa), BRep_Tool.Surface_s(fb)
    scale = max(_extent(ba), _extent(bb))
    solved = {}

    def say(why):
        return (f"the two blends meeting at this corner {why} at this profile, "
                "so their seam would have to be recomputed rather than "
                "reweighted — use profile 0 here")

    def refuse(why):
        return ConicNotApplicable(say(why))

    def crossing(t):
        """Where the two sections at edge parameter `t` now meet.

        Both section planes are fixed, so they still meet in the same line, and
        the old seam point is still on it. Each new section is then intersected
        with that line, and the two answers are compared: agreeing is what makes
        this the seam rather than two unrelated points.
        """
        if t in solved:
            return solved[t]
        sa, sb = aa.Value(t), ab.Value(t)
        ca, cb = _arc_of(ba, da[0], sa), _arc_of(bb, db[0], sb)
        na, nb = _plane_normal(ca), _plane_normal(cb)
        d = na.Crossed(nb)
        if d.Magnitude() <= 1e-12 * na.Magnitude() * nb.Magnitude():
            raise refuse("lie in the same plane")
        was = olda.Value(sa.X(), sa.Y())
        ua = _section_crosses(ca, was, na.Crossed(d), sa.X() if da[0] else sa.Y())
        ub = _section_crosses(cb, was, nb.Crossed(d), sb.X() if db[0] else sb.Y())
        if ua is None or ub is None:
            raise refuse("no longer reach each other")
        pa = gp_Pnt2d(ua, sa.Y()) if da[0] else gp_Pnt2d(sa.X(), ua)
        pb = gp_Pnt2d(ub, sb.Y()) if db[0] else gp_Pnt2d(sb.X(), ub)
        if ba.Value(pa.X(), pa.Y()).Distance(bb.Value(pb.X(), pb.Y())) > scale * 1e-6:
            raise refuse("cross their shared line at different points")
        solved[t] = (pa, pb)
        return solved[t]

    def fit(ts, side):
        arr = TColgp_HArray1OfPnt2d(1, len(ts))
        par = TColStd_HArray1OfReal(1, len(ts))
        for i, t in enumerate(ts, 1):
            arr.SetValue(i, crossing(t)[side])
            par.SetValue(i, t)
        # Interpolated, not approximated, and on the EDGE's own parameters: both
        # pcurves have to answer to the same t as the 3D curve, or nothing that
        # reads this edge afterwards can line the three up.
        it = Geom2dAPI_Interpolate(arr, par, False, TOL)
        it.Perform()
        if not it.IsDone():
            raise ValueError("could not fit a blend seam pcurve")
        return it.Curve()

    # The crossings are exact but a cubic through them is not, so refine until
    # the fitted curve reproduces crossings it was NOT given. Split only the
    # intervals that are actually out: at a profile near the sharp end the seam
    # spends most of its length nearly straight and turns hard in one small
    # stretch, and refining everywhere to satisfy that stretch costs hundreds of
    # samples on parts of the curve that were right to begin with. Nothing
    # measured is wasted either way, since `crossing` remembers.
    def miss(t):
        uv = pca.Value(t)
        return ba.Value(uv.X(), uv.Y()).Distance(
            ba.Value(crossing(t)[0].X(), crossing(t)[0].Y()))

    ts = [lo + (hi - lo) * i / samples for i in range(samples + 1)]
    while True:
        pca, pcb = fit(ts, 0), fit(ts, 1)
        mids = [(a + b) / 2 for a, b in zip(ts, ts[1:])]
        err = max(miss(t) for t in mids)
        if err <= scale * SEAM_FIT or len(ts) >= SEAM_SAMPLES_MAX:
            break
        ts = sorted(ts + [t for t in mids if miss(t) > scale * SEAM_FIT])
    if err > scale * SEAM_LIMIT:
        raise ConicNotApplicable(
            "the seam where these two blends meet does not follow the conic "
            f"family at this profile (it misses by {err:.4g}) — use profile 0 here")

    pa0, pa1 = crossing(lo)[0], crossing(hi)[0]
    v1, v2 = _settle_ends(edge, ba.Value(pa0.X(), pa0.Y()), ba.Value(pa1.X(), pa1.Y()),
                          scale, lambda gap: say(f"end {gap:.4g} apart"))

    mk = BRepBuilderAPI_MakeEdge(pca, ba, v1, v2, lo, hi)
    if not mk.IsDone():
        raise ValueError(f"could not rebuild a blend seam edge ({mk.Error()})")
    ne = mk.Edge()
    BRepLib.BuildCurve3d_s(ne, TOL)
    # The second face's pcurve, against its SURFACE rather than its face: the
    # reskinned faces are not in the shape yet when this runs.
    BRep_Builder().UpdateEdge(ne, pcb, bb, TopLoc_Location(), TOL)
    ne.Orientation(edge.Orientation())
    return ne


def _rebuild_edge(edge, face, newsurf):
    """The edge's 3D curve recovered from its pcurve on the new surface."""
    ad = BRepAdaptor_Curve2d(edge, face)
    pc = BRep_Tool.CurveOnSurface_s(edge, face, 0.0, 0.0)
    p1, p2 = ad.FirstParameter(), ad.LastParameter()
    head, tail = pc.Value(p1), pc.Value(p2)
    start = newsurf.Value(head.X(), head.Y())
    end = newsurf.Value(tail.X(), tail.Y())
    v1, v2 = _settle_ends(
        edge, start, end, _extent(newsurf),
        lambda gap: "this blend is cut across its section by a neighbouring "
                    "face, so its trim would have to be recomputed rather than "
                    f"reweighted (a corner moves {gap:.4g}) — use profile 0 here")

    mk = BRepBuilderAPI_MakeEdge(pc, newsurf, v1, v2, p1, p2)
    if not mk.IsDone():
        raise ValueError(f"could not rebuild a blend section edge ({mk.Error()})")
    ne = mk.Edge()
    BRepLib.BuildCurve3d_s(ne, TOL)
    ne.Orientation(edge.Orientation())
    return ne


def conic_blend(sharp, edges, radius, profile):
    """Blend `edges` of the solid `sharp` at `radius` with a conic profile.

    `sharp` and `edges` are raw TopoDS; the result is a raw TopoDS_Shape. A
    profile of 0 returns OCCT's own fillet untouched.
    """
    k = weight_scale(profile)

    mk = BRepFilletAPI_MakeFillet(sharp)
    for e in edges:
        mk.Add(radius, e)
    mk.Build()
    if not mk.IsDone():
        raise ValueError("fillet failed")
    filleted = mk.Shape()
    if abs(k - 1.0) < PROFILE_EPS:
        return filleted

    # Pass 1: swap each blend face's surface, keeping wires, edges and pcurves.
    reshape = BRepTools_ReShape()
    stale = []
    for face in _blend_faces(sharp, mk, filleted):
        bs = _nurbs_of(face)
        dirs = _arc_dirs(bs)
        if not dirs:
            # A blend face whose section is not a single quadratic arc — an arc
            # wider than a half turn, or a BSpline blend between curved supports.
            # Reweighting has no meaning there, and silently leaving it circular
            # would ship a feature that is conic on some edges and not others.
            raise ConicNotApplicable(
                "this edge's blend has no conic profile — use profile 0 for a "
                "plain fillet here")
        for along_u in dirs:
            _reweight(bs, along_u, k)
        for e in _moved_edges(face, BRep_Tool.Surface_s(face), bs):
            for grp in stale:
                if grp[0].IsSame(e):
                    grp[1].append((face, bs, dirs))
                    break
            else:
                stale.append((e, [(face, bs, dirs)]))
        reshape.Replace(face, _reskin(face, bs))
    out = reshape.Apply(filleted)

    # Pass 2: rebuild the boundaries that moved, which are the only curves that
    # did. With one blend face SameParameter could absorb the change against the
    # neighbouring plane; where two blend faces meet, both sides moved and there
    # is nothing left to reconcile against, so the tolerance blows out and the
    # shell falls apart.
    #
    # An edge that is a whole SECTION on both sides needs only its 3D curve
    # recovered: it moved inside its own plane, so both faces' pcurves still
    # describe it and rebuilding from either gives the same curve. A MITRE seam
    # does not have that property and has to be re-solved for both faces at once
    # — see _reseam, and _sides_agree for how the two are told apart, which is by
    # measurement rather than by trusting the property to hold.
    reshape2 = BRepTools_ReShape()
    for edge, sides in stale:
        face, bs, _ = sides[0]
        reshape2.Replace(edge, _rebuild_edge(edge, face, bs)
                         if len(sides) < 2 or _sides_agree(edge, [s[:2] for s in sides])
                         else _reseam(edge, sides))
    out = reshape2.Apply(out)

    fix = ShapeFix_Shape(out)
    fix.SetPrecision(TOL)
    fix.Perform()
    out = fix.Shape()
    BRepLib.SameParameter_s(out, TOL, True)

    if not BRepCheck_Analyzer(out).IsValid():
        raise ValueError(
            f"the conic profile produced an invalid solid at profile {profile:g}")
    return out
