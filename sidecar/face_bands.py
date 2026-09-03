"""Which faces of a body are pieces of ONE surface that B-rep cannot store as one.

A helical groove cut into a shank leaves the uncut shank as a helical ribbon.
That ribbon is a single region of a single cylinder, but a face on a periodic
surface may not span more than one period, so OCCT hands back one face per turn
and `ShapeUpgrade_UnifySameDomain` cannot merge them: there is no face for it to
merge them INTO. Measured on the spool document, seven faces at r=33.541, each a
full turn, chained end to end. Picking one and pulling it moves a stripe.

So the split survives every repair we run, and the answer has to be selection
rather than geometry: a pick lands on the whole run, and press-pull, move and
delete-face all already take a face LIST. What comes out of here is that run.

The rule is deliberately narrow. Two faces join only when they TOUCH and sit on
the same analytic surface, compared as the surface's own parameters at kernel
tolerance rather than by rounding a key: pieces of one split carry that surface
bit-identically, so a tight comparison keeps everything else apart. A face whose
surface is a spline or a surface of revolution is never joined, since two splines
can agree everywhere and still be two authored faces, and the cases this exists
for are all analytic.

"Touch" is a shared edge, or a gap no wider than the one the kernel itself
inserts. A climbing revolve whose profile is as tall as its pitch would have
crest meeting root along a LINE, which is non-manifold and makes every later
boolean quietly do nothing, so builder._screw_revolve stops the crest a hair
short of the next root. That hair is a real gap with no shared edge across it,
and the two turns either side of it are one wall to anyone looking at them. The
tolerance is that same clearance and not a micron more: anything further apart
than the kernel's own hair was authored apart.

Adjacency alone is not enough and neither is the surface alone: a box's two
opposite walls are the same plane flipped, and a bore and the shaft around it
are the same cylinder. Both would be wrong to merge, so the ORIENTED surface has
to match, the face's own outward side and not just the geometry under it.

Kernel-side by necessity, since it reads the B-rep, but the comparison itself is
plain arithmetic and is tested against hand-built shapes.
"""

import math

# Two pieces of one split carry the same surface exactly, so these only have to
# absorb the last bits of a double. A looser tolerance would start merging faces
# that were authored apart, which is the one thing this must never do.
LIN_TOL = 1e-7
ANG_TOL = 1e-9

# The gap that may stand in for a shared edge, mirroring _turn_clearance in
# builder.py: absolute at small sizes so a 0.2 mm thread is not swallowed,
# proportional above that so a coarse one scales with it. Measured off the body,
# because this side has no profile to ask, which makes it the more generous of
# the two — and still a hundredth of a printed layer on a 100 mm part.
GAP_ABS = 1e-3
GAP_REL = 1e-4

# Above this many faces a body is a dense import, where every pair of coplanar
# triangles would join into one enormous run and the run would be the whole
# skin. Nothing there is a split that repair failed on, it is a mesh, and
# `_simplify_mesh` is what addresses it, so the work is skipped outright.
MAX_BAND_FACES = 3000


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _norm(a):
    return math.sqrt(_dot(a, a))


def _same_dir(a, b):
    """The same direction, pointing the same way, not merely parallel."""
    return _dot(a, b) > 1.0 - ANG_TOL


def _on_axis(pa, pb, d):
    """`pa` and `pb` name the same line when the offset between them has nothing
    across `d`. Two cylinders can carry different origins on one axis."""
    off = _sub(pa, pb)
    return _norm(_cross(off, d)) <= LIN_TOL


def _canon_dir(d):
    """An axis direction with its SIGN normalised away.

    A cylinder's axis is a LINE. The kernel is free to store it pointing either
    way along that line, and does: the spool's thread crest came back as seven
    faces with the axis down and one with it up, on the same line, at the same
    radius, all seven of them one wall. Comparing the stored directions rejected
    the odd one out and the wall picked in two pieces.

    Sign taken from the first component that is meaningfully non-zero, so the
    choice is stable for any axis and does not turn over on a rounding wobble."""
    for c in d:
        if abs(c) > ANG_TOL:
            return d if c > 0 else (-d[0], -d[1], -d[2])
    return d


def _outward_at_middle(face):
    """(point, unit normal) at the face's parametric middle, its own orientation
    already applied — so this is the direction the MATERIAL side faces, not the
    direction the underlying surface happens to be parametrised in.

    Returns None when the face has no usable normal there."""
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.gp import gp_Pnt, gp_Vec

    props = BRepGProp_Face(face.wrapped)
    u0, u1, v0, v1 = props.Bounds()
    pnt, vec = gp_Pnt(), gp_Vec()
    props.Normal((u0 + u1) / 2.0, (v0 + v1) / 2.0, pnt, vec)
    n = (vec.X(), vec.Y(), vec.Z())
    m = _norm(n)
    if m <= 0.0:
        return None
    return ((pnt.X(), pnt.Y(), pnt.Z()), (n[0] / m, n[1] / m, n[2] / m))


def _radial_side(face, direction, location):
    """+1 when the face's outward normal points AWAY from the axis (a shaft),
    -1 when it points at it (a bore), 0 when it cannot be told.

    This replaces asking whether the FACE is reversed, which is only half the
    question: a reversed face on an axis stored one way and a forward face on the
    same axis stored the other way are the same side of the same wall, and the
    reversed flag alone calls them opposites. Measuring the normal answers the
    question that was actually being asked — which side is solid — without
    caring how the surface underneath got written down."""
    got = _outward_at_middle(face)
    if got is None:
        return 0.0
    point, normal = got
    rel = _sub(point, location)
    along = _dot(rel, direction)
    radial = _sub(rel, tuple(c * along for c in direction))
    m = _norm(radial)
    if m <= LIN_TOL:
        return 0.0
    radial = (radial[0] / m, radial[1] / m, radial[2] / m)
    return 1.0 if _dot(normal, radial) > 0.0 else -1.0


def surface_of(face):
    """The face's surface as a comparable description, with its own outward side
    baked in, or None when it is a kind this module will not judge.

    Returned as (kind, ...) where every remaining member is a float or a tuple of
    floats, so `same_surface` is arithmetic and nothing here holds a kernel
    handle past the call."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType as T
    from OCP.TopAbs import TopAbs_Orientation

    ad = BRepAdaptor_Surface(face.wrapped)
    kind = ad.GetType()
    # A REVERSED face uses the other side of the same surface. Folding that into
    # the description is what keeps a bore apart from the shaft around it.
    flip = -1.0 if face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED else 1.0

    def xyz(p):
        return (p.X(), p.Y(), p.Z())

    if kind == T.GeomAbs_Plane:
        pl = ad.Plane()
        d = xyz(pl.Axis().Direction())
        n = tuple(c * flip for c in d)
        return ("plane", n, _dot(n, xyz(pl.Axis().Location())))
    if kind == T.GeomAbs_Cylinder:
        cy = ad.Cylinder()
        ax = cy.Axis()
        # The axis SIGN is not part of the identity (see _canon_dir) and neither
        # is the reversed flag on its own (see _radial_side): both are how the
        # kernel wrote the surface down, not which side of it is solid.
        d = _canon_dir(xyz(ax.Direction()))
        loc = xyz(ax.Location())
        return ("cylinder", d, loc, cy.Radius(), _radial_side(face, d, loc))
    if kind == T.GeomAbs_Cone:
        co = ad.Cone()
        ax = co.Axis()
        return ("cone", xyz(ax.Direction()), xyz(co.Apex()), co.SemiAngle(), flip)
    if kind == T.GeomAbs_Sphere:
        sp = ad.Sphere()
        return ("sphere", xyz(sp.Location()), sp.Radius(), flip)
    if kind == T.GeomAbs_Torus:
        to = ad.Torus()
        ax = to.Axis()
        return ("torus", xyz(ax.Direction()), xyz(ax.Location()),
                to.MajorRadius(), to.MinorRadius(), flip)
    return None


def same_surface(a, b):
    """Do these two descriptions name one surface, seen from the same side?"""
    if a is None or b is None or a[0] != b[0]:
        return False
    kind = a[0]
    if kind == "plane":
        return _same_dir(a[1], b[1]) and abs(a[2] - b[2]) <= LIN_TOL
    if kind == "cylinder":
        return (a[4] == b[4] and abs(a[3] - b[3]) <= LIN_TOL
                and _same_dir(a[1], b[1]) and _on_axis(a[2], b[2], a[1]))
    if kind == "cone":
        return (a[4] == b[4] and abs(a[3] - b[3]) <= ANG_TOL
                and _same_dir(a[1], b[1]) and _norm(_sub(a[2], b[2])) <= LIN_TOL)
    if kind == "sphere":
        return (a[3] == b[3] and abs(a[2] - b[2]) <= LIN_TOL
                and _norm(_sub(a[1], b[1])) <= LIN_TOL)
    if kind == "torus":
        return (a[5] == b[5] and abs(a[3] - b[3]) <= LIN_TOL
                and abs(a[4] - b[4]) <= LIN_TOL and _same_dir(a[1], b[1])
                and _norm(_sub(a[2], b[2])) <= LIN_TOL)
    return False


def _adjacent_pairs(shape, faces):
    """Every pair of face indices that share an edge, once each."""
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    # The kernel's own edge -> owning-faces map: shared edges are shared TShapes,
    # so this is exact where hashing vertex coordinates would only be close.
    amap = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, amap)
    where = {}
    for i, f in enumerate(faces):
        where.setdefault(f.wrapped.TShape(), []).append(i)
    seen = set()
    for i in range(1, amap.Extent() + 1):
        owners = []
        for f in amap.FindFromIndex(i):
            owners.extend(where.get(f.TShape(), ()))
        for a in range(len(owners)):
            for b in range(a + 1, len(owners)):
                lo, hi = sorted((owners[a], owners[b]))
                if lo != hi:
                    seen.add((lo, hi))
    return seen


def _bucket(desc):
    """A hashable, deliberately COARSE key for a surface description.

    Only used to keep the near-pair search from being every-face-against-every-
    face: two faces can only be near-joined if they land in the same bucket, and
    `same_surface` still decides. Rounded, so a pair separated by the last bits
    of a double lands together and is judged properly rather than being dropped
    here."""
    def flat(x):
        if isinstance(x, (tuple, list)):
            for y in x:
                yield from flat(y)
        elif isinstance(x, float):
            yield round(x, 6)
        else:
            yield x
    return tuple(flat(desc))


def gap_tolerance(shape):
    """How wide a gap may still count as touching, for this body."""
    try:
        bb = shape.bounding_box()
        diag = _norm((bb.max.X - bb.min.X, bb.max.Y - bb.min.Y, bb.max.Z - bb.min.Z))
    except Exception:
        diag = 0.0
    return max(GAP_ABS, GAP_REL * diag)


def _near_pairs(faces, surf, tol, already):
    """Same-surface faces that come within `tol` of each other without sharing an
    edge — the kernel's own clearance standing where an edge would be.

    Bucketed by surface first and screened by bounding box second, so the only
    pairs that reach the real distance call are ones already known to be on one
    surface and within a hair of each other. On every shape that has no such
    pair — which is nearly all of them — this costs one bounding box per face."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    buckets = {}
    for i, d in surf.items():
        if d is not None:
            buckets.setdefault(_bucket(d), []).append(i)
    out = set()
    for group in buckets.values():
        if len(group) < 2:
            continue
        boxes = {}
        for i in group:
            try:
                boxes[i] = faces[i].bounding_box()
            except Exception:
                pass
        for a in range(len(group)):
            for b in range(a + 1, len(group)):
                i, j = group[a], group[b]
                lo, hi = (i, j) if i < j else (j, i)
                if (lo, hi) in already:
                    continue
                bi, bj = boxes.get(i), boxes.get(j)
                if bi is None or bj is None:
                    continue
                if (bi.min.X > bj.max.X + tol or bj.min.X > bi.max.X + tol
                        or bi.min.Y > bj.max.Y + tol or bj.min.Y > bi.max.Y + tol
                        or bi.min.Z > bj.max.Z + tol or bj.min.Z > bi.max.Z + tol):
                    continue
                if not same_surface(surf[i], surf[j]):
                    continue
                try:
                    d = BRepExtrema_DistShapeShape(faces[i].wrapped, faces[j].wrapped)
                    d.Perform()
                    if d.IsDone() and d.Value() <= tol:
                        out.add((lo, hi))
                except Exception:
                    pass
    return out


def face_bands(shape):
    """The runs of two or more faces that are pieces of one surface.

    Returns a list of sorted face-index lists, indexed the way `shape.faces()` is
    and ordered by their first member, so the result is stable across calls and
    can be compared in a test. A shape with nothing split returns []."""
    try:
        faces = shape.faces()
    except Exception:
        return []
    if len(faces) < 2 or len(faces) > MAX_BAND_FACES:
        return []
    try:
        pairs = _adjacent_pairs(shape, faces)
        # Every face, not only the ones an edge already joins: a run separated by
        # the sweep's own clearance has no shared edge anywhere along it, so the
        # old shortcut of asking only about edge-joined faces could never see it.
        surf = {i: surface_of(f) for i, f in enumerate(faces)}
        pairs = pairs | _near_pairs(faces, surf, gap_tolerance(shape), pairs)
        if not pairs:
            return []
        wanted = {i for pair in pairs for i in pair}
    except Exception:
        return []

    parent = list(range(len(faces)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for lo, hi in pairs:
        if same_surface(surf.get(lo), surf.get(hi)):
            a, b = find(lo), find(hi)
            if a != b:
                parent[max(a, b)] = min(a, b)

    runs = {}
    for i in wanted:
        runs.setdefault(find(i), []).append(i)
    return sorted((sorted(v) for v in runs.values() if len(v) > 1),
                  key=lambda v: v[0])
