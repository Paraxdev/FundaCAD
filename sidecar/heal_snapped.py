"""Heal round faces that an older import snapped into a shape the mesher cannot draw.

Before the mesh gate in `mesh_import._canonicalize`, a closed spline band could be
snapped to a cone or cylinder with malformed pcurves. The face passes BRepCheck and
keeps its area, but OCCT meshes a region that is not the face, and that face is
baked into every blob imported back then. Measured on a spike tip: 81 of the band's
155 triangles faced inward and lay flat in the plane of the top cap, so the tip
floated clear of the part.

Only the shape that failure takes is healed, a full turn band between two
parallels, which its surface and V range rebuild exactly. Anything else, or any
doubt about the rebuilt solid, keeps the stored shape as it is.
"""

import sys

import geomstore

# Bump when the verdict for an unchanged blob could change, the cached verdicts
# are keyed by it and outlive sidecar code changes on purpose.
HEAL_VERSION = 1

# Planes are left out: the failure needs a seam for the re-projection to land on.
_ROUND = ("GeomAbs_Cylinder", "GeomAbs_Cone", "GeomAbs_Sphere", "GeomAbs_Torus")

_SAMPLES = 9

_CLEAN = b""

_memo = {}


def _kind(face):
    from OCP.BRepAdaptor import BRepAdaptor_Surface

    return BRepAdaptor_Surface(face).GetType().name


def face_meshes(face):
    """`_conversion_meshes` on a topology copy. Meshing the stored face itself would
    leave its coarse check triangulation behind for the viewport to reuse."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
    from OCP.TopoDS import TopoDS

    from mesh_import import _conversion_meshes

    try:
        return _conversion_meshes(TopoDS.Face_s(BRepBuilderAPI_Copy(face, False, False).Shape()))
    except Exception:  # noqa: BLE001
        return False


def _faces(shape):
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        out.append(TopoDS.Face_s(exp.Current()))
        exp.Next()
    return out


def failing_faces(shape):
    """The round faces of `shape` that do not mesh."""
    return [f for f in _faces(shape) if _kind(f) in _ROUND and not face_meshes(f)]


def _area(face):
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    g = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, g)
    return g.Mass()


def rebuild_band(face):
    """`face` rebuilt as a clean full turn on its own surface, with `(face, sewing
    tolerance)`, or None when it is not a band between two parallels."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.BRepTools import BRepTools
    from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_WIRE
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopoDS import TopoDS

    try:
        if _kind(face) not in _ROUND:
            return None
        surf = BRep_Tool.Surface_s(face)
        if not surf.IsUPeriodic():
            return None
        wires = TopExp_Explorer(face, TopAbs_WIRE)
        wires.Next()
        if wires.More():
            return None

        v_period = surf.VPeriod() if surf.IsVPeriodic() else None
        _u0, _u1, bv0, bv1 = BRepTools.UVBounds_s(face)
        v_mid = 0.5 * (bv0 + bv1)

        def project(p):
            pr = GeomAPI_ProjectPointOnSurf(p, surf)
            if pr.NbPoints() == 0:
                raise ValueError("a boundary point does not project onto the surface")
            u, v = pr.LowerDistanceParameters()
            if v_period:
                v += v_period * round((v_mid - v) / v_period)
            return u, v, pr.LowerDistance()

        seam, rims, tol = None, [], 1e-4
        exp = TopExp_Explorer(face, TopAbs_EDGE)
        while exp.More():
            e = TopoDS.Edge_s(exp.Current())
            exp.Next()
            if BRep_Tool.Degenerated_s(e):
                return None
            tol = max(tol, 2.0 * BRep_Tool.Tolerance_s(e))
            if BRep_Tool.IsClosed_s(e, face):
                seam = e
            else:
                rims.append(e)
        if seam is None or not rims:
            return None

        u_seam = project(BRep_Tool.Pnt_s(TopExp.FirstVertex_s(seam)))[0]
        levels = []
        for e in rims:
            level = 0.5 * (project(BRep_Tool.Pnt_s(TopExp.FirstVertex_s(e)))[1]
                           + project(BRep_Tool.Pnt_s(TopExp.LastVertex_s(e)))[1])
            c = BRepAdaptor_Curve(e)
            a, b = c.FirstParameter(), c.LastParameter()
            for k in range(_SAMPLES):
                p = c.Value(a + (b - a) * k / (_SAMPLES - 1))
                u, _v, d = project(p)
                if d > tol or surf.Value(u, level).Distance(p) > tol:
                    return None
            levels.append(level)
        lo, hi = min(levels), max(levels)
        if surf.Value(u_seam, lo).Distance(surf.Value(u_seam, hi)) <= tol:
            return None
        for x in levels:
            p = surf.Value(u_seam, x)
            if min(p.Distance(surf.Value(u_seam, lo)), p.Distance(surf.Value(u_seam, hi))) > tol:
                return None

        # MakeFace only closes the seam for the surface's own [0, period] range, and
        # the seam must stay where the neighbours' vertices are, so the surface is
        # turned about its axis to put u = 0 on the old seam.
        seam_pnt = BRep_Tool.Pnt_s(TopExp.FirstVertex_s(seam))
        turned = None
        for angle in (u_seam, -u_seam):
            s = surf.Copy()
            s.Rotate(surf.Axis(), angle)
            if s.Value(0.0, project(seam_pnt)[1]).Distance(seam_pnt) <= tol:
                turned = s
                break
        if turned is None:
            return None
        mf = BRepBuilderAPI_MakeFace(turned, 0.0, turned.UPeriod(), lo, hi, 1e-7)
        if not mf.IsDone():
            return None
        new = mf.Face()
        new.Orientation(face.Orientation())
        a_old = _area(face)
        if abs(_area(new) - a_old) > max(1e-6, 0.005 * abs(a_old)):
            return None
        return new, tol
    except Exception:  # noqa: BLE001, a face that cannot be measured is left alone
        return None


def heal_solid(solid):
    """`(healed solid or None, faces that fail and could not be rebuilt)`.

    The solid comes back only when it is valid, keeps its faces in their stored
    order and count, keeps its volume within the import gate's tolerance, and has
    no failing face left but the ones reported."""
    from build123d import Solid
    from OCP.BRep import BRep_Builder
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.TopAbs import TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS_Shell

    from mesh_import import _canonical_ok

    bad = failing_faces(solid)
    if not bad:
        return None, 0
    rebuilt, tol = [], 0.0
    for f in bad:
        r = rebuild_band(f)
        if r is not None:
            rebuilt.append((f, r[0]))
            tol = max(tol, r[1])
    stuck = len(bad) - len(rebuilt)
    if not rebuilt:
        return None, stuck
    try:
        shells = TopExp_Explorer(solid, TopAbs_SHELL)
        shells.Next()
        if shells.More():
            return None, len(bad)

        originals = _faces(solid)
        replaced = []
        for f in originals:
            swap = next((new for old, new in rebuilt if old.IsSame(f)), None)
            replaced.append(swap if swap is not None else f)
        sew = BRepBuilderAPI_Sewing(tol)
        for f in replaced:
            sew.Add(f)
        sew.Perform()
        if sew.NbFreeEdges() or sew.NbMultipleEdges():
            return None, len(bad)
        sewn = sew.SewedShape()
        if sewn.ShapeType().name != "TopAbs_SHELL":
            return None, len(bad)

        # Sewing reorders faces, and downstream features address imported faces by
        # their position, so the shell is reassembled in the stored order.
        sewn_faces = _faces(sewn)
        builder = BRep_Builder()
        shell = TopoDS_Shell()
        builder.MakeShell(shell)
        for f in replaced:
            m = sew.Modified(f)
            match = next((s for s in sewn_faces if s.IsSame(m)), None)
            if match is None:
                return None, len(bad)
            builder.Add(shell, match)
        healed = Solid(ShapeFix_Solid().SolidFromShell(shell))
        before = Solid(solid)
        if not _canonical_ok(healed, before):
            return None, len(bad)
        if len(failing_faces(healed.wrapped)) != stuck:
            return None, len(bad)
        return healed.wrapped, stuck
    except Exception:  # noqa: BLE001, any doubt keeps the stored solid
        return None, len(bad)


def heal_shape(shape):
    """`(shape, healed solids, faces left failing)`. `shape` comes back as the very
    same object when nothing was healed. Compounds are rebuilt only along the
    branches that changed, in the stored child order, and a solid shared by
    several instances is healed once."""
    from OCP.BRep import BRep_Builder
    from OCP.TopAbs import TopAbs_FORWARD
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS_Compound, TopoDS_Iterator

    from progress import progress_tick

    done = {}
    totals = [0, 0]

    def visit(s):
        kind = s.ShapeType().name
        if kind == "TopAbs_SOLID":
            bare = s.Located(TopLoc_Location()).Oriented(TopAbs_FORWARD)
            key = hash(bare)
            hit = next((h for b, h in done.get(key, ()) if b.IsSame(bare)), False)
            if hit is False:
                progress_tick()
                healed, stuck = heal_solid(bare)
                done.setdefault(key, []).append((bare, healed))
                totals[0] += healed is not None
                totals[1] += stuck
                hit = healed
            if hit is None:
                return s
            out = hit.Located(s.Location())
            out.Orientation(s.Orientation())
            return out
        if kind not in ("TopAbs_COMPOUND", "TopAbs_COMPSOLID"):
            return s
        children, changed = [], False
        it = TopoDS_Iterator(s, False, False)
        while it.More():
            c = it.Value()
            n = visit(c)
            changed |= n is not c
            children.append(n)
            it.Next()
        if not changed:
            return s
        comp = TopoDS_Compound()
        b = BRep_Builder()
        b.MakeCompound(comp)
        for c in children:
            b.Add(comp, c)
        comp.Location(s.Location())
        comp.Orientation(s.Orientation())
        return comp

    result = visit(shape)
    return result, totals[0], totals[1]


def _verdict_key(digest):
    return "%s-%d" % (digest, HEAL_VERSION)


def _load_verdict(digest):
    if digest in _memo:
        return _memo[digest]
    import rebuild_cache

    store = rebuild_cache._disk_store()
    return store.get_mesh(_verdict_key(digest)) if store is not None else None


def _save_verdict(digest, data):
    _memo[digest] = data
    import rebuild_cache

    store = rebuild_cache._disk_store()
    if store is not None:
        try:
            store.put_mesh(_verdict_key(digest), data)
        except OSError:
            pass


def heal_stored(digest, shape):
    """The stored import `shape` (a TopoDS_Shape) with its broken bands healed.

    The verdict is cached per blob hash, in memory and next to the mesh artifacts,
    so a document pays for the scan once: an empty entry means the blob is fine as
    stored, anything else is the healed shape's bytes."""
    verdict = _load_verdict(digest)
    if verdict == _CLEAN:
        _memo[digest] = _CLEAN
        return shape
    if verdict is not None:
        try:
            healed = geomstore.deserialize_shape(verdict)
            _memo[digest] = verdict
            return healed
        except Exception:  # noqa: BLE001, a bad cache entry is only a miss
            pass
    try:
        healed, solids, stuck = heal_shape(shape)
    except Exception:  # noqa: BLE001
        return shape
    if stuck:
        print(f"[heal] blob {digest}: {stuck} face(s) do not mesh and are not a band "
              f"that can be rebuilt, left as stored", file=sys.stderr, flush=True)
    if healed is shape:
        _save_verdict(digest, _CLEAN)
        return shape
    print(f"[heal] blob {digest}: rebuilt broken faces in {solids} solid(s)",
          file=sys.stderr, flush=True)
    _save_verdict(digest, geomstore.serialize_shape(healed))
    return healed
