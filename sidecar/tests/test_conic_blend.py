"""Conic blend profile — the geometry, not the plumbing.

Run:  uv run python test_conic_blend.py

The three anchors that make the profile knob trustworthy:

  profile  0  is EXACTLY OCCT's fillet (bit-identical shape, not merely close)
  profile -1 approaches the chamfer chord
  profile +1 approaches the sharp corner, removing nothing

plus monotonicity in between, over the four topologies that behave differently:
a lone tube, a tube meeting a spherical corner patch, a fully rounded box, and a
toroidal blend on a curved edge.

Volumes come from the TESSELLATION on purpose. BRepGProp integrates in parameter
space and is badly wrong on these surfaces at large |profile| (see the module
docstring in conic_blend.py) — it is the one measure that would make a correct
blend look broken.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepTools import BRepTools
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_VERTEX
from OCP.TopExp import TopExp
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Pnt
from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

from conic_blend import (
    PROFILE_LIMIT, _sub, clamp_profile, conic_blend, weight_scale,
)


def mesh_volume(shape, defl=0.005):
    """Volume of the tessellated solid, by signed tetrahedra."""
    BRepMesh_IncrementalMesh(shape, defl, False, 0.1, True)
    total = 0.0
    for f in _sub(shape, TopAbs_FACE):
        face = TopoDS.Face_s(f)
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue
        trsf = loc.Transformation()
        flip = face.Orientation() == TopAbs_REVERSED
        for i in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(i).Get()
            if flip:
                a, c = c, a
            pa, pb, pc = (tri.Node(n).Transformed(trsf) for n in (a, b, c))
            total += (
                pa.X() * (pb.Y() * pc.Z() - pc.Y() * pb.Z())
                - pa.Y() * (pb.X() * pc.Z() - pc.X() * pb.Z())
                + pa.Z() * (pb.X() * pc.Y() - pc.X() * pb.Y())
            ) / 6.0
    return abs(total)


def box():
    return BRepPrimAPI_MakeBox(40.0, 30.0, 20.0).Shape()


def box_edges(b):
    return [TopoDS.Edge_s(e) for e in _sub(b, TopAbs_EDGE)]


def corner_edges(b):
    """The three edges meeting at one vertex — forces a spherical corner patch."""
    vmap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(b, TopAbs_VERTEX, TopAbs_EDGE, vmap)
    for i in range(1, vmap.Extent() + 1):
        seen = []
        for e in vmap.FindFromIndex(i):
            # the ancestor map lists an edge once per incident face
            if not any(e.IsSame(x) for x in seen):
                seen.append(e)
        if len(seen) == 3:
            return [TopoDS.Edge_s(e) for e in seen]
    raise AssertionError("no three-edge vertex on a box")


def _edge_between(shape, p, q):
    """The edge running between two corner points, named rather than indexed."""
    for e in _sub(shape, TopAbs_EDGE):
        edge = TopoDS.Edge_s(e)
        ends = [BRep_Tool.Pnt_s(v) for v in (TopExp.FirstVertex_s(edge),
                                             TopExp.LastVertex_s(edge))]
        for a, z in (ends, ends[::-1]):
            if a.Distance(gp_Pnt(*p)) < 1e-9 and z.Distance(gp_Pnt(*q)) < 1e-9:
                return edge
    raise AssertionError(f"no edge from {p} to {q}")


def drifting_corner():
    """A box and three edges whose section endpoints land a hair off their pole.

    The unlovely dimensions are the whole point, so do not tidy them. A section
    of a blend ends on an arc END pole, which no reweight moves — but it gets
    there through a pcurve value and a UV box that were each rounded once, and
    on a box whose sides are round numbers those roundings cancel and the
    endpoint sits exactly on the pole. Off the lattice it misses by about a
    nanometre, the reweight multiplies the miss by k, and the rebuild used to
    reject the edge outright: this blend was denied at -0.95, +0.6 and +0.95
    while +0.25 built fine, which is precisely the "a sensible fillet got
    denied" report. A nanometre is a tolerance, not a shape, and is now absorbed
    as one.

    Two of the three edges share a vertex and the third is parallel to one of
    them, which is what puts a corner patch next to a plain tube; a tidy corner
    triple does not reproduce it. Found by the fuzz at seed 12345, case 11.
    """
    l, w, h = 22.996807984, 31.343798952, 28.198014348
    b = BRepPrimAPI_MakeBox(l, w, h).Shape()
    return b, [_edge_between(b, (0, 0, 0), (l, 0, 0)),
               _edge_between(b, (0, 0, h), (l, 0, h)),
               _edge_between(b, (0, 0, h), (0, w, h))], 5.354428830336606


CUBE = 20.0
CUBE_R = 4.0


def cube_top():
    """A cube and the four edges of its top face — the plainest model there is.

    Extrude a cube, fillet the top face. OCCT does not put a corner patch at
    these corners: it runs each tube the full length and MITRES the four of them
    against each other, so every corner seam is a boundary that is a whole
    section on neither side. That is the one shape of boundary the reweight
    identity does not carry, and it is reachable in two clicks.
    """
    b = BRepPrimAPI_MakeBox(CUBE, CUBE, CUBE).Shape()
    top = []
    for e in _sub(b, TopAbs_EDGE):
        edge = TopoDS.Edge_s(e)
        ends = [BRep_Tool.Pnt_s(v) for v in (TopExp.FirstVertex_s(edge),
                                             TopExp.LastVertex_s(edge))]
        if all(abs(p.Z() - CUBE) < 1e-9 for p in ends):
            top.append(edge)
    assert len(top) == 4, f"expected 4 top edges, found {len(top)}"
    return b, top


def max_edge_tolerance(shape):
    """The widest tolerance sleeve any edge of this shape carries.

    BRepCheck_Analyzer asking "is this valid" is not the same question: it asks
    whether the curves agree WITHIN their stored tolerance, and SameParameter is
    free to widen that tolerance until they do. A shape can pass that check and
    still render as a wobbling edge, because the mesher may wander anywhere
    inside the sleeve. So measure the sleeve.
    """
    return max(BRep_Tool.Tolerance_s(TopoDS.Edge_s(e))
               for e in _sub(shape, TopAbs_EDGE))


def _edge_from_to(shape, p, q, tol=1e-6):
    for e in _sub(shape, TopAbs_EDGE):
        edge = TopoDS.Edge_s(e)
        ends = [BRep_Tool.Pnt_s(v) for v in (TopExp.FirstVertex_s(edge),
                                             TopExp.LastVertex_s(edge))]
        for a, z in (ends, ends[::-1]):
            if a.Distance(gp_Pnt(*p)) < tol and z.Distance(gp_Pnt(*q)) < tol:
                return edge
    return None


CASES = []


def _cases():
    if CASES:
        return CASES
    b = box()
    cyl = BRepPrimAPI_MakeCylinder(12.0, 25.0).Shape()
    cube, top = cube_top()
    CASES.extend([
        ("one edge (tube)", b, [box_edges(b)[0]], 4.0),
        ("corner (tubes + sphere patch)", b, corner_edges(b), 4.0),
        ("all 12 edges", b, box_edges(b), 3.0),
        ("cylinder rim (torus blend)", cyl, [TopoDS.Edge_s(
            _sub(cyl, TopAbs_EDGE)[0])], 3.0),
        ("top face of a cube (mitred corners)", cube, top, CUBE_R),
    ])
    drift_solid, drift_edges, drift_r = drifting_corner()
    CASES.append(("corner off the lattice", drift_solid, drift_edges, drift_r))
    return CASES


def test_weight_scale_anchors():
    assert weight_scale(0.0) == 1.0
    assert weight_scale(0.5) == 2.0
    assert weight_scale(-0.5) == 0.5
    assert math.isclose(weight_scale(0.9), 10.0)
    # The interval is OPEN: the ends are degenerate (weight 0 is not a legal
    # NURBS weight, and an infinite one is no blend at all), so they are clamped
    # to something buildable that still reads as the chamfer / the sharp corner.
    assert 0.0 < weight_scale(-1.0) <= 1.0 - PROFILE_LIMIT
    assert weight_scale(1.0) >= 1.0 / (1.0 - PROFILE_LIMIT)
    for beyond in (-1.5, -1.0, -0.9995, -PROFILE_LIMIT - 1e-9):
        assert weight_scale(beyond) == weight_scale(-PROFILE_LIMIT)
    for beyond in (9.0, 1.0, 0.9995, PROFILE_LIMIT + 1e-9):
        assert weight_scale(beyond) == weight_scale(PROFILE_LIMIT)
    assert clamp_profile("nonsense") == 0.0
    assert clamp_profile(float("nan")) == 0.0
    print("weight_scale anchors OK")


def test_zero_profile_is_the_plain_fillet():
    """Not "close to" — the same shape. Profile 0 must cost nothing and risk
    nothing, because it is what every existing fillet in every saved document
    rebuilds as."""
    for tag, solid, edges, r in _cases():
        mk = BRepFilletAPI_MakeFillet(solid)
        for e in edges:
            mk.Add(r, e)
        mk.Build()
        want, got = mk.Shape(), conic_blend(solid, edges, r, 0.0)
        # Not IsSame: two filleter runs build distinct TShapes for identical
        # geometry. Topology counts plus an exact volume match is the strongest
        # statement available, and it is enough to catch any reweight leaking
        # into the k == 1 path.
        for kind, name in ((TopAbs_FACE, "faces"), (TopAbs_EDGE, "edges")):
            assert len(_sub(got, kind)) == len(_sub(want, kind)), \
                f"{tag}: profile 0 changed the {name} count"
        assert abs(mesh_volume(got) - mesh_volume(want)) < 1e-9, \
            f"{tag}: profile 0 changed the volume"
    print("profile 0 reproduces OCCT's fillet exactly OK")


def test_valid_and_monotone_across_the_range():
    """More profile means less material removed, always, and every step is a
    valid solid. Monotonicity is the property the drag gesture depends on: a
    slider that reverses direction anywhere is unusable."""
    sweep = (-0.95, -0.7, -0.3, 0.0, 0.3, 0.7, 0.95)
    for tag, solid, edges, r in _cases():
        base = mesh_volume(solid)
        prev = None
        for p in sweep:
            out = conic_blend(solid, edges, r, p)
            assert BRepCheck_Analyzer(out).IsValid(), f"{tag}: invalid at {p}"
            removed = base - mesh_volume(out)
            assert removed > -1e-6, f"{tag}: negative removal at {p}"
            if prev is not None:
                assert removed < prev + 1e-3, (
                    f"{tag}: not monotone at {p} ({removed:.4f} >= {prev:.4f})")
            prev = removed
        print(f"  {tag}: valid + monotone over {sweep}")
    print("validity and monotonicity OK")


def test_extremes_reach_chamfer_and_sharp():
    """The ends of the slider have to actually mean something: near +1 the blend
    all but vanishes, near -1 it removes what a chamfer of the same setback
    would. Checked on the lone tube, where both are computable by hand."""
    b = box()
    e = box_edges(b)[0]
    r = 4.0
    base = mesh_volume(b)

    sharpish = base - mesh_volume(conic_blend(b, [e], r, 0.95))
    assert sharpish < 3.0, f"profile +0.95 still removes {sharpish:.3f}mm3"

    # a 4mm chamfer on a 20mm edge removes the right triangle: 0.5*4*4*20 = 160
    chamferish = base - mesh_volume(conic_blend(b, [e], r, -0.95))
    assert 140.0 < chamferish < 160.0, (
        f"profile -0.95 removed {chamferish:.3f}mm3, expected just under 160")

    circular = base - mesh_volume(conic_blend(b, [e], r, 0.0))
    expected = (16.0 - math.pi * 16.0 / 4.0) * 20.0   # (r^2 - quarter disc) * len
    assert abs(circular - expected) < 0.5, (
        f"profile 0 removed {circular:.3f}mm3, expected {expected:.3f}")
    print(f"extremes OK (sharp {sharpish:.3f}, chamfer {chamferish:.3f}, "
          f"circular {circular:.3f} vs {expected:.3f})")


def test_rebuilds_through_a_real_document():
    """The whole path: a document with `profile` on a fillet feature reaches the
    conic builder, produces a solid, and reports no errors — and the same
    document without the field still takes the plain build123d route."""
    from builder import rebuild

    def doc(profile):
        f = {"id": "f3", "type": "fillet",
             "edges": {"by": "nearest", "point": [20.0, 0.0, 10.0]}, "radius": 4}
        if profile is not None:
            f["profile"] = profile
        return {"parameters": {},
                "features": [{"id": "f1", "type": "box", "length": 40,
                              "width": 30, "height": 20}, f]}

    vols = {}
    for p in (None, 0, -0.6, 0.6):
        part, errors, _bodies = rebuild(doc(p))
        assert not errors, f"profile {p}: {errors}"
        assert part is not None, f"profile {p}: no solid"
        vols[p] = mesh_volume(part.wrapped)

    # absent and 0 are the same feature by definition
    assert abs(vols[None] - vols[0]) < 1e-9, "absent profile differed from 0"
    # and the profile actually reached the kernel, in the right direction
    assert vols[-0.6] < vols[0] < vols[0.6], (
        f"profile had no effect through rebuild: {vols}")
    print(f"document rebuild OK (removed: -0.6 -> {24000 - vols[-0.6]:.2f}, "
          f"0 -> {24000 - vols[0]:.2f}, +0.6 -> {24000 - vols[0.6]:.2f})")


def test_a_mitred_corner_keeps_its_seam():
    """Fillet the top face of a cube and slide the profile: the corner seams must
    stay put, and stay crisp.

    The reported defect, and the reason it needs its own test rather than a line
    in the sweep above. Every profile here produced a solid that BRepCheck called
    valid, so nothing in this suite could see it. What had actually happened:

    Each corner seam is shared by two blend faces, and pass 2 rebuilt it from one
    of them on the assumption that the two agree. They do agree for a seam that is
    a whole SECTION — it moves inside its own plane, so both pcurves still
    describe it — but a mitre seam runs ACROSS the sections and has no such
    property. At profile 0.9 the two faces' ideas of the seam diverged by 2.7mm on
    a 4mm blend, whereupon SameParameter widened the edge's tolerance to 0.38mm so
    that both fitted inside it. Valid, and visibly bent, because a tolerance that
    wide lets the mesher put the edge anywhere in a 0.38mm sleeve.

    Both ENDS of a mitre seam sit on poles no reweight moves, so they agree
    exactly at both ends and diverge only in between: the endpoint check that
    guards the other rebuild path cannot see this by construction.

    Two assertions, because they fail independently. The tolerance is what the
    mesher acts on. The symmetry is what "the edge is distorted" means: on a cube,
    the seam at the corner over the origin lies in the plane x = y, at every
    profile, because the two blends meeting there are mirror images.
    """
    cube, top = cube_top()
    seam_from = (0.0, 0.0, CUBE - CUBE_R)
    seam_to = (CUBE_R, CUBE_R, CUBE)

    for p in (-0.9, -0.6, -0.3, 0.0, 0.3, 0.6, 0.8, 0.9, 0.937, 0.95, 0.99):
        out = conic_blend(cube, top, CUBE_R, p)
        assert BRepCheck_Analyzer(out).IsValid(), f"profile {p}: invalid"

        sleeve = max_edge_tolerance(out)
        assert sleeve < CUBE_R * 1e-4, (
            f"profile {p}: an edge needs a {sleeve:.4g}mm tolerance on a "
            f"{CUBE_R}mm blend, which is a licence for the mesher to wander")

        seam = _edge_from_to(out, seam_from, seam_to, tol=CUBE_R * 1e-3)
        assert seam is not None, f"profile {p}: the corner seam is gone"
        ad = BRepAdaptor_Curve(seam)
        a, z = ad.FirstParameter(), ad.LastParameter()
        off = max(abs(ad.Value(a + (z - a) * i / 24).X()
                      - ad.Value(a + (z - a) * i / 24).Y()) for i in range(25))
        assert off < CUBE_R * 1e-4, (
            f"profile {p}: the corner seam leaves its mirror plane by {off:.4g}mm, "
            f"so the two blends meeting there no longer agree where the edge is")
    print("mitred corner seams stay on the mirror plane and stay crisp OK")


#: What the viewport actually asks BRepMesh for — server._effective_tolerance's
#: relative deflection. The tearing below is a property of the mesh the USER
#: sees, so it has to be measured at the deflection the user gets, not at a
#: convenient one.
VIEWPORT_DEFLECTION = 0.002


def viewport_mesh(shape):
    """(triangle count, smallest triangle area) at the viewport's deflection."""
    from OCP.BRepTools import BRepTools
    BRepTools.Clean_s(shape)   # a stored finer mesh would be served instead
    BRepMesh_IncrementalMesh(shape, VIEWPORT_DEFLECTION, True, 0.5, True)
    n = 0
    worst = float("inf")
    for f in _sub(shape, TopAbs_FACE):
        face = TopoDS.Face_s(f)
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue
        trsf = loc.Transformation()
        n += tri.NbTriangles()
        for i in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(i).Get()
            pa, pb, pc = (tri.Node(k).Transformed(trsf) for k in (a, b, c))
            ux, uy, uz = pb.X() - pa.X(), pb.Y() - pa.Y(), pb.Z() - pa.Z()
            vx, vy, vz = pc.X() - pa.X(), pc.Y() - pa.Y(), pc.Z() - pa.Z()
            nx = uy * vz - uz * vy
            ny = uz * vx - ux * vz
            nz = ux * vy - uy * vx
            worst = min(worst, math.sqrt(nx * nx + ny * ny + nz * nz) / 2.0)
    return n, worst


def test_the_slider_stops_where_the_mesh_still_holds():
    """Every profile the slider can reach must still tessellate.

    The reported defect: fillet the top face of an extruded rectangle, slide the
    profile to its negative end, and the corners break and overlap. The kernel is
    not at fault — that solid is valid, its corner seams sit on their mirror plane
    to 8e-7mm and its widest tolerance sleeve is 1.9e-6mm, and the same solid
    meshed twenty times finer has no defect at all. What breaks is the
    tessellation. As the middle weight runs to zero the section's parameterisation
    piles up against its end poles, and past a point BRepMesh stops resolving it.

    It does not fail quietly by getting slightly coarser. It falls off a cliff,
    and the cliff is what this measures. Meshed on a 5mm blend at the viewport's
    own deflection:

        profile   -0.9   -0.95  -0.98  -0.99  -0.995 | -0.997  -0.998  -0.999
        triangles 3462   3728   3382   3520   3380   |  2572    2572    2572
        smallest  3.1e-4 2.3e-4 6.0e-5 2.8e-5 1.1e-5 |  5.2e-4  5.1e-4  5.1e-4

    The TRIANGLE COUNT is what is asserted. It is the signal that means "stopped
    subdividing" rather than "subdivided differently", and it is the one that
    survives changing the model: on the 20mm cube below the smallest triangle
    does NOT jump back up past the cliff even though the count still collapses,
    so an assertion on the smallest triangle would have no control and would be
    saying nothing.

    The limit sits at 0.99, two measured steps to the left of that line. Both
    ends are checked, each against a milder profile of its own sign, and the last
    case forces the limit back to where it was so the measurement has a control
    that must fail.
    """
    import conic_blend as cb

    cube, top = cube_top()
    # Each end is judged against a milder profile of ITS OWN sign. The two ends
    # do not produce comparable blends — at +0.9 the surface has nearly vanished
    # into the corner, so its triangles are legitimately larger than any on the
    # chamfer side, and comparing across the middle would only measure that.
    mild = {s: viewport_mesh(conic_blend(cube, top, CUBE_R, 0.9 * s))
            for s in (-1, 1)}

    for s in (-1, 1):
        p = PROFILE_LIMIT * s
        mild_n, _ = mild[s]
        n, _ = viewport_mesh(conic_blend(cube, top, CUBE_R, p))
        assert n >= mild_n * 0.9, (
            f"profile {p}: {n} triangles against {mild_n} at {0.9 * s} — the "
            f"mesher stopped subdividing, which is what the torn corner is")

    # The control. Reach past the limit the way the old code did and the same
    # two measurements have to notice. Without this, the assertions above would
    # pass just as happily on a limit of 0.5 and say nothing about the defect.
    real = cb.PROFILE_LIMIT
    cb.PROFILE_LIMIT = 0.999
    try:
        past_n, _ = viewport_mesh(conic_blend(cube, top, CUBE_R, -0.999))
    finally:
        cb.PROFILE_LIMIT = real
    mild_n, _ = mild[-1]
    assert past_n < mild_n * 0.9, (
        f"the old limit no longer breaks the mesh ({past_n} triangles against "
        f"{mild_n} at -0.9) — either the mesher improved or this measurement has "
        f"stopped describing the defect, and the limit should be re-derived "
        f"either way")
    at_n, _ = viewport_mesh(conic_blend(cube, top, CUBE_R, -PROFILE_LIMIT))
    print(f"the profile limit stops before the mesh cliff OK "
          f"({at_n} triangles at the limit, {past_n} past it, "
          f"{mild_n} at -0.9)")


def test_a_refused_profile_does_not_read_as_a_failed_fillet():
    """A blend outside the conic family must reach the user saying so, not
    wearing the generic "Fillet failed on Body1" jacket _blend_edges puts on
    real breakage.

    The distinction is the whole point of the exception: the radius is fine and
    the plain fillet at it builds, so a message about the fillet failing sends
    someone hunting for a size problem that does not exist. _blend_edges catches
    Exception broadly to fall back to per-edge blending, which is right for
    kernel failures and wrong for this one — the retry can only arrive at the
    same refusal, and then hides why."""
    import builder
    from builder import rebuild
    from conic_blend import ConicNotApplicable

    doc = {"parameters": {},
           "features": [
               {"id": "f1", "type": "box", "length": 40, "width": 30, "height": 20},
               {"id": "f2", "type": "fillet", "radius": 4, "profile": 0.6,
                "edges": {"by": "nearest", "point": [20.0, 0.0, 10.0]}},
           ]}

    # Driven through the real rebuild rather than by handing _blend_edges a stub
    # context: what is being checked is the sentence that reaches the toast, and
    # that is decided by the whole chain of handlers between here and there. The
    # geometry that genuinely provokes this is a boolean about one in thirty, so
    # the refusal is injected instead — the message's journey is the subject, not
    # the surface that produces it.
    real = builder._conic_fillet
    builder._conic_fillet = lambda *_a, **_k: (_ for _ in ()).throw(
        ConicNotApplicable("this blend is cut across its section — use profile 0 here"))
    try:
        _part, errors, _bodies = rebuild(doc)
    finally:
        builder._conic_fillet = real

    assert errors, "a refused profile reported no error at all"
    said = " ".join(str(e) for e in errors)
    assert "cut across its section" in said, f"refusal lost its own words: {said}"
    assert "Fillet failed" not in said, (
        f"refusal was dressed as a failed fillet, which sends the user hunting "
        f"for a radius problem that is not there: {said}")
    print("conic refusal keeps its own message OK")


if __name__ == "__main__":
    test_weight_scale_anchors()
    test_zero_profile_is_the_plain_fillet()
    test_extremes_reach_chamfer_and_sharp()
    test_valid_and_monotone_across_the_range()
    test_a_mitred_corner_keeps_its_seam()
    test_the_slider_stops_where_the_mesh_still_holds()
    test_rebuilds_through_a_real_document()
    test_a_refused_profile_does_not_read_as_a_failed_fillet()
    print("\nall conic blend tests passed")
