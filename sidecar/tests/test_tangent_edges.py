"""The kernel already includes tangent edges, and this pins that.

A blend option named "include tangent edges" was about to be built: pick one
edge of a rounded outline and have the fillet follow the whole smooth run. It
turns out OCCT does that on its own, filleting ONE edge of an eight-edge
tangent rim gives byte-identical geometry to filleting all eight, while a sharp
rim does not propagate at all.

So there is nothing to add and nothing to switch off. That is worth a test rather
than a comment, for two reasons. It is the answer to a question that will be
asked again ("why is there no include-tangent-edges option?"), and it is a
behaviour the app leans on without ever asking for it: selecting one edge of a
slot outline and getting the whole outline blended is the kernel's doing, so if a
future OCCT stopped propagating, every such pick would silently start producing a
blend with a step in it, and nothing else here would notice.

The conic-profile path is checked too. That one rebuilds the solid's faces
itself (conic_blend.py) rather than calling BRepFilletAPI, so it could easily
have disagreed with the plain path, and the same pick would then cover different
edges depending on the profile value.

Run:  python test_tangent_edges.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Axis, Solid

from builder import _conic_fillet
from test_conic_blend import mesh_volume


def _rounded_rim():
    """A box whose vertical edges are filleted, so its top rim is a run of four
    straight edges and four arcs joined tangentially. Returns (solid, rim)."""
    box = Solid.make_box(40, 30, 12)
    solid = box.fillet(5, box.edges().filter_by(Axis.Z))
    top = max(f.center().Z for f in solid.faces())
    rim = [e for e in solid.edges() if abs(e.center().Z - top) < 1e-6]
    assert len(rim) == 8, f"expected an 8-edge rounded rim, got {len(rim)}"
    return solid, rim


def test_one_pick_on_a_tangent_run_blends_the_whole_run():
    solid, rim = _rounded_rim()
    one = mesh_volume(solid.fillet(1, [rim[0]]).wrapped)
    every = mesh_volume(solid.fillet(1, rim).wrapped)
    assert abs(one - every) < 1e-6, (
        f"OCCT stopped propagating along tangent edges: one edge {one:.3f}, "
        f"all eight {every:.3f}. Picking one edge of a rounded outline now "
        f"blends only that segment, which leaves a step in the blend."
    )
    print(f"tangent rim: 1 pick == all 8 ({one:.2f}mm3) OK")


def test_it_does_NOT_leak_across_a_sharp_corner():
    """The other half. If propagation crossed sharp joins, one pick on a plain
    box would fillet the whole thing."""
    box = Solid.make_box(40, 30, 12)
    top = max(f.center().Z for f in box.faces())
    rim = [e for e in box.edges() if abs(e.center().Z - top) < 1e-6]
    assert len(rim) == 4
    one = mesh_volume(box.fillet(1, [rim[0]]).wrapped)
    every = mesh_volume(box.fillet(1, rim).wrapped)
    assert every < one - 1e-6, (
        f"a sharp rim must NOT propagate: one edge {one:.3f}, all four {every:.3f}"
    )
    print(f"sharp rim: 1 pick != all 4 ({one:.2f} vs {every:.2f}mm3) OK")


def test_the_conic_profile_path_agrees():
    """conic_blend rebuilds the faces itself, so it is free to disagree with
    BRepFilletAPI. If it ever does, the same pick covers different edges
    depending on the profile value, which reads as the profile slider moving
    geometry it has no business touching."""
    solid, rim = _rounded_rim()
    one = mesh_volume(_conic_fillet(solid, [rim[0]], 1, 0.4).wrapped)
    every = mesh_volume(_conic_fillet(solid, rim, 1, 0.4).wrapped)
    assert abs(one - every) < 1e-6, (
        f"the conic path stopped agreeing with the plain one: {one:.3f} vs {every:.3f}"
    )
    print(f"conic profile agrees ({one:.2f}mm3) OK")


if __name__ == "__main__":
    try:
        test_one_pick_on_a_tangent_run_blends_the_whole_run()
        test_it_does_NOT_leak_across_a_sharp_corner()
        test_the_conic_profile_path_agrees()
        print("\nall tangent-edge tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
