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
    started = time.time()
    try:
        _blend(ring, [floor], kind="fillet", size=40)
        raise AssertionError("a pocket floor blend as wide as the pocket must refuse")
    except SectionBlendError as err:
        assert "tighter than the edge" in str(err), err
    assert time.time() - started < 5, "the refusal has to come before the boolean, which grinds for a minute"
    print(PASS, "15mm on a 20mm cube builds, 1000mm refuses as removing the body, a pocket-wide one fast")


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


if __name__ == "__main__":
    try:
        test_matches_the_kernel_where_the_kernel_builds()
        test_g2_and_two_distance_sections()
        test_a_radius_past_the_faces_carves_through()
        test_the_junction_beside_a_seam_now_rounds()
        test_feature_options_reach_the_build()
        test_tangent_edges_off_stops_at_the_picked_edge()
        test_a_blend_stops_at_the_face_its_edge_ends_on()
        test_a_chamfer_where_its_edge_ends_on_the_rim()
        print("\nALL PASS")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
