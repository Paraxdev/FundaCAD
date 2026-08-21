"""A cut sketched ON a face has to open a hole, not seal one.

Run:  python test_pick_fuzz.py

The frontend fits a picked face's plane to that face's RENDERED triangles, and
mesh positions are float32 on the wire. So a sketch drawn on a face at y = 24.4
comes back at y = 24.399999618530273 — the float32 neighbour, 3.8e-7 mm short of
the face it was drawn on. Cutting from there used to remove exactly the right
volume and still leave the hole SEALED: a disc lying in the end face's own
plane, with a membrane 0.38 nanometres thick between them, under an end face
that was never trimmed. Valid, watertight, and on screen a filled-in disc that
flickered, because 0.38 nm is four orders of magnitude finer than a depth
buffer.

Every case here builds from primitives rather than from a saved document, so it
says what the defect IS rather than that one file used to trigger it. The
numbers are the reported ones: a boss 10 mm across on a face at y = 24.4, a
Ø4.42 hole cut 10.473 mm into it.

CONTROLS, and they are the point:
  * the same cut from a plane placed EXACTLY on the face already worked, and
    must still produce the identical result — a tolerance that changes a
    correct answer is not a tolerance,
  * a plane a HUNDREDTH of a millimetre inside the face is a real pocket the
    user could have meant, and must still be cut as one (membrane kept),
  * two bodies genuinely 0.05 mm apart must not be welded by the fuzz.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import traceback

from build123d import Location, Plane, Solid

import pick_fuzz
from builder import _serial_bool

from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GeomAbs import GeomAbs_SurfaceType
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS

# The reported geometry.
FACE_Y = 24.4                 # where the boss's end face sits
BOSS_R = 5.0                  # the boss
HOLE_R = 2.2124451862498544   # the circle sketched on its end
DEPTH = 10.473                # how far the cut runs in

# What a float32 makes of FACE_Y: 3.8e-7 mm short. This is not a contrived
# number, it is the one the reported document was saved with.
FACE_Y_F32 = 24.399999618530273


def _faces(shape):
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        yield TopoDS.Face_s(exp.Current())
        exp.Next()


def _area(face):
    p = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, p)
    return p.Mass()


def _volume(shape):
    p = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, p)
    return p.Mass()


def _boss():
    """A cylinder grown along +Y whose flat end is at FACE_Y exactly."""
    return Solid.make_cylinder(BOSS_R, FACE_Y, Plane(origin=(0, 0, 0), z_dir=(0, 1, 0)))


def _cut_from(plane_y):
    """Cut a Ø(2*HOLE_R) hole DEPTH deep, starting from the plane y = plane_y.

    Built on a plane rather than by rotating and then relocating: `locate`
    REPLACES a shape's location, so a rotate followed by a locate throws the
    rotation away and cuts a slot across the boss instead of a hole into it.
    """
    tool = Solid.make_cylinder(
        HOLE_R, DEPTH, Plane(origin=(0, plane_y, 0), z_dir=(0, -1, 0)),
    )
    return _serial_bool(_boss(), tool, "cut")


def _end_face_areas(shape):
    """Areas of the planar faces lying at the boss end, facing +/-Y.

    One entry means an open hole (the end face is an annulus). Two means the
    hole is sealed by a disc in the same plane — the defect.
    """
    out = []
    for f in _faces(shape.wrapped if hasattr(shape, "wrapped") else shape):
        ad = BRepAdaptor_Surface(f)
        if ad.GetType() != GeomAbs_SurfaceType.GeomAbs_Plane:
            continue
        pl = ad.Plane()
        if abs(pl.Axis().Direction().Y()) < 0.99:
            continue
        if not (FACE_Y - 0.001 < pl.Location().Y() < FACE_Y + 0.001):
            continue
        out.append(_area(f))
    return sorted(out)


ANNULUS = math.pi * (BOSS_R**2 - HOLE_R**2)
DISC = math.pi * HOLE_R**2


def test_a_cut_from_the_float32_neighbour_of_the_face_opens_the_hole():
    """The reported defect, reduced to two cylinders."""
    out = _cut_from(FACE_Y_F32)
    assert BRepCheck_Analyzer(out.wrapped).IsValid(), "the cut produced an invalid solid"
    areas = _end_face_areas(out)
    assert len(areas) == 1, (
        f"the boss end carries {len(areas)} faces, areas {[round(a, 5) for a in areas]} — "
        "two means the hole is still sealed by a disc lying in the end face's plane, "
        "which is the whole defect")
    assert abs(areas[0] - ANNULUS) < 1e-4, (
        f"end face area {areas[0]:.5f}, expected the annulus {ANNULUS:.5f}; "
        f"the untrimmed full disc would read {math.pi * BOSS_R ** 2:.5f}")
    print(f"float32 plane cut cleanly: end face = annulus {areas[0]:.5f} mm2")


def test_the_exact_plane_is_untouched():
    """CONTROL. Cutting from the face's exact plane already worked. The
    tolerance must not change what it produces — by volume or by face."""
    exact = _cut_from(FACE_Y)
    fuzzed = _cut_from(FACE_Y_F32)
    ea, fa = _end_face_areas(exact), _end_face_areas(fuzzed)
    assert len(ea) == 1 and abs(ea[0] - ANNULUS) < 1e-4, (
        f"the CONTROL itself is wrong: end faces {[round(a, 5) for a in ea]}")
    # The two may differ by the sliver the shifted tool does not reach — the
    # hole's own area times the 3.8e-7 mm gap, 5.9e-6 mm3 — and by nothing else.
    # Asserting they are bit-identical would be asserting the gap is not there.
    slack = DISC * (FACE_Y - FACE_Y_F32)
    delta = abs(_volume(exact.wrapped) - _volume(fuzzed.wrapped))
    assert delta <= slack, (
        f"exact {_volume(exact.wrapped):.9f} vs float32 {_volume(fuzzed.wrapped):.9f} "
        f"— {delta:.3e} mm3 apart, more than the {slack:.3e} the gap itself accounts for")
    assert abs(ea[0] - fa[0]) < 1e-9, f"end face {ea[0]:.9f} vs {fa[0]:.9f}"
    print(f"exact plane unchanged: {_volume(exact.wrapped):.6f} mm3 either way")


def test_a_pocket_a_hundredth_of_a_millimetre_deep_is_still_a_pocket():
    """CONTROL THAT MUST FAIL if the tolerance is set by feel rather than by
    what a float32 can represent.

    0.01 mm inside the face is four orders of magnitude above the float32 step
    at this size and is a thickness a person can mean, measure and print. It has
    to survive as a real membrane over the hole: TWO faces at the boss end.
    """
    out = _cut_from(FACE_Y - 0.01)
    areas = _end_face_areas(out)
    assert len(areas) == 1 and abs(areas[0] - math.pi * BOSS_R**2) < 1e-4, (
        f"a 0.01 mm skin over the pocket was dissolved: end faces "
        f"{[round(a, 5) for a in areas]} — the fuzz is far too large")
    # and the pocket is genuinely in there
    lost = _volume(_boss().wrapped) - _volume(out.wrapped)
    assert abs(lost - DISC * DEPTH) < 1e-3, f"removed {lost:.5f}, expected {DISC * DEPTH:.5f}"
    print(f"0.01 mm skin survives, pocket volume {lost:.5f} mm3")


def test_bodies_a_twentieth_of_a_millimetre_apart_are_not_welded():
    """CONTROL. Two boxes with a 0.05 mm air gap fuse into TWO solids, not one."""
    a = Solid.make_box(10, 10, 10)
    b = Solid.make_box(10, 10, 10).locate(Location((10.05, 0, 0)))
    out = _serial_bool(a, b, "fuse")
    solids = out.solids() if hasattr(out, "solids") else []
    assert len(solids) == 2, f"the 0.05 mm gap closed: {len(solids)} solid(s)"
    print("0.05 mm gap between bodies survives a fuse")


def test_the_tolerance_tracks_the_size_it_was_picked_at():
    """The rule itself, without a kernel. A part a metre from the origin was
    picked at a metre's precision and needs a metre's tolerance; a part at the
    origin gets the floor; nothing anywhere gets more than a micron."""
    assert pick_fuzz.pick_fuzz(0.0) == pick_fuzz.FLOOR_MM
    assert pick_fuzz.pick_fuzz(None) == pick_fuzz.FLOOR_MM
    assert pick_fuzz.pick_fuzz(float("nan")) == pick_fuzz.FLOOR_MM
    assert pick_fuzz.pick_fuzz(1e9) == pick_fuzz.CEILING_MM
    # covers the reported gap at the reported size, with room to spare
    assert pick_fuzz.pick_fuzz(FACE_Y) > (FACE_Y - FACE_Y_F32), (
        "the tolerance does not even cover the gap it exists for")
    # and stays far under anything a person models, at every size
    for extent in (1, 10, 100, 1000, 10000):
        assert pick_fuzz.pick_fuzz(extent) <= pick_fuzz.CEILING_MM
    # monotone: a bigger part never gets a smaller tolerance
    prev = 0.0
    for extent in (0.1, 1, 10, 100, 1000, 100000):
        v = pick_fuzz.pick_fuzz(extent)
        assert v >= prev - 1e-18, f"not monotone at {extent}"
        prev = v
    print(f"tolerance at 24.4 mm = {pick_fuzz.pick_fuzz(FACE_Y):.3e} mm, "
          f"gap to cover = {FACE_Y - FACE_Y_F32:.3e} mm")


if __name__ == "__main__":
    try:
        test_the_tolerance_tracks_the_size_it_was_picked_at()
        test_a_cut_from_the_float32_neighbour_of_the_face_opens_the_hole()
        test_the_exact_plane_is_untouched()
        test_a_pocket_a_hundredth_of_a_millimetre_deep_is_still_a_pocket()
        test_bodies_a_twentieth_of_a_millimetre_apart_are_not_welded()
        print("\nall pick-fuzz tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
