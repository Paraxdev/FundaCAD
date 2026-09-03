"""Which faces count as pieces of one surface, and which emphatically do not.

The case this exists for: a helical groove cut into a shank leaves the uncut
shank as a helical ribbon, one region of one cylinder, but a face may not wrap
more than once around a periodic surface. The kernel stores one face per turn
and no repair merges them, because there is no single face for them to become.
So the pick has to gather them, and this is the rule that decides the gathering.

The rule is only worth anything if it stays narrow, so much of what follows is
controls: shapes with adjacent faces that must NOT be gathered. A box has six
faces all touching each other, and its opposite walls even share a plane, seen
from opposite sides. A hollow tube's bore and its outer wall are two cylinders
on one axis. Each of those would come back joined under a rule that compared
only the surface, or only the adjacency, and each has to come back empty.

Run: uv run python tests/test_face_bands.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Box, Cylinder, Pos, Rot, Sphere

import builder
import face_bands
from face_bands import face_bands as bands
from face_bands import same_surface, surface_of

PASS = "  ok"

# The groove's meridian section: 2mm wide, 1mm tall, centred 8mm out from the
# axis, climbing 2mm a turn over four turns.
W, T, RC, PITCH, TURNS = 2.0, 1.0, 8.0, 2.0, 4


def _grooved_shaft():
    """The real case: a shaft with a helical groove cut into it.

    What survives between the turns is one region of one cylinder that the
    kernel has to store as several faces. Built through the ordinary revolve
    path, so this is the shape the app makes and not a fixture's idea of it."""
    doc = {
        "parameters": {}, "paramDefs": {}, "version": 8,
        "features": [
            {"id": "f1", "type": "sketch", "plane": "XZ",
             "entities": [{"type": "rectangle", "id": "e0",
                           "width": W, "height": T, "x": RC, "y": 0}]},
            {"id": "fr", "type": "revolve", "sketch": "f1", "axis": "Z",
             "angle": 360 * TURNS, "pitch": PITCH, "operation": "new",
             "regions": [[RC, 0, 0]]},
        ],
    }
    _part, errs, bodies = builder.rebuild(doc, diagnostics=[])
    assert errs == [], errs
    return builder._serial_bool(Cylinder(RC + W / 2, 20), bodies[-1]["shape"], "cut")


def _split_wall():
    """Two coaxial cylinders of one radius, fused WITHOUT the coplanar-merge
    pass the ordinary union runs.

    The wall comes out in two pieces meeting at the seam circle: adjacent, one
    surface, and small enough to state the expected answer exactly. The union
    path simplifies this away, which is why the fuse is driven directly."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.TopTools import TopTools_ListOfShape

    args = TopTools_ListOfShape()
    args.Append(Cylinder(5, 10).wrapped)
    tools = TopTools_ListOfShape()
    tools.Append((Pos(0, 0, 10) * Cylinder(5, 10)).wrapped)
    op = BRepAlgoAPI_Fuse()
    op.SetArguments(args)
    op.SetTools(tools)
    op.Build()
    assert op.IsDone()
    return builder._wrap_topods(op.Shape())


def test_a_plain_solid_has_no_runs():
    # Every one of these has adjacent faces, and a box's opposite walls share a
    # plane. All must come back empty, or the rule is merging what was authored
    # apart.
    for name, shape in [
        ("box", Box(10, 10, 10)),
        ("cylinder", Cylinder(5, 10)),
        ("sphere", Sphere(5)),
        ("tube", Cylinder(5, 10) - Cylinder(3, 10)),
        ("grooved ring", Cylinder(5, 20) - (Cylinder(6, 2) - Cylinder(4.6, 2))),
        ("stepped shaft", builder._serial_bool(
            Cylinder(5, 10), Pos(0, 0, 10) * Cylinder(3, 10), "fuse")),
    ]:
        assert bands(shape) == [], (name, bands(shape))
    print(PASS, "a plain solid reports no runs")


def test_a_wall_the_kernel_split_comes_back_as_one_run():
    shape = _split_wall()
    faces = shape.faces()
    got = bands(shape)
    assert got == [[0, 1]], got
    # Both members really are the wall, one 10mm piece each side of the seam.
    for i in got[0]:
        assert str(faces[i].geom_type) == "GeomType.CYLINDER", faces[i].geom_type
    heights = sorted(round(faces[i].bounding_box().size.Z, 6) for i in got[0])
    assert heights == [10.0, 10.0], heights
    print(PASS, "a wall the kernel split comes back as one run")


def test_a_grooved_shank_gathers_the_whole_ribbon():
    shape = _grooved_shaft()
    got = bands(shape)
    assert len(got) == 1, got
    run = got[0]
    # One piece per turn, plus the plain wall above and below the groove.
    assert len(run) == TURNS + 1, (len(run), run)
    faces = shape.faces()
    for i in run:
        # Asked of the surface, not of a bounding box: a partial turn's box is
        # narrower than the shaft it lies on.
        surf = surface_of(faces[i])
        assert surf[0] == "cylinder", surf[0]
        assert abs(surf[3] - (RC + W / 2)) < 1e-9, surf[3]
    # ...and the control that says the run is not simply every face: the groove
    # walls and the shaft's two ends are all still outside it.
    assert len(run) < len(faces), (len(run), len(faces))
    print(PASS, "a grooved shank gathers the whole ribbon")


def test_a_bore_is_never_joined_to_the_shaft_around_it():
    # Same axis, same radius, told apart only by the side each face is used
    # from. This goes at the comparison directly, because a shape holding both
    # would be a zero-thickness one.
    outer = [f for f in Cylinder(5, 10).faces() if str(f.geom_type) == "GeomType.CYLINDER"]
    inner = [f for f in (Cylinder(9, 10) - Cylinder(5, 10)).faces()
             if str(f.geom_type) == "GeomType.CYLINDER"
             and abs(f.bounding_box().size.X / 2 - 5) < 1e-6]
    assert len(outer) == 1 and len(inner) == 1, (len(outer), len(inner))
    a, b = surface_of(outer[0]), surface_of(inner[0])
    assert a[0] == b[0] == "cylinder" and abs(a[3] - b[3]) < 1e-9, (a, b)  # the fixture
    assert not same_surface(a, b), (a, b)
    print(PASS, "a bore is never joined to the shaft around it")


def test_two_faces_on_one_plane_facing_apart_are_not_one_surface():
    # A box's -X and +X walls. Parallel, and the same plane once you drop the
    # sign, which is exactly the mistake an unsigned comparison makes.
    xs = [surface_of(f) for f in Box(10, 10, 10).faces()
          if str(f.geom_type) == "GeomType.PLANE"
          and abs(abs(f.center().X) - 5) < 1e-6]
    assert len(xs) == 2, len(xs)
    assert abs(xs[0][2]) == abs(xs[1][2]), xs  # the fixture: one plane, two sides
    assert not same_surface(xs[0], xs[1]), xs
    print(PASS, "two faces on one plane facing apart are not one surface")


def test_a_surface_it_will_not_judge_is_declined_rather_than_guessed():
    # A spline face has no analytic parameters to compare, and two of them can
    # agree everywhere and still be two authored faces. surface_of says so by
    # returning nothing, and same_surface refuses a missing description.
    assert same_surface(None, None) is False
    assert same_surface(("plane", (0.0, 0.0, 1.0), 0.0), None) is False
    assert same_surface(None, ("plane", (0.0, 0.0, 1.0), 0.0)) is False
    print(PASS, "a surface it will not judge is declined rather than guessed")


def test_a_dense_body_is_skipped_rather_than_banded():
    cap = face_bands.MAX_BAND_FACES
    try:
        face_bands.MAX_BAND_FACES = 2
        assert bands(_split_wall()) == []
    finally:
        face_bands.MAX_BAND_FACES = cap
    # ...and the control: the same shape under the real cap does find its run,
    # so the empty answer above came from the cap and not from the shape.
    assert bands(_split_wall()) == [[0, 1]]
    print(PASS, "a dense body is skipped rather than banded")


def test_the_run_survives_the_body_being_moved_and_turned():
    # Nothing here compares against world axes, so a shape away from the origin
    # and off-axis must give the same answer. It would not if any tolerance were
    # relative to a coordinate rather than to the surface.
    here = bands(_split_wall())
    there = bands(Pos(137.5, -42.25, 9.75) * Rot(23, 41, 67) * _split_wall())
    assert there == here, (here, there)
    print(PASS, "the run survives the body being moved and turned")


def test_a_run_is_reported_in_a_stable_order():
    shape = _grooved_shaft()
    first = bands(shape)
    assert first == bands(shape), (first, bands(shape))
    for run in first:
        assert run == sorted(run), run
    assert [r[0] for r in first] == sorted(r[0] for r in first)
    print(PASS, "a run is reported in a stable order")


def test_faces_on_one_plane_that_do_not_touch_stay_apart():
    # Two pads on one plate: their top faces are the same plane, facing the same
    # way, and are not adjacent. Adjacency is the half of the rule under test.
    shape = Box(40, 10, 2)
    for x in (-12, 12):
        shape = builder._serial_bool(shape, Pos(x, 0, 2.5) * Box(6, 6, 3), "fuse")
    tops = [f for f in shape.faces()
            if str(f.geom_type) == "GeomType.PLANE" and abs(f.center().Z - 4) < 1e-6]
    assert len(tops) == 2, len(tops)
    assert same_surface(surface_of(tops[0]), surface_of(tops[1])), "the fixture is wrong"
    assert bands(shape) == [], bands(shape)
    print(PASS, "faces on one plane that do not touch stay apart")


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            print(f"FAIL {name}")
            failed += 1
    print("face bands:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
