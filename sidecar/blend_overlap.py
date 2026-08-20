"""A blend that folded back over itself.

The report was a saved document whose model "flashes triangles and just isn't
quite right". Nothing was missing from it: the solid was closed, every edge was
shared by exactly two faces, every triangle had area, and BRepCheck_Analyzer
called it valid. What it had instead was three faces from ONE fillet lying on
top of each other over about a square millimetre. Measured: 21% to 59% of each
of those faces sits within a micron of another, while the tangent junction next
to it, built by the same code, scores 0.0%. A depth buffer resolves roughly a
micron at an ordinary camera distance, so the doubled patch has no stable answer
to "which surface is in front" and flips between them as the view moves.

This is the same lesson this codebase keeps arriving at from new directions, so
it is worth stating plainly: VALIDITY IS NOT DRAWABILITY. A solid can be
topologically sound, tolerance-tight and seam-correct and still be a shape
nobody asked for.

WHAT IS MEASURED. The faces the blend MADE, and only those: a blend puts surface
where it ran, so surface doubled among its own new faces is that blend's doing
and nobody else's, which settles attribution without any comparison to what came
before. They are tessellated and each triangle asked whether its centre lies
within a micron of a triangle of another of them, pointing the same way (or
exactly opposite, which contests the depth buffer just as hard). The area that
does is the answer.

WHY THE DISTANCE IS TO THE TRIANGLE AND NOT TO ITS PLANE. Every fillet on a
model ends in a tangent junction, where two faces lie in each other's planes
along the join. A plane distance calls that coincident and would report every
sound blend ever built. Clamped to the triangle, a tangent junction measures
0.0000 mm2 and the folded blend measures 0.05, which is the separation the
guard rests on.

WHY BRepAlgoAPI_Check IS NOT USED. It was, first, as a cheap screen in front of
the measurement, and it is wrong in both directions. On the reported document it
flagged a second fillet that had folded nothing; on a reduction of the same
shape built from primitives it reported the genuinely folded blend as clean.
Asking the whole body instead does not rescue it: the analyser calls a
mid-timeline body self-intersecting well before the offending fillet runs, while
a build TRUNCATED at that same feature comes back clean, because the tidy-up
passes at the end of a rebuild resolve it. A mid-timeline body is not a thing
that test can be asked about, in either direction. The measurement needs no
screen: it costs about ten milliseconds on the faces one blend makes.
"""

from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS, TopoDS_Compound
from OCP.TopTools import TopTools_MapOfShape

# How close two pieces of surface have to be before a depth buffer stops telling
# them apart. A micron is what it resolves at an ordinary camera distance with
# the near and far planes the viewport uses.
COINCIDENT_MM = 0.001

# How nearly parallel they have to be to count. Surfaces that lie on each other
# and point the same way (or exactly opposite ways, which fights just as hard)
# are the case; two faces crossing at an angle are an intersection, which is a
# different defect and not this one's to report.
PARALLEL_DOT = 0.9995

# How much doubled surface makes a fold rather than an artefact at a shared
# boundary. Every sound blend measured, on the reported document and on the
# reduction built from primitives, comes out at exactly 0.0000; the folded ones
# come out at 0.05 and up. A hundredth of a square millimetre sits five times
# under the smallest real one and above nothing at all.
FOLD_AREA_MM2 = 0.01

# Triangle size for the measurement, and COARSE ON PURPOSE. Finer is not safer
# here: at 0.02mm the sound reduction started reporting 0.038 mm2, because small
# triangles crowd close enough to a tangent junction that their centres really
# are within a micron of the neighbouring face. At 0.05mm and above it reports
# zero while the fold still reports 0.05, so the useful range starts where the
# triangles are bigger than the band a tangency is coincident over.
MEASURE_DEFLECTION_MM = 0.1


def _raw(shape):
    """The TopoDS underneath, whether a build123d wrapper or a bare shape came
    in. Both reach this module: the plain blend path hands back build123d
    objects and the conic path rebuilds raw topology."""
    return shape.wrapped if hasattr(shape, "wrapped") else shape


def faces_of(shape):
    out = []
    exp = TopExp_Explorer(_raw(shape), TopAbs_FACE)
    while exp.More():
        out.append(TopoDS.Face_s(exp.Current()))
        exp.Next()
    return out


def new_faces(before, after):
    """The faces `after` has that `before` did not.

    Identity, not geometry: OCCT leaves the faces a blend never touched SHARED
    between the two shapes, so IsSame separates what the operation made from
    what it merely carried through. A conic blend rebuilds more of the solid
    than a plain one does and so reports more new faces, which costs a little
    more to check and is not wrong."""
    old = TopTools_MapOfShape()
    for f in faces_of(before):
        old.Add(f)
    return [f for f in faces_of(after) if not old.Contains(f)]


def _compound(faces):
    comp = TopoDS_Compound()
    b = BRep_Builder()
    b.MakeCompound(comp)
    for f in faces:
        b.Add(comp, f)
    return comp


def folds_over_itself(before, after):
    """True when the operation that turned `before` into `after` left surface
    lying on top of surface.

    Any failure to decide is a False. A measurement that raised has not found a
    fold, and a guard that read "could not tell" as "broken" would refuse sound
    work in a way nobody would ever notice, because it would look exactly like
    the operation being hard."""
    try:
        fresh = new_faces(before, after)
        if not fresh:
            return False
        return doubled_area(fresh) > FOLD_AREA_MM2
    except Exception:  # noqa: BLE001
        return False


def _triangles(faces):
    """Every face's triangles in world coordinates, as
    (face index, centroid, unit normal, area).

    Meshed here rather than read off the body: this runs mid-rebuild, where the
    body has no tessellation yet, and only a few faces are ever involved.

    On a COPY, and this is not tidiness. A triangulation is stored ON the face,
    and BRepMesh leaves an existing one alone rather than replacing it with a
    finer one, so meshing the body's own faces here would decide the mesh the
    viewport gets later. Measured the hard way: the deflection argument had no
    effect at all until the copy went in, because the faces already carried a
    triangulation from an earlier pass."""
    comp = BRepBuilderAPI_Copy(_compound(faces)).Shape()
    BRepTools.Clean_s(comp)
    BRepMesh_IncrementalMesh(comp, MEASURE_DEFLECTION_MM, False, 0.5, True)
    out = []
    for fi, face in enumerate(faces_of(comp)):
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue
        trsf = loc.Transformation()
        pts = []
        for i in range(1, tri.NbNodes() + 1):
            p = tri.Node(i).Transformed(trsf)
            pts.append((p.X(), p.Y(), p.Z()))
        for i in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(i).Get()
            pa, pb, pc = pts[a - 1], pts[b - 1], pts[c - 1]
            u = [pb[k] - pa[k] for k in range(3)]
            v = [pc[k] - pa[k] for k in range(3)]
            n = [u[1] * v[2] - u[2] * v[1],
                 u[2] * v[0] - u[0] * v[2],
                 u[0] * v[1] - u[1] * v[0]]
            ln = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) ** 0.5
            if ln <= 0:
                continue  # a degenerate triangle has no plane to compare against
            out.append((fi,
                        [(pa[k] + pb[k] + pc[k]) / 3 for k in range(3)],
                        [x / ln for x in n],
                        ln / 2,
                        (pa, pb, pc)))
    return out


def _point_to_triangle(q, tri):
    """Distance from a point to a triangle, clamped to the triangle rather than
    measured to its infinite plane.

    The clamping is the whole reason this is not a plane distance. Two faces
    that merely meet TANGENTIALLY lie in each other's planes near the join, so a
    plane distance calls a wide band of a sound fillet coincident; a point that
    is not over the other triangle at all has to come out far, or the guard
    reports every tangent junction on the model."""
    a, b, c = tri
    ab = [b[i] - a[i] for i in range(3)]
    ac = [c[i] - a[i] for i in range(3)]
    ap = [q[i] - a[i] for i in range(3)]
    d1 = sum(ab[i] * ap[i] for i in range(3))
    d2 = sum(ac[i] * ap[i] for i in range(3))
    if d1 <= 0 and d2 <= 0:
        return sum((q[i] - a[i]) ** 2 for i in range(3)) ** 0.5
    bp = [q[i] - b[i] for i in range(3)]
    if sum(ab[i] * bp[i] for i in range(3)) >= 0 >= sum(ac[i] * bp[i] for i in range(3)):
        return sum((q[i] - b[i]) ** 2 for i in range(3)) ** 0.5
    cp = [q[i] - c[i] for i in range(3)]
    if sum(ac[i] * cp[i] for i in range(3)) >= 0 >= sum(ab[i] * cp[i] for i in range(3)):
        return sum((q[i] - c[i]) ** 2 for i in range(3)) ** 0.5
    n = [ab[1] * ac[2] - ab[2] * ac[1],
         ab[2] * ac[0] - ab[0] * ac[2],
         ab[0] * ac[1] - ab[1] * ac[0]]
    ln = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) ** 0.5
    if ln <= 0:
        return sum((q[i] - a[i]) ** 2 for i in range(3)) ** 0.5
    return abs(sum(n[i] * ap[i] for i in range(3))) / ln


def doubled_area(faces):
    """How much of these faces' area lies on another one of them, in mm2.

    A triangle counts as doubled when its centre lies within a micron of a
    triangle of ANOTHER of these faces, and the two point the same way (or
    exactly opposite ways, which fights the depth buffer just as hard). Crossing
    at an angle is a different defect and not this one's to report.

    A tangent junction scores zero here, which is the whole point, and it is why
    the distance is to the triangle rather than to its plane: two faces that
    merely meet smoothly lie in each other's planes along the join and pull
    apart quadratically away from it, so no centre on one lands ON a triangle of
    the other."""
    tris = _triangles(faces)
    if not tris:
        return 0.0
    cell = 0.25
    grid = {}
    for idx, t in enumerate(tris):
        c = t[1]
        key = (int(c[0] // cell), int(c[1] // cell), int(c[2] // cell))
        grid.setdefault(key, []).append(idx)
    doubled = 0.0
    for fi, ci, ni, ai, _pts in tris:
        key = (int(ci[0] // cell), int(ci[1] // cell), int(ci[2] // cell))
        hit = False
        for dx in (-1, 0, 1):
            if hit:
                break
            for dy in (-1, 0, 1):
                if hit:
                    break
                for dz in (-1, 0, 1):
                    if hit:
                        break
                    for j in grid.get((key[0] + dx, key[1] + dy, key[2] + dz), ()):
                        fj, _cj, nj, _aj, ptsj = tris[j]
                        if fj == fi:
                            continue
                        if abs(sum(ni[k] * nj[k] for k in range(3))) < PARALLEL_DOT:
                            continue
                        if _point_to_triangle(ci, ptsj) <= COINCIDENT_MM:
                            hit = True
                            break
        if hit:
            doubled += ai
    return doubled
