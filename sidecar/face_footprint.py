"""Cut a sketch profile where the model under it ends, so a selected AREA of that
profile means the same thing to the kernel as it does on screen.

The frontend already does this (src/sketch/faceFootprint.ts): a profile drawn
across the edge of the face it sits on picks as two regions, the part with
material behind it and the part hanging off. What it does NOT do is write that
anywhere, because there is nothing to write, the split falls out of the model.
So the builder saw one whole profile, and a feature that named one half by an
interior point resolved it to the whole, which is a join that adds a piece
nobody asked for and a cut that takes the rest of the part with it.

The rule here is the frontend's rule, for the same reasons it gives: the
boundary comes from EDGES lying IN the sketch plane, not from faces. A sketch
plane is coplanar with its face by construction, so the edges passing that test
ARE its outline, and geometry merely flush with the same plane is picked up too,
which is correct, the profile can sit on that as well.

The one thing that differs is WHICH model. The overlay splits against the model
on screen; a handler here splits against the bodies that exist at its own point
in the timeline. Those are the same model whenever it matters: at creation the
feature does not exist yet, and re-opening one rolls the document back past it
first (store.beginEditPreview). Splitting against the finished model instead
would let a later feature redraw an earlier one's profile.
"""

from build123d import Face

# How far off the plane a point may sit and still count as ON it, relative to the
# model's own size. Relative because an absolute figure means different things on
# a 6mm part and a 400mm one. Mirrors PLANE_TOL_FRACTION in faceFootprint.ts and
# has to keep mirroring it: the two must agree on which edges bound the face, or
# the regions on screen are not the regions that build.
PLANE_TOL_FRACTION = 1e-4

# Parameters an edge is sampled at. Every sample has to be on the plane, not the
# midpoint or the ends, for the reason the frontend gives: an edge that merely
# CROSSES the plane has both ends off it and still passes any single-point test
# at the crossing, and admitting one would cut the profile along a line that
# bounds nothing. Nine is enough to catch a curve leaving the plane and back,
# and edges are pre-filtered by bounding box before any of them is taken.
_SAMPLES = tuple(i / 8 for i in range(9))


def plane_tolerance(model_scale):
    """The on-plane tolerance for a model of this size (its bbox diagonal)."""
    s = model_scale if isinstance(model_scale, (int, float)) and model_scale > 0 else 0.0
    return max(1e-5, s * PLANE_TOL_FRACTION)


def _signed(p, origin, normal):
    return (p.X - origin.X) * normal.X + (p.Y - origin.Y) * normal.Y + (p.Z - origin.Z) * normal.Z


def bbox_straddles_plane(bb, origin, normal, tol):
    """Could a shape inside this bounding box lie in the plane?

    A rejection test, not an acceptance one. The box CONTAINS the shape, so a box
    whose every corner sits more than `tol` to one side holds nothing that
    reaches the plane. The converse does not follow — a diagonal edge lying in a
    tilted plane has corners well off it — which is why this only ever prunes,
    and the sampling below decides.
    """
    lo = hi = None
    for x in (bb.min.X, bb.max.X):
        for y in (bb.min.Y, bb.max.Y):
            for z in (bb.min.Z, bb.max.Z):
                d = (x - origin.X) * normal.X + (y - origin.Y) * normal.Y + (z - origin.Z) * normal.Z
                lo = d if lo is None else min(lo, d)
                hi = d if hi is None else max(hi, d)
    if lo is None:
        return False
    return lo <= tol and hi >= -tol


def edge_lies_in_plane(edge, origin, normal, tol):
    """True when every sample of the edge lies within `tol` of the plane."""
    try:
        for t in _SAMPLES:
            if abs(_signed(edge @ t, origin, normal)) > tol:
                return False
    except Exception:
        return False
    return True


def _boxes_overlap(a, b, pad):
    return (a.min.X - pad <= b.max.X and b.min.X - pad <= a.max.X
            and a.min.Y - pad <= b.max.Y and b.min.Y - pad <= a.max.Y
            and a.min.Z - pad <= b.max.Z and b.min.Z - pad <= a.max.Z)


def edges_in_plane(shapes, origin, normal, tol, within=None, tick=None):
    """The edges of `shapes` that lie in the plane, as a flat list.

    `within` (a bounding box) drops edges that cannot reach the profile being
    split. An edge on the far side of a 3000-body assembly is a splitter tool
    that changes nothing and still costs a boolean, and this walk is the only
    part of the split whose cost grows with the whole model rather than with the
    sketch.
    """
    out = []
    for shape in shapes:
        if shape is None:
            continue
        try:
            edges = shape.edges()
        except Exception:
            continue
        for e in edges:
            if tick is not None:
                tick()
            try:
                bb = e.bounding_box()
            except Exception:
                continue
            if within is not None and not _boxes_overlap(bb, within, tol):
                continue
            if not bbox_straddles_plane(bb, origin, normal, tol):
                continue
            if edge_lies_in_plane(e, origin, normal, tol):
                out.append(e)
    return out


def split_faces(faces, tools):
    """Split `faces` along `tools`, or hand back `faces` unchanged.

    Unchanged on ANY failure, and unchanged when the split loses material: the
    fallback is what the builder did before this existed, so a splitter that
    cannot cope leaves a feature building the way it always did rather than
    building something new and wrong. Area is the check because that is the way
    a bad split shows up — cells dropped, not cells added.
    """
    faces = [f for f in faces if f is not None]
    if not faces or not tools:
        return faces
    try:
        from OCP.BOPAlgo import BOPAlgo_Splitter
        from OCP.TopTools import TopTools_ListOfShape
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_FACE
        from OCP.TopoDS import TopoDS

        sp = BOPAlgo_Splitter()
        args = TopTools_ListOfShape()
        for f in faces:
            args.Append(f.wrapped)
        sp.SetArguments(args)
        tl = TopTools_ListOfShape()
        for t in tools:
            tl.Append(t.wrapped)
        sp.SetTools(tl)
        sp.Perform()
        if sp.HasErrors():
            return faces
        out = []
        exp = TopExp_Explorer(sp.Shape(), TopAbs_FACE)
        while exp.More():
            out.append(Face(TopoDS.Face_s(exp.Current())))
            exp.Next()
        if not out:
            return faces
        before = sum(f.area for f in faces)
        after = sum(f.area for f in out)
        if after < before - max(1e-9, before * 1e-6):
            return faces
        return out
    except Exception:
        return faces


def split_profile_cells(cells, origin, normal, shapes, model_scale, tick=None):
    """The region-pick cells of a sketch, cut where the model under them ends.

    `cells` are the sketch's own arrangement faces (already located in world),
    `shapes` the bodies to cut them against. Returns `cells` unchanged when
    nothing lies in the plane, which is the ordinary answer for a sketch on a
    datum plane and has to stay distinguishable from a face with no area.
    """
    cells = [c for c in cells if c is not None]
    if not cells or not shapes:
        return cells
    tol = plane_tolerance(model_scale)
    within = None
    for c in cells:
        try:
            bb = c.bounding_box()
        except Exception:
            continue
        within = bb if within is None else within.add(bb)
    tools = edges_in_plane(shapes, origin, normal, tol, within=within, tick=tick)
    if not tools:
        return cells
    return split_faces(cells, tools)


__all__ = [
    "PLANE_TOL_FRACTION",
    "plane_tolerance",
    "bbox_straddles_plane",
    "edge_lies_in_plane",
    "edges_in_plane",
    "split_faces",
    "split_profile_cells",
]
