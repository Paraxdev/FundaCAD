"""Press/Pull on curved faces.

Run:  python test_presspull.py

Three operations, in descending order of how good the answer is and ascending
order of how often it works. These tests pin every step and every boundary.

1. PLANES extrude the face region into a prism and boolean it.
2. ANALYTIC curves (cylinder, cone, sphere, torus) get the real local offset,
   which is what resizes a hole, a boss or a blend properly. The torus matters
   most: a fillet on a round edge is a toroidal face, so "blend a part, then
   adjust the blend by dragging it" used to be refused outright.
3. FREEFORM faces sweep along one direction and boolean, like a plane. Weaker —
   the face travels with straight side walls instead of the surface thickening —
   but robust, and a weaker answer beats a refusal.

The offset must NEVER be tried on a freeform face. It does not fail there, it
crashes: a swept BSPLINE offsets fine at +-1mm and dies with an access violation
at +-8mm and +-20mm. An earlier change probed +-1.5mm only, concluded nothing
crashes, and shipped — and a -20mm cut then killed a worker mid-rebuild. Hence
test_the_large_offsets_that_killed_a_worker, which runs out of process so a
crash is a return code, and test_the_freeform_path_never_calls_the_offset.

And validity is not enough to accept a sweep. A face that wraps around produces
a valid solid of volume 0.0 — a well-formed nothing — so the volume is checked
for sign and direction too.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import GeomType, Solid, Wire

from builder import _press_pull
from test_conic_blend import mesh_volume

from OCP.BRepCheck import BRepCheck_Analyzer


def _one(shape, kind):
    """The first face of `shape` with surface type `kind`."""
    for f in shape.faces():
        if f.geom_type == kind:
            return f
    raise AssertionError(f"no {kind} face on this shape")


def _pulled(shape, face, d):
    """Press/pull and return (valid, volume before, volume after)."""
    v0 = mesh_volume(shape.wrapped)
    out = _press_pull(shape, face, d)
    return BRepCheck_Analyzer(out.wrapped).IsValid(), v0, mesh_volume(out.wrapped)


def test_the_blend_face_of_a_filleted_part():
    """The regression this whole change is about.

    Filleting a cylinder's rim makes a TORUS face. Under the old whitelist,
    dragging it reported "Press/Pull supports flat and cylindrical faces only" —
    on a face the kernel offsets without complaint."""
    s = Solid.make_cylinder(12, 24)
    s = s.fillet(3, s.edges().filter_by(GeomType.CIRCLE))
    f = _one(s, GeomType.TORUS)
    ok, v0, v1 = _pulled(s, f, 1.5)
    assert ok, "offsetting the blend face produced an invalid solid"
    assert v1 > v0, f"pulling the blend outward did not add material ({v0} -> {v1})"
    print(f"filleted rim (torus) OK: {v0:.1f} -> {v1:.1f}")


def test_the_analytic_curved_surfaces():
    """Cone, sphere and torus: all offset to valid solids, both of the shapes a
    user actually has to hand. Each is a separate case because a whitelist that
    grew one entry at a time is how the old one ended up two long."""
    cases = [
        ("cone", Solid.make_cone(12, 5, 20), GeomType.CONE),
        ("sphere", Solid.make_sphere(15), GeomType.SPHERE),
        ("torus", Solid.make_torus(20, 6), GeomType.TORUS),
    ]
    for name, s, kind in cases:
        ok, v0, v1 = _pulled(s, _one(s, kind), 1.5)
        assert ok, f"{name}: invalid solid"
        assert v1 > v0, f"{name}: outward pull did not add material ({v0} -> {v1})"
        print(f"  {name} OK: {v0:.1f} -> {v1:.1f}")


def _lofted_freeform():
    """A loft between two offset, rotated rectangles: four BSpline side faces,
    each of which faces one way. The ordinary freeform shape — a draft, a blended
    transition, an imported organic part."""
    from build123d import Face, Plane, Rot, loft

    bottom = Plane.XY * Face.make_rect(30, 30)
    top = Plane.XY.offset(20) * Rot(0, 0, 30) * Face.make_rect(14, 22)
    return loft([bottom, top])


def test_a_freeform_face_moves_by_sweeping_instead_of_offsetting():
    """A freeform face that faces one way is no longer refused — it sweeps.

    This is the capability the refusal used to cost. The offset path cannot go
    here at all: it works at +-1mm and dies with an access violation at +-8mm and
    +-20mm, in both directions, on a threshold set by local curvature that
    nothing can bound.

    Sweeping gives a different answer, and the difference is real — the face
    travels along one direction with straight side walls rather than the surface
    thickening. On a face like this that is what "push this patch" means."""
    s = _lofted_freeform()
    f = max((x for x in s.faces() if x.geom_type == GeomType.BSPLINE),
            key=lambda x: x.area)
    for d in (1.5, 5.0, 20.0, -5.0):
        v0 = mesh_volume(s.wrapped)
        out = _press_pull(s, f, d)
        assert BRepCheck_Analyzer(out.wrapped).IsValid(), f"{d}: invalid solid"
        v1 = mesh_volume(out.wrapped)
        assert (v1 > v0) == (d > 0), f"{d}: material moved the wrong way {v0} -> {v1}"
        print(f"  freeform swept {d:+6}mm OK: {v0:.1f} -> {v1:.1f}")


def test_a_wrapping_face_is_thickened_rather_than_swept():
    """The side of a swept tube closes on itself, so no single direction means
    anything and a linear prism eats the solid. Measured, before there was
    anywhere else for it to go: the swept result passes BRepCheck_Analyzer and
    has volume 0.0 — a perfectly well-formed nothing.

    It now goes to _thicken_press_pull instead, which follows the SURFACE and so
    needs no direction. The property to hold is the one that always mattered:
    the body must GROW, not vanish."""
    from build123d import Face, Spline

    s = Solid.sweep(Face(Wire.make_circle(4)), Spline((0, 0, 0), (4, 0, 10), (0, 0, 20)))
    f = _one(s, GeomType.BSPLINE)
    v0 = mesh_volume(s.wrapped)
    out = _press_pull(s, f, 1.0)
    assert BRepCheck_Analyzer(out.wrapped).IsValid(), "thickened result is not a valid solid"
    v1 = mesh_volume(out.wrapped)
    assert v1 > v0 * 1.05, f"a +1mm push on the wall barely moved it: {v0:.1f} -> {v1:.1f}"
    print(f"wrapping face thickened OK: {v0:.1f} -> {v1:.1f}")


def test_the_sweep_still_refuses_what_it_cannot_do():
    """The control for the test above, and the reason it is not a regression.

    Thicken is admitted for exactly the (surface type, direction) pairs that
    were measured not to crash the kernel; everything else still reaches the
    sweep, and the sweep must still refuse a wrapping face rather than commit a
    well-formed nothing. Forcing the eligibility test to say no is what proves
    the guard underneath is still there."""
    from build123d import Face, Spline

    import solid_ops

    s = Solid.sweep(Face(Wire.make_circle(4)), Spline((0, 0, 0), (4, 0, 10), (0, 0, 20)))
    f = _one(s, GeomType.BSPLINE)
    keep = solid_ops._wrapped_thickenable
    solid_ops._wrapped_thickenable = lambda gt, d: False
    try:
        out = _press_pull(s, f, 1.0)
    except ValueError as ex:
        assert "wraps" in str(ex), f"refusal should name the reason, got: {ex}"
        print(f"sweep still refuses a wrapping face OK: {ex}")
        return
    finally:
        solid_ops._wrapped_thickenable = keep
    raise AssertionError(
        f"the sweep accepted a wrapping face, leaving volume {mesh_volume(out.wrapped):.1f}")


def test_a_wrapping_face_pushed_INWARD_is_still_refused():
    """Where the measurement stops.

    On a swept tube, thickening the wall INWARD is an access violation in OCCT
    (exit code 0xC0000005, measured one subprocess per distance at -0.5 and
    -1.5mm), so a BSPLINE only gets the thicken path outward. A crash takes the
    worker with it, while a refusal is a sentence, and that asymmetry is what
    decides this."""
    from build123d import Face, Spline

    s = Solid.sweep(Face(Wire.make_circle(4)), Spline((0, 0, 0), (4, 0, 10), (0, 0, 20)))
    f = _one(s, GeomType.BSPLINE)
    try:
        _press_pull(s, f, -1.0)
    except ValueError as ex:
        assert "wraps" in str(ex), f"refusal should name the reason, got: {ex}"
        print(f"inward push on a wrapping bspline refused OK: {ex}")
        return
    raise AssertionError("an inward push on a wrapping BSPLINE face was accepted — "
                         "that is the case measured to crash the kernel")


def test_a_wrapping_surface_of_revolution_moves_both_ways():
    """The case that started this: a 360-degree revolve of a profile the kernel
    cannot call a cylinder, a cone, a sphere or a torus. Its side face wraps, so
    it used to reach the sweep and be refused — on a shape whose whole point is
    that you push its wall around.

    Both directions, because unlike the BSPLINE this one was measured safe both
    ways (revolved spline and revolved bulge, at +-0.5, +-1.5 and +-5mm)."""
    from build123d import Axis, Plane, Polyline, Spline, make_face, revolve

    prof = Plane.XZ * (Spline((10, 0), (16, 6), (11, 14), (18, 20))
                       + Polyline((18, 20), (8, 20), (8, 0), (10, 0)))
    body = revolve(make_face(prof), Axis.Z, 360)
    side = _one(body, GeomType.REVOLUTION)
    for d in (1.5, -1.5):
        v0 = mesh_volume(body.wrapped)
        out = _press_pull(body, side, d)
        assert BRepCheck_Analyzer(out.wrapped).IsValid(), f"{d}: invalid solid"
        v1 = mesh_volume(out.wrapped)
        assert (v1 > v0) == (d > 0), f"{d}: material moved the wrong way {v0:.1f} -> {v1:.1f}"
        print(f"  revolved wall {d:+5}mm OK: {v0:.1f} -> {v1:.1f}")


def test_the_freeform_path_never_calls_the_offset_that_crashes():
    """The guarantee above, held structurally rather than by reading the code.

    _offset_faces is replaced with a bomb for the duration: if the freeform
    branch ever grows a "try the offset first" it fails here, loudly, instead of
    in a user's session as a dead worker."""
    import builder
    from build123d import Face, Spline

    s = _lofted_freeform()
    f = max((x for x in s.faces() if x.geom_type == GeomType.BSPLINE),
            key=lambda x: x.area)
    real = builder._offset_faces

    def bomb(*_a, **_k):
        raise AssertionError("the freeform path reached BRepOffset — this crashes workers")

    builder._offset_faces = bomb
    try:
        builder._press_pull(s, f, 1.0)
    finally:
        builder._offset_faces = real
    print("freeform path stays clear of BRepOffset OK")


def test_the_large_offsets_that_killed_a_worker():
    """The magnitudes, not just the types.

    The first version of this change was probed at +-1.5mm only and concluded
    that nothing crashes. A -20mm cut then killed a worker in the field. Every
    surface on the permitted list is therefore held to surviving an offset far
    larger than its own features, run OUT OF PROCESS so that a crash is a return
    code here rather than the end of this test run."""
    import subprocess

    runner = (
        "import sys; sys.path.insert(0, r'{cwd}')\n"
        "from build123d import *\n"
        "{setup}\n"
        "from builder import _press_pull\n"
        "try:\n"
        "    _press_pull(s, f, {d})\n"
        "except ValueError:\n"
        "    pass\n"
        "print('SURVIVED')\n"
    )
    cases = {
        "sphere": "s = Solid.make_sphere(15)\nf = [x for x in s.faces() if x.geom_type == GeomType.SPHERE][0]",
        "torus": "s = Solid.make_torus(20, 6)\nf = [x for x in s.faces() if x.geom_type == GeomType.TORUS][0]",
        "blend": ("s = Solid.make_cylinder(12, 24)\n"
                  "s = s.fillet(3, s.edges().filter_by(GeomType.CIRCLE))\n"
                  "f = [x for x in s.faces() if x.geom_type == GeomType.TORUS][0]"),
        "freeform": ("s = Solid.sweep(Face(Wire.make_circle(4)), Spline((0,0,0),(4,0,10),(0,0,20)))\n"
                     "f = [x for x in s.faces() if x.geom_type == GeomType.BSPLINE][0]"),
    }
    import os

    cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for name, setup in cases.items():
        for d in (-20.0, 20.0):
            src = runner.format(cwd=cwd, setup=setup, d=d)
            p = subprocess.run([sys.executable, "-c", src], capture_output=True,
                               text=True, timeout=300)
            assert p.returncode == 0 and "SURVIVED" in p.stdout, (
                f"{name} at {d:+.0f}mm did not survive: rc={p.returncode} "
                f"(a non-zero code here is a dead worker, not a failed feature)")
        print(f"  {name} survived +-20mm")


def test_an_impossible_offset_is_refused_not_crashed():
    """An offset the kernel accepts the shape of but cannot complete must come
    back as a ValueError carrying a sentence — not as a solid that fails a
    boolean three operations later, where nothing connects it to what the user
    did. A sphere pushed inward by more than its own radius is that case."""
    s = Solid.make_sphere(10)
    f = _one(s, GeomType.SPHERE)
    try:
        out = _press_pull(s, f, -30.0)
    except ValueError as ex:
        assert str(ex).strip(), "refused with an empty message"
        print(f"impossible offset refused OK: {ex}")
        return
    assert BRepCheck_Analyzer(out.wrapped).IsValid(), (
        "an offset succeeded but produced an invalid solid — the result check "
        "in _offset_faces is not doing its job")
    print("that offset actually succeeded, and validly")


def test_a_flat_face_still_takes_the_prism_path():
    """Planar faces must NOT quietly migrate to the offset path. The prism
    boolean is deliberate: BRepOffset segfaults on faceted and split imported
    faces, which is most of what an imported body is made of."""
    s = Solid.make_box(20, 20, 20)
    f = _one(s, GeomType.PLANE)
    ok, v0, v1 = _pulled(s, f, 5.0)
    assert ok, "planar press/pull produced an invalid solid"
    assert abs((v1 - v0) - 20 * 20 * 5) < 1.0, f"expected +2000mm3, got {v1 - v0:.1f}"
    print(f"planar face OK: {v0:.1f} -> {v1:.1f}")


if __name__ == "__main__":
    try:
        test_the_blend_face_of_a_filleted_part()
        test_the_analytic_curved_surfaces()
        test_a_freeform_face_moves_by_sweeping_instead_of_offsetting()
        test_a_wrapping_face_is_thickened_rather_than_swept()
        test_the_sweep_still_refuses_what_it_cannot_do()
        test_a_wrapping_face_pushed_INWARD_is_still_refused()
        test_a_wrapping_surface_of_revolution_moves_both_ways()
        test_the_freeform_path_never_calls_the_offset_that_crashes()
        test_the_large_offsets_that_killed_a_worker()
        test_an_impossible_offset_is_refused_not_crashed()
        test_a_flat_face_still_takes_the_prism_path()
        print("\nall press/pull tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
