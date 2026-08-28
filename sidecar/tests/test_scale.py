"""Scale: per axis, about a chosen point, on named bodies.

Run:  python test_scale.py

The feature was one number applied to the active body about whatever point
build123d picked for it (the object's own location). That is the wrong shape for
a gizmo handle in two ways at once: dragging ONE arrow means one axis, and a
resize has to hold still the point the user aimed at rather than one nobody can
see.

So the tests worth having are the two that would silently produce a
plausible-looking wrong part: that `about` actually holds a point still, and
that a document written before any of this still scales exactly as it did.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Box, Pos

from builder import _handle_scale


class Ctx:
    """The slice of the build context _handle_scale touches."""

    def __init__(self, bodies):
        self.bodies = bodies
        self.diagnostics = []

    def val(self, v):
        return float(v)

    def require_active(self, _label):
        return self.bodies[0]

    def find_body(self, bid):
        return next((b for b in self.bodies if b["id"] == bid), None)


def body(shape, bid="body1"):
    return {"id": bid, "name": "Box", "shape": shape}


def bounds(b):
    bb = b["shape"].bounding_box()
    return (
        [round(bb.min.X, 6), round(bb.min.Y, 6), round(bb.min.Z, 6)],
        [round(bb.max.X, 6), round(bb.max.Y, 6), round(bb.max.Z, 6)],
    )


def test_one_axis_at_a_time():
    b = body(Box(10, 10, 10))
    _handle_scale({"id": "f1", "type": "scale", "factor": 1, "sx": 3}, Ctx([b]))
    lo, hi = bounds(b)
    assert lo == [-15, -5, -5] and hi == [15, 5, 5], (lo, hi)


def test_about_holds_a_point_still():
    # THE measurement. A 20mm cube sitting from x=100 to x=120, doubled about
    # its own near corner: that corner must not move, and the far one must end
    # up 40mm out rather than 240mm out.
    b = body(Pos(110, 0, 0) * Box(20, 20, 20))
    _handle_scale(
        {"id": "f1", "type": "scale", "factor": 2, "about": [100, -10, -10]},
        Ctx([b]),
    )
    lo, hi = bounds(b)
    assert lo == [100, -10, -10], lo
    assert hi == [140, 30, 30], hi

    # CONTROL: the same resize with no `about` — the feature's old behaviour,
    # which scales about the object's OWN location. The corner does not stay
    # put; it moves 10mm, and every hole and face bored relative to it moves
    # with it. That is the whole reason a gizmo has to send a point.
    c = body(Pos(110, 0, 0) * Box(20, 20, 20))
    _handle_scale({"id": "f1", "type": "scale", "factor": 2}, Ctx([c]))
    lo2, _ = bounds(c)
    assert lo2 == [90, -20, -20], lo2


def test_a_document_written_before_any_of_this_is_unchanged():
    b = body(Box(10, 10, 10))
    _handle_scale({"id": "f1", "type": "scale", "factor": 2.5}, Ctx([b]))
    lo, hi = bounds(b)
    assert lo == [-12.5, -12.5, -12.5] and hi == [12.5, 12.5, 12.5], (lo, hi)


def test_named_bodies_only():
    a = body(Box(10, 10, 10), "body1")
    c = body(Pos(50, 0, 0) * Box(10, 10, 10), "body2")
    _handle_scale(
        {"id": "f1", "type": "scale", "factor": 2, "bodies": ["body2"]},
        Ctx([a, c]),
    )
    assert bounds(a) == ([-5, -5, -5], [5, 5, 5])
    # c is at 45..55 and doubles about its own location (50), so 40..60.
    assert bounds(c) == ([40, -10, -10], [60, 10, 10]), bounds(c)


def test_a_missing_body_is_a_no_op_not_a_failure():
    # An upstream removal can leave a stale id behind; move already treats that
    # as a skip, and a scale that raised instead would paint the timeline red
    # for a body the user themselves deleted.
    a = body(Box(10, 10, 10))
    ctx = Ctx([a])
    _handle_scale({"id": "f1", "type": "scale", "factor": 2, "bodies": ["gone"]}, ctx)
    assert bounds(a) == ([-5, -5, -5], [5, 5, 5])
    assert ctx.diagnostics, "the skip has to be recorded, not swallowed"


def test_the_mesh_is_dropped_so_it_cannot_disagree_with_the_geometry():
    """The one that shipped a part on screen that was not the part in the file.

    A non-uniform scale goes through BRepBuilderAPI_GTransform, which returns
    correct geometry with a triangulation still attached to its faces that no
    longer describes it. Everything downstream reads that mesh. Measured: a 20mm
    cube stretched 2x in x about a corner came back to the frontend as
    -20..20 where the kernel had -10..30, with nothing raised anywhere.
    """
    from OCP.BRep import BRep_Tool
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    def meshed_faces(shape):
        n = 0
        ex = TopExp_Explorer(shape, TopAbs_FACE)
        while ex.More():
            loc = TopLoc_Location()
            if BRep_Tool.Triangulation_s(TopoDS.Face_s(ex.Current()), loc) is not None:
                n += 1
            ex.Next()
        return n

    b = body(Box(20, 20, 20))
    # CONTROL: the shape arrives WITH a mesh, which is the state that made this
    # go wrong and is the ordinary state of a real body — the sidecar caches
    # bodies between rebuilds, so a body that has been drawn once is carrying
    # the tessellator's triangulation the next time a feature touches it.
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    BRepMesh_IncrementalMesh(b["shape"].wrapped, 0.1, False, 0.5, True)
    assert meshed_faces(b["shape"].wrapped) > 0, "the control needs a meshed input"

    _handle_scale(
        {"id": "f1", "type": "scale", "factor": 1, "sx": 2, "about": [-10, -10, -10]},
        Ctx([b]),
    )
    assert meshed_faces(b["shape"].wrapped) == 0
    lo, hi = bounds(b)
    assert lo == [-10, -10, -10] and hi == [30, 10, 10], (lo, hi)


def test_zero_is_refused_on_every_axis():
    for key in ("factor", "sx", "sy", "sz"):
        b = body(Box(10, 10, 10))
        f = {"id": "f1", "type": "scale", "factor": 1}
        f[key] = 0
        try:
            _handle_scale(f, Ctx([b]))
        except ValueError as e:
            assert key in str(e), (key, str(e))
        else:
            raise AssertionError(f"{key}=0 was accepted; it collapses the body flat")


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"PASS {name}")
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print("scale:", "OK" if not failed else f"{failed} FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
