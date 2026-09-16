"""Fillets and chamfers the kernel refuses, built from their cross-section.

The lofted-section blend (section_blend.py) has to agree with OCCT wherever OCCT
builds, or switching to it would change parts that already worked. So the first
checks compare removed volume against the kernel's own blend on shapes where
both build. Then the cases that motivated it:

  * a leg joined onto a round wall with its cylinder seam 0.18mm from the
    junction, where OCCT fails at every size (the user's part);
  * radii far past the neighbouring faces, which now carve through them;
  * G2 sections, per-edge chord sizes, a two-distance chamfer, and stopping at
    the picked edge instead of running on along its tangent neighbours.

Run: uv run python tests/test_section_blend.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import time
import traceback

from build123d import Align, Box, Cylinder, GeomType, Vector

from builder import rebuild
from section_blend import SectionBlendError, section_blend
from shape_util import _wrap_topods

PASS = "  ok"


def _blend(shape, edges, **kw):
    return _wrap_topods(section_blend(shape.wrapped, [e.wrapped for e in edges], **kw))


def _box_top_edge():
    box = Box(20, 20, 20)
    return box, [e for e in box.edges() if e.center().Z > 9 and e.center().X > 9][0]


def test_matches_the_kernel_where_the_kernel_builds():
    box, top = _box_top_edge()
    assert abs(_blend(box, [top], kind="fillet", size=3).volume - box.fillet(3, [top]).volume) < 0.05
    assert abs(_blend(box, [top], kind="chamfer", size=3).volume - box.chamfer(3, None, [top]).volume) < 0.05
    ell = (Box(20, 20, 5, align=(Align.MIN,) * 3) + Box(5, 20, 20, align=(Align.MIN,) * 3))
    inner = [e for e in ell.edges() if abs(e.center().X - 5) < 1e-6 and abs(e.center().Z - 5) < 1e-6][0]
    assert abs(_blend(ell, [inner], kind="fillet", size=3).volume - ell.fillet(3, [inner]).volume) < 0.05
    cyl = Cylinder(10, 20)
    rim = [e for e in cyl.edges() if e.center().Z > 9][0]
    assert abs(_blend(cyl, [rim], kind="fillet", size=2).volume - cyl.fillet(2, [rim]).volume) < 0.5
    print(PASS, "convex, concave and circular blends remove what the kernel's own do")


def test_g2_and_two_distance_sections():
    box, top = _box_top_edge()
    g1 = _blend(box, [top], kind="fillet", size=3).volume
    g2 = _blend(box, [top], kind="fillet", size=3, continuity="G2").volume
    assert g2 != g1 and 7900 < g2 < 8000, (g1, g2)
    two = _blend(box, [top], kind="chamfer", size=3, size2=6).volume
    assert abs((8000 - two) - 0.5 * 3 * 6 * 20) < 0.05, two
    print(PASS, "a G2 section differs from the arc, a 3/6 chamfer removes a 3x6 triangle")


def test_a_radius_past_the_faces_carves_through():
    box, top = _box_top_edge()
    out = _blend(box, [top], kind="fillet", size=15)
    assert out.is_valid and len(out.solids()) == 1 and out.volume < 8000
    try:
        _blend(box, [top], kind="fillet", size=1000)
        raise AssertionError("a blend that removes the whole body must refuse")
    except SectionBlendError as err:
        assert "whole body" in str(err), err
    ring = Cylinder(50, 30) - Cylinder(40, 30).translate((0, 0, 10))
    floor = min((e for e in ring.edges() if e.geom_type == GeomType.CIRCLE and abs(e.radius - 40) < 1e-6),
                key=lambda e: e.center().Z)
    # As wide as the pocket and twice as tall as its wall, the floor rounds into a
    # bowl that runs from the rim down to the centre. It used to be a ball of 40
    # cut flat at the rim, a lid across the pocket; on six short legs the same
    # flat cut filled the whole underside.
    pocket = math.pi * 40 ** 2 * 20
    top = ring.volume + pocket
    for size in (40, 45):
        started = time.time()
        bowl = _blend(ring, [floor], kind="fillet", size=size)
        assert bowl.is_valid and len(bowl.solids()) == 1, f"a {size}mm floor round must build"
        assert ring.volume + 0.2 * pocket < bowl.volume < top - 0.1 * pocket, (size, bowl.volume - ring.volume, pocket)
        rim = ring.bounding_box().max.Z
        lids = [f for f in bowl.faces() if f.geom_type == GeomType.PLANE and abs(f.center().Z - rim) < 1e-6]
        assert lids, "the ring's top face is gone"
        assert sum(f.area for f in lids) < math.pi * (50 ** 2 - 40 ** 2) + 1.0, "the bowl is cut flat across the pocket"
        assert time.time() - started < 5, "the bowl is one revolve and one boolean"
    print(PASS, "15mm on a 20mm cube builds, 1000mm refuses, a floor round past the wall's height is a bowl with no lid")


def test_a_rim_past_its_axis_domes_instead_of_refusing():
    from build123d import Cone

    # The user's boss: a 15 degree tapered cylinder, its top rim rounded far past
    # the top face's radius. G2 sets back 1.55 times further, so it met the axis
    # at two thirds of G1's size and used to refuse from there on.
    boss = Cone(25.37, 17.75, 28.4)
    rim = max((e for e in boss.edges() if e.geom_type == GeomType.CIRCLE), key=lambda e: e.center().Z)
    last = boss.volume
    for size in (12, 17, 25, 40):
        for continuity in ("G1", "G2"):
            out = _blend(boss, [rim], kind="fillet", size=size, continuity=continuity)
            assert out.is_valid and len(out.solids()) == 1 and out.volume < boss.volume, (size, continuity)
        g1 = _blend(boss, [rim], kind="fillet", size=size).volume
        assert g1 < last, f"a larger dome must remove more ({size}mm: {g1} after {last})"
        last = g1
    print(PASS, "a tapered boss rim domes at every size, G1 and G2, growing monotonically")


def test_legs_set_into_a_round_wall_all_round_where_they_meet_its_underside():
    """The user's bowl: six legs centred on the wall's radius, rounded where they
    meet the underside. Three kernel faults met here, each silent: trimming a
    leg's blend against the wall it grazes came back empty, fusing a blend onto
    a body that already had its neighbour's kept a valid solid without it, and
    tidying the faces of a leg's two seam halves corrupted the solid in place."""
    from build123d import Solid
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_IN
    from OCP.gp import gp_Pnt

    from geom_select import _edge_mid

    legs = [(50 * math.cos(math.radians(-90 + 54 * k)), 50 * math.sin(math.radians(-90 + 54 * k))) for k in range(6)]
    feats = [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "c", "x": 0, "y": 0, "radius": 50}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": {"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": [{"type": "circle", "id": f"l{k}", "x": x, "y": y, "radius": 4.25} for k, (x, y) in enumerate(legs)]},
        {"id": "e2", "type": "extrude", "sketch": "s2", "distance": -32, "operation": "join"},
    ]
    _p, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    base = bodies[0]["shape"]
    arcs = [{"by": "nearest", "kind": "edge", "point": list(_edge_mid(e).to_tuple())} for e in base.edges()
            if e.geom_type == GeomType.CIRCLE and abs(e.radius - 4.25) < 1e-6
            and abs(_edge_mid(e).Z) < 1e-6 and math.hypot(_edge_mid(e).X, _edge_mid(e).Y) < 50]
    for continuity in ("G1", "G2"):
        added = []
        for r in (4.0, 8.0):
            _p, errors, bodies = rebuild({"parameters": {}, "features": feats + [
                {"id": "f", "type": "fillet", "radius": r, "continuity": continuity, "tangentEdges": False, "edges": arcs}]})
            assert not errors, (continuity, r, errors)
            shape = bodies[0]["shape"]
            assert shape.is_valid and len(shape.solids()) == 1, (continuity, r)
            added.append(shape.volume - base.volume)
            cls = BRepClass3d_SolidClassifier(shape.wrapped)
            for x, y in legs:
                d = math.hypot(x, y)
                inner = 45.75 - 0.2 * r
                cls.Perform(gp_Pnt(x / d * inner, y / d * inner, -0.2 * r), 1e-7)
                assert cls.State() == TopAbs_IN, f"the leg at ({x:.1f}, {y:.1f}) lost its {continuity} {r}mm blend"
        assert 0 < added[0] < added[1], (continuity, added)
    print(PASS, "six legs set into a round wall round at their underside, every one, G1 and G2")


def test_the_section_carries_the_profile():
    box, top = _box_top_edge()
    plain = _blend(box, [top], kind="fillet", size=5).volume
    # CONTROL: profile 0 is the circle exactly, the conic weight is sin(45deg).
    assert abs(_blend(box, [top], kind="fillet", size=5, profile=0.0).volume - plain) < 1e-6
    fuller = _blend(box, [top], kind="fillet", size=5, profile=0.6).volume
    flatter = _blend(box, [top], kind="fillet", size=5, profile=-0.6).volume
    assert flatter < plain < fuller, (flatter, plain, fuller)
    from conic_blend import conic_blend
    # The kernel's reweighted fillet is the same conic. Both measured by their
    # mesh, the integrator is unreliable on those weights.
    from test_conic_blend import mesh_volume
    ours = mesh_volume(section_blend(box.wrapped, [top.wrapped], "fillet", 5, profile=0.6))
    kernel = mesh_volume(conic_blend(box.wrapped, [top.wrapped], 5, 0.6))
    assert abs(ours - kernel) < 0.5, (ours, kernel)
    for g2 in (-0.6, 0.6):
        out = _blend(box, [top], kind="fillet", size=5, continuity="G2", profile=g2)
        assert out.is_valid
    print(PASS, "a section blend at a profile matches the kernel's reweighted fillet")


LEG = [
    {"id": "s1", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "a", "x": 0, "y": 0, "radius": 50}]},
    {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
    {"id": "s2", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "b", "x": 0, "y": -50, "radius": 4.245828802487684}]},
    {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 30, "operation": "join"},
]
SEAM_SIDE = [4.242, -49.82, 10.0]


def _fillet(extra=None, point=SEAM_SIDE, radius=2.0):
    f = {"id": "f", "type": "fillet", "radius": radius,
         "edges": {"kind": "edge", "by": "nearest", "point": point}}
    f.update(extra or {})
    _p, errors, bodies = rebuild({"parameters": {}, "features": LEG + [f]})
    return errors, bodies


def test_the_junction_beside_a_seam_now_rounds():
    _p, _e, base = rebuild({"parameters": {}, "features": LEG})
    shape = base[0]["shape"]
    edge = min((e for e in shape.edges() if e.geom_type == GeomType.LINE),
               key=lambda e: (e.center() - Vector(*SEAM_SIDE)).length)
    try:
        shape.fillet(2, [edge])
        print("  note: the kernel built this junction itself, the regression is moot")
    except Exception:
        pass
    errors, bodies = _fillet()
    assert not errors, errors
    assert bodies[0]["shape"].volume > shape.volume, "a concave fillet adds material"
    assert bodies[0]["shape"].is_valid, "the kernel's fillet reports success on an invalid solid here"
    both = LEG + [
        {"id": "f1", "type": "fillet", "radius": 2.0, "edges": {"kind": "edge", "by": "nearest", "point": SEAM_SIDE}},
        {"id": "f2", "type": "fillet", "radius": 2.0, "continuity": "G2",
         "edges": {"kind": "edge", "by": "nearest", "point": [-4.242, -49.82, 10.0]}},
    ]
    _p, errors, bodies = rebuild({"parameters": {}, "features": both})
    assert not errors and bodies[0]["shape"].is_valid, errors
    print(PASS, "the leg junction the kernel refuses at every size rounds, and the next one after it")


def test_feature_options_reach_the_build():
    _p, _e, base = rebuild({"parameters": {}, "features": LEG})
    v0 = base[0]["shape"].volume
    errors, g1 = _fillet()
    errors2, g2 = _fillet({"continuity": "G2"})
    assert not errors and not errors2, (errors, errors2)
    assert abs(g1[0]["shape"].volume - g2[0]["shape"].volume) > 1e-3
    errors3, chord = _fillet({"sizeType": "chord"})
    assert not errors3, errors3
    assert chord[0]["shape"].volume - v0 < g1[0]["shape"].volume - v0, "a 2mm chord is a smaller blend than a 2mm radius"

    def chamfer(extra):
        f = {"id": "c", "type": "chamfer", "distance": 2.0,
             "edges": {"kind": "edge", "by": "nearest", "point": [0, 0, 20]}}
        f.update(extra)
        box = [{"id": "s", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "width": 40, "height": 40, "x": 0, "y": 0}]},
               {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"}]
        f["edges"]["point"] = [0, 20, 20]
        _p, errs, bodies = rebuild({"parameters": {}, "features": box + [f]})
        assert not errs, errs
        return 32000 - bodies[0]["shape"].volume

    assert abs(chamfer({}) - 0.5 * 2 * 2 * 40) < 0.05
    assert abs(chamfer({"chamferType": "twoDistance", "distance2": 5.0}) - 0.5 * 2 * 5 * 40) < 0.05
    print(PASS, "G2, chord size and a two-distance chamfer all change what is built")


def test_tangent_edges_off_stops_at_the_picked_edge():
    rounded = [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "width": 40, "height": 40, "x": 0, "y": 0}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"},
        {"id": "v", "type": "fillet", "radius": 5.0, "edges": [
            {"kind": "edge", "by": "nearest", "point": p} for p in ([20, 20, 10], [-20, 20, 10], [20, -20, 10], [-20, -20, 10])]},
    ]
    top = {"kind": "edge", "by": "nearest", "point": [0, 20, 20]}
    _p, e1, chain = rebuild({"parameters": {}, "features": rounded + [{"id": "t", "type": "fillet", "radius": 2.0, "edges": top}]})
    _p, e2, one = rebuild({"parameters": {}, "features": rounded + [{"id": "t", "type": "fillet", "radius": 2.0, "edges": top, "tangentEdges": False}]})
    assert not e1 and not e2, (e1, e2)
    assert one[0]["shape"].volume > chain[0]["shape"].volume + 1, (one[0]["shape"].volume, chain[0]["shape"].volume)
    print(PASS, "with tangent edges off only the picked edge rounds, not the whole rim")


def test_a_blend_stops_at_the_face_its_edge_ends_on():
    """A leg under a disc: the arc where it meets the floor ends at the disc's
    rim. The fallback blend must stop at that rim like the kernel's does,
    not hang out past it beside the leg."""
    r = 4.245828802487684
    feats = [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "a", "x": 0, "y": 0, "radius": 50}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": {"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": [{"type": "circle", "id": "b", "x": 0, "y": 50, "radius": r}]},
        {"id": "e2", "type": "extrude", "sketch": "s2", "distance": -32, "operation": "join"},
    ]
    edge = {"kind": "edge", "by": "nearest", "point": [0, 45.7542, 0]}
    vols = []
    for extra in ({}, {"tangentEdges": False}):
        f = {"id": "f", "type": "fillet", "radius": 11.3, "edges": edge, **extra}
        _p, errors, bodies = rebuild({"parameters": {}, "features": feats + [f]})
        assert not errors, errors
        shape = bodies[0]["shape"]
        vols.append(shape.volume)
        for rad in (50.3, 52, 55):
            for deg in range(70, 111, 4):
                a = math.radians(deg)
                for z in (-0.3, -2, -5, -9):
                    p = Vector(rad * math.cos(a), rad * math.sin(a), z)
                    if math.hypot(p.X, p.Y - 50) < r + 0.05:
                        continue
                    assert not shape.is_inside(p), f"{extra}: blend hangs past the rim at {p}"
    assert abs(vols[0] - vols[1]) < 1.0, vols
    # The leg reaches 12mm below the floor; a 14.65mm blend must stop at its end.
    for extra in ({}, {"tangentEdges": False}):
        f = {"id": "f", "type": "fillet", "radius": 14.65, "edges": edge, **extra}
        _p, errors, bodies = rebuild({"parameters": {}, "features": feats + [f]})
        assert not errors, errors
        low = bodies[0]["shape"].bounding_box().min.Z
        assert low > -12.001, f"{extra}: blend hangs below the leg, down to z={low}"
    print(PASS, "the fallback blend stops at the rim its edge ends on and at the end of the leg")


def test_a_chamfer_where_its_edge_ends_on_the_rim():
    """The same leg, chamfered. At the arc's ends neither side of the edge lies
    on a face, and re-probing the chamfer's direction there turned it up into
    the body: small sizes did nothing, 4.24 made a solid of volume 1e101 that
    drew with broken normals, and larger ones were refused."""
    r = 4.245828802487684
    feats = [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "a", "x": 0, "y": 0, "radius": 50}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": {"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
         "entities": [{"type": "circle", "id": "b", "x": 0, "y": 50, "radius": r}]},
        {"id": "e2", "type": "extrude", "sketch": "s2", "distance": -32, "operation": "join"},
    ]
    _p, _e, base = rebuild({"parameters": {}, "features": feats})
    near = Box(40, 40, 12, align=(Align.CENTER, Align.CENTER, Align.MAX)).translate((0, 50, 0))
    before = (base[0]["shape"] & near).volume
    added = []
    for d in (1.0, 2.76, 4.24, 7.32, 11.0):
        # Tangent edges off sends it straight to the section build, which the
        # kernel's own chamfer refused on the user's part.
        f = {"id": "c", "type": "chamfer", "distance": d, "tangentEdges": False,
             "edges": {"kind": "edge", "by": "nearest", "point": [0, 45.7542, 0]}}
        _p, errors, bodies = rebuild({"parameters": {}, "features": feats + [f]})
        assert not errors, (d, errors)
        shape = bodies[0]["shape"]
        assert shape.is_valid and shape.volume < math.pi * 50 ** 2 * 20 + 5000, (d, shape.volume)
        added.append((shape & near).volume - before)
        assert shape.bounding_box().min.Z > -12.001, (d, shape.bounding_box().min.Z)
    assert all(a > 0 for a in added) and added == sorted(added), added
    half_ring = 0.5 * 1.0 * math.pi * (r + 1 / 3)
    assert abs(added[0] - half_ring) < 0.35 * half_ring, (added[0], half_ring)
    print(PASS, "a chamfer on the leg's rim-ending arc grows with its size, up to past the leg's end")


def _cube(size=20):
    return [{"id": "s", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "width": size, "height": size, "x": 0, "y": 0}]},
            {"id": "e", "type": "extrude", "sketch": "s", "distance": size, "operation": "new"}]


def _edges_at(*points):
    return [{"kind": "edge", "by": "nearest", "point": list(p)} for p in points]


CUBE_EDGES = _edges_at((0, 10, 20), (0, -10, 20), (10, 0, 20), (-10, 0, 20), (0, 10, 0), (0, -10, 0),
                       (10, 0, 0), (-10, 0, 0), (10, 10, 10), (-10, 10, 10), (10, -10, 10), (-10, -10, 10))


def test_every_edge_rounded_meets_in_a_ball():
    """Past what the kernel builds, each edge's blend used to end square and the
    three at a corner met in the sharp intersection of their cylinders."""
    def rounded_cube(a, r):
        s = a - 2 * r
        return s ** 3 + 6 * s * s * r + 3 * math.pi * r * r * s + 4 / 3 * math.pi * r ** 3

    for r in (9.9, 10.0):
        _p, errors, bodies = rebuild({"parameters": {}, "features": _cube() + [
            {"id": "f", "type": "fillet", "radius": r, "edges": CUBE_EDGES}]})
        assert not errors, errors
        shape = bodies[0]["shape"]
        assert shape.is_valid and abs(shape.volume - rounded_cube(20, r)) < 0.5, (r, shape.volume, rounded_cube(20, r))
    _p, errors, bodies = rebuild({"parameters": {}, "features": _cube() + [
        {"id": "f", "type": "fillet", "radius": 12.0, "edges": CUBE_EDGES}]})
    assert not errors and bodies[0]["shape"].is_valid, errors
    print(PASS, "a 20mm cube rounded on every edge at 9.9 is a rounded cube, at 10 a sphere, at 12 still builds")


def test_a_rim_rounded_by_its_own_radius_is_a_dome():
    cyl = [{"id": "s", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "c", "x": 0, "y": 0, "radius": 10}]},
           {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"}]
    rim = _edges_at((0, 0, 20))
    _p, errors, bodies = rebuild({"parameters": {}, "features": cyl + [{"id": "f", "type": "fillet", "radius": 10.0, "edges": rim}]})
    assert not errors, errors
    assert abs(bodies[0]["shape"].volume - (math.pi * 100 * 10 + 2 / 3 * math.pi * 1000)) < 0.5, bodies[0]["shape"].volume
    _p, errors, bodies = rebuild({"parameters": {}, "features": cyl + [{"id": "f", "type": "chamfer", "distance": 10.0, "edges": rim}]})
    assert not errors, errors
    assert abs(bodies[0]["shape"].volume - (math.pi * 100 * 10 + math.pi * 1000 / 3)) < 0.5, bodies[0]["shape"].volume
    both = _edges_at((0, 0, 20), (0, 0, 0))
    _p, errors, bodies = rebuild({"parameters": {}, "features": cyl + [{"id": "f", "type": "fillet", "radius": 10.0, "edges": both}]})
    assert not errors, errors
    assert abs(bodies[0]["shape"].volume - 4 / 3 * math.pi * 1000) < 0.5, bodies[0]["shape"].volume
    print(PASS, "a radius 10 rim filleted 10 is a dome, chamfered 10 a cone, and both rims make a sphere")


def test_a_corner_on_a_curved_face_and_a_tapered_one_round_like_the_kernel():
    """Where the kernel builds, the fallback's corners should land where its
    rolling ball does, on faces that are not square to each other or not flat."""
    from build123d import Rectangle, extrude

    import section_blend as sb

    d = _wrap_topods((Cylinder(10, 20, align=(Align.CENTER, Align.CENTER, Align.MIN))
                      & Box(30, 30, 20, align=(Align.MIN, Align.CENTER, Align.MIN)).translate((-4, 0, 0))).wrapped)
    tapered = _wrap_topods(extrude(Rectangle(30, 30), 20, taper=25).wrapped)
    for name, shape, r in (("D", d, 2), ("tapered", tapered, 4)):
        edges = shape.edges()
        kernel = shape.fillet(r, edges).volume
        with_corners = _blend(shape, edges, kind="fillet", size=r).volume
        real = sb._ball_corners
        sb._ball_corners = lambda *a: []
        try:
            square = _blend(shape, edges, kind="fillet", size=r).volume
        finally:
            sb._ball_corners = real
        assert abs(with_corners - kernel) < 0.25 * abs(square - kernel), (name, kernel, with_corners, square)
    assert _blend(d, d.edges(), kind="fillet", size=3).is_valid, "a corner that will not combine is left square, not a failure"
    print(PASS, "ball corners on a D shape and a 25 degree taper land within a quarter of the square ends' error")


def test_the_kernels_failed_attempts_leave_the_body_alone():
    """A failed kernel fillet raised the tolerances of the edges it touched on
    the body itself, from 0.07mm to 12.7mm on the user's part, and the section
    fallback after it then made an invalid solid at every size. That part is an
    imported STEP; a failing attempt that does the same stands in for it here."""
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    import blends
    import builder

    def max_tol(shape):
        m, ex = 0.0, TopExp_Explorer(shape.wrapped, TopAbs_EDGE)
        while ex.More():
            m = max(m, BRep_Tool.Tolerance_s(TopoDS.Edge_s(ex.Current())))
            ex.Next()
        return m

    def poisoning(shape, edges, radii):
        for e in edges:
            BRep_Builder().UpdateEdge(e.wrapped, 12.7)
        raise ValueError("Failed creating a fillet, try a smaller value")

    seen = []
    real_try = blends._try_section
    real_native = builder.native_fillet

    def spy(body, edges, section):
        seen.append(max_tol(body["shape"]))
        return real_try(body, edges, section)

    blends._try_section = spy
    builder.native_fillet = poisoning
    try:
        _p, _e, base = rebuild({"parameters": {}, "features": LEG})
        before = max_tol(base[0]["shape"])
        errors, bodies = _fillet()
    finally:
        blends._try_section = real_try
        builder.native_fillet = real_native
    assert not errors and bodies[0]["shape"].is_valid, errors
    assert seen and max(seen) <= before + 1e-9, (before, seen)
    print(PASS, "the fallback sees the body with the tolerances it had before the kernel tried")


def test_a_draft_preview_is_quicker_and_close_to_the_real_build():
    """The live drag builds a draft: once a frame has needed the section build
    it skips the kernel's attempts, and it lofts a third of the sections. What
    it shows has to be the blend the commit will build, near enough to judge."""
    import blends

    calls = []
    real = blends._sequential_blend

    def spy(*a, **k):
        calls.append(1)
        return real(*a, **k)

    blends._sequential_blend = spy
    try:
        full_errors, full = _fillet(radius=2.0)
        calls.clear()
        drafts = []
        for r in (2.0, 2.0):
            _p, errors, bodies = rebuild({"parameters": {}, "features": LEG + [
                {"id": "f", "type": "fillet", "radius": r, "draft": True,
                 "edges": {"kind": "edge", "by": "nearest", "point": SEAM_SIDE}}]})
            assert not errors, errors
            drafts.append(bodies[0]["shape"])
    finally:
        blends._sequential_blend = real
    assert not full_errors and not calls, (full_errors, len(calls))
    _p, _e, base = rebuild({"parameters": {}, "features": LEG})
    added = full[0]["shape"].volume - base[0]["shape"].volume
    for d in drafts:
        assert d.is_valid and abs(d.volume - full[0]["shape"].volume) < 0.05 * added, (d.volume, full[0]["shape"].volume, added)
    print(PASS, "a draft skips the kernel's per-edge attempts and adds within 5% of the real blend")


if __name__ == "__main__":
    try:
        test_matches_the_kernel_where_the_kernel_builds()
        test_g2_and_two_distance_sections()
        test_a_radius_past_the_faces_carves_through()
        test_a_rim_past_its_axis_domes_instead_of_refusing()
        test_the_section_carries_the_profile()
        test_legs_set_into_a_round_wall_all_round_where_they_meet_its_underside()
        test_the_junction_beside_a_seam_now_rounds()
        test_feature_options_reach_the_build()
        test_tangent_edges_off_stops_at_the_picked_edge()
        test_a_blend_stops_at_the_face_its_edge_ends_on()
        test_a_chamfer_where_its_edge_ends_on_the_rim()
        test_every_edge_rounded_meets_in_a_ball()
        test_a_rim_rounded_by_its_own_radius_is_a_dome()
        test_a_corner_on_a_curved_face_and_a_tapered_one_round_like_the_kernel()
        test_the_kernels_failed_attempts_leave_the_body_alone()
        test_a_draft_preview_is_quicker_and_close_to_the_real_build()
        print("\nALL PASS")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
