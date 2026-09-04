"""Operations that take a solid and hand back a changed solid.

Split out of builder.py. Everything here is the KERNEL CALL a feature makes,
with the guards that keep OCCT from being asked something it will answer badly:
shelling, drafting, patterning, and the whole push-a-face family (press/pull,
offset, thicken, and the swept fallback for a face that offsetting cannot
handle). No feature dicts, no bodies list, no diagnostics — those stay with the
handlers in builder.py, which is what makes this half testable on a bare shape.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import (
    Compound,
    GeomType,
    Kind,
    Pos,
    Rot,
    Solid,
    extrude,
    offset,
)

from shape_util import _as_compound, _wrap_topods, _wrapped_or_none
from topo_adj import face_wraps

def _simplify_mesh(shape, tol_deg):
    """Merge near-coplanar facets of an imported mesh into fewer, larger faces
    (OCCT UnifySameDomain with a widened angular tolerance). Recovers planar faces
    from imperfect/dense meshes and tames facet count. NOTE: this COARSENS curved
    regions (a faceted cylinder becomes coarser planar strips) — it does not
    reconstruct true smooth surfaces; that's RANSAC surface fitting (deferred)."""
    import math
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

    up = ShapeUpgrade_UnifySameDomain(shape.wrapped, True, True, True)
    if tol_deg and tol_deg > 0:
        up.SetAngularTolerance(math.radians(tol_deg))
    up.Build()
    return _wrap_topods(up.Shape()) or shape


def _shell(shape, thickness, openings):
    """Hollow a solid to a wall `thickness`, removing `openings` faces (empty =
    a fully closed hollow). Sharp corners use the Intersection join."""
    amt = -abs(thickness)  # negative = hollow inward
    try:
        if openings:
            return offset(shape, amount=amt, openings=list(openings), kind=Kind.INTERSECTION)
        return offset(shape, amount=amt, kind=Kind.INTERSECTION)
    except Exception as ex:
        # A wall thicker than the solid's own narrowest span has nowhere to go;
        # OCCT surfaces that as a bare RuntimeError, which told the user nothing
        # about the one number they need to change.
        raise ValueError(
            f"Shell failed with a wall of {abs(thickness):g}mm — this is usually "
            "thicker than the body's narrowest span; try a smaller thickness. "
            f"[{type(ex).__name__}]"
        )


def _rot_for(axis, deg):
    """A build123d Rotation of `deg` degrees about the named global axis."""
    if axis == "X":
        return Rot(deg, 0, 0)
    if axis == "Y":
        return Rot(0, deg, 0)
    return Rot(0, 0, deg)


def _fuse_pattern_cells(cells):
    """Union pattern cells. Bbox-DISJOINT cells (the common grid) need no
    boolean at all: bbox-disjoint ⇒ solid-disjoint, and fusing disjoint solids
    yields exactly the compound of them — the old incremental `result + cell`
    chain spent O(n²) full booleans + UnifySameDomain per cell to produce that
    (measured 1.8s → ~0 on a 10x10 grid). OVERLAPPING cells keep the
    incremental chain: one N-tool fuse of mutually-overlapping solids measured
    ~3x SLOWER than the chain (each chain step collapses the intermediate to
    one solid, shrinking later steps). Touching-exactly counts as overlapping
    (tolerance guard) so shared faces still merge like before."""
    if len(cells) == 1:
        return cells[0]
    tol = 1e-6
    boxes = [c.bounding_box() for c in cells]
    disjoint = all(
        a.max.X < b.min.X - tol or b.max.X < a.min.X - tol
        or a.max.Y < b.min.Y - tol or b.max.Y < a.min.Y - tol
        or a.max.Z < b.min.Z - tol or b.max.Z < a.min.Z - tol
        for i, a in enumerate(boxes) for b in boxes[i + 1:]
    )
    if disjoint:
        return _as_compound(cells)
    result = cells[0]
    for cell in cells[1:]:
        result = result + cell
    return result


def _pattern_rect(shape, nx, ny, dx, dy):
    """Replicate a body on an nx×ny grid (spacing dx, dy) and union the copies."""
    nx, ny = max(1, int(round(nx))), max(1, int(round(ny)))
    return _fuse_pattern_cells([Pos(i * dx, j * dy, 0) * shape for i in range(nx) for j in range(ny)])


def _pattern_linear(shape, count, spacing, axis):
    """Replicate a body `count` times at `spacing` mm along a global axis and
    union the copies. Copy 0 is the original, so a count of 3 at 20 mm reaches
    40 mm — mirrors src/features/patternMath.linearOffsets."""
    count = max(1, int(round(count)))
    # A disjoint body is a ShapeList; Pos (Location.__mul__) takes one Shape.
    # Same normalisation _handle_move makes, for the same reason.
    if shape is not None and _wrapped_or_none(shape) is None:
        shape = Compound(list(shape))
    off = {"X": (1, 0, 0), "Y": (0, 1, 0)}.get(axis, (0, 0, 1))
    return _fuse_pattern_cells(
        [Pos(i * spacing * off[0], i * spacing * off[1], i * spacing * off[2]) * shape
         for i in range(count)]
    )


def _pattern_circular(shape, count, total_angle, axis):
    """Replicate a body `count` times about a global axis spanning `total_angle`
    degrees and union the copies. A full 360° spread doesn't double the seam."""
    count = max(1, int(round(count)))
    full = abs(total_angle - 360) < 1e-6
    step = total_angle / count if full else (total_angle / (count - 1) if count > 1 else 0)
    return _fuse_pattern_cells([_rot_for(axis, k * step) * shape for k in range(count)])


def _draft(shape, faces, angle_deg, axis):
    """Taper `faces` by `angle_deg` about the line where each meets a neutral plane
    (the body's near end along the pull axis). Pull direction = +axis. Uses OCCT
    BRepOffsetAPI_DraftAngle directly (build123d has no draft wrapper)."""
    import math
    from OCP.BRepOffsetAPI import BRepOffsetAPI_DraftAngle
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt

    dirs = {"X": (1, 0, 0), "Y": (0, 1, 0), "Z": (0, 0, 1)}
    dx, dy, dz = dirs.get(axis, (0, 0, 1))
    pull = gp_Dir(dx, dy, dz)
    # neutral plane at the body's minimum along the pull axis, so faces pivot there
    bb = shape.bounding_box()
    base = {"X": bb.min.X, "Y": bb.min.Y, "Z": bb.min.Z}[axis]
    origin = gp_Pnt(base * dx, base * dy, base * dz)
    neutral = gp_Pln(origin, pull)

    drafter = BRepOffsetAPI_DraftAngle(shape.wrapped)
    ang = math.radians(angle_deg)
    for fc in faces:
        drafter.Add(fc.wrapped, pull, ang, neutral)
    drafter.Build()
    if not drafter.IsDone():
        raise ValueError("draft failed for these faces / angle")
    return _wrap_topods(drafter.Shape())


#: Curved surfaces BRepOffset can be trusted with. Analytic every one: the
#: offset of a sphere is a sphere, of a torus a torus, of a cone a cone, so the
#: kernel has a closed form and never has to approximate its way into trouble.
#:
#: A FREEFORM surface has no such form and OCCT does not fail gracefully on one.
#: Measured, in isolated subprocesses so a crash reports as a return code: a
#: swept BSPLINE face offset by +-1mm is fine, and the same face at +-8mm and
#: +-20mm dies with an access violation, in BOTH directions. That is a dead
#: worker and a lost rebuild, not an error message.
#:
#: The tempting fix is a magnitude cap, and it is the wrong one: the threshold
#: where a freeform surface stops being offsettable depends on its own local
#: curvature, which is exactly the quantity nobody has a bound for here. Being
#: wrong costs a crash, while refusing costs a message, so the asymmetry decides
#: it. This list is what has been PROVEN safe at large offsets, and anything
#: joining it should arrive the same way.
OFFSETTABLE_CURVED = (GeomType.CYLINDER, GeomType.CONE, GeomType.SPHERE, GeomType.TORUS)


def _press_pull(part, face, d, clamp=True):
    """Push/pull a single solid face by signed distance `d` (mm): +d grows the body
    (boss), -d cuts inward (pocket). `clamp=False` skips the inward-push safety
    cap: the up-to-surface path computes an EXACT distance to a user-chosen
    target, and capping at 90% of local thickness silently stopped short.

    PLANAR faces extrude the face region into a prism and boolean it (union for +d,
    subtract for -d). This is far more robust than a local surface offset
    (BRepOffset), which SEGFAULTs on faceted / split imported faces — and it handles
    holed faces fine in practice. Every CURVED face goes through the local offset
    (_offset_faces), which is what resizes a hole, a boss or a blend cleanly.

    Curved faces used to be restricted to cylinders, which rejected work the
    kernel does perfectly well — most importantly a TORUS, which is what a fillet
    on a round edge is, i.e. exactly the face someone reaches for after blending
    a part. The permitted set is now every ANALYTIC surface (OFFSETTABLE_CURVED),
    each measured safe in an isolated subprocess at offsets up to +-20mm.

    FREEFORM faces sweep instead (_sweep_press_pull). They must never reach the
    offset — it does not fail on them, it crashes the worker, and a small offset
    on a BSPLINE works, which is precisely what makes a magnitude cap look
    sufficient when it is not. Sweeping is a weaker operation but a robust one,
    and a weaker answer beats a refusal.

    Separately, _offset_faces now validates its own result, which is a guarantee
    the old whitelist never gave: a cylinder could always be offset into an
    invalid solid, and IsDone() did not notice.
    """
    if abs(d) < 1e-9:
        return part
    try:
        gt = face.geom_type
    except Exception:
        gt = None
    if gt == GeomType.PLANE:
        # A lone mesh facet (a tiny planar triangle on a dense imported body):
        # reject cleanly rather than extrude a degenerate sliver.
        try:
            if len(part.faces()) > 300 and face.area < 1.0:
                raise ValueError(
                    "can't press/pull this region — it's a single mesh facet, not a "
                    "clean face (the imported body is faceted, not prismatic)"
                )
        except ValueError:
            raise
        except Exception:
            pass
        dd = _clamp_planar(part, face, d) if clamp else d  # cap an inward push so it can't go through
        if abs(dd) < 1e-9:
            return part
        prism = extrude(face, dd)  # +dd outward (boss), -dd inward (pocket)
        return (part + prism) if dd > 0 else (part - prism)
    # Curved. The radius cap applies only where a radius is what runs out: pushing
    # a cylinder or a cone inward past its own axis collapses it, and OCCT does
    # not survive that gracefully.
    # Analytic curves get the REAL offset first — it is what resizes a hole, a
    # boss or a blend properly — and the sweep only if that refuses. Freeform
    # faces go straight to the sweep: the offset does not fail on them, it
    # crashes the worker, so it must never be tried.
    if gt in OFFSETTABLE_CURVED:
        dd = _clamp_cylinder(face, d) if gt in (GeomType.CYLINDER, GeomType.CONE) else d
        try:
            return _offset_face(part, face, dd)
        except Exception:
            pass
        # Thicken the ONE face before falling back to the sweep. The sweep is a
        # linear prism and has nothing to travel along on a face that closes on
        # itself, so a hole — the commonest curved face there is — reached the
        # refusal below whenever the whole-body offset would not run.
        try:
            return _thicken_press_pull(part, face, dd)
        except Exception:
            return _sweep_press_pull(part, face, dd)
    # A face that WRAPS closes on itself, so the sweep below has no direction to
    # travel along: it produces a prism that swallows the body, and the volume
    # check catches that and refuses. That refusal is what a 360-degree revolve
    # of a non-analytic profile lands in — the commonest way to make a shape
    # this kernel cannot describe as a cylinder, cone, sphere or torus.
    #
    # Thicken follows the SURFACE, which is the operation such a face actually
    # wants, and it asks about ONE face rather than rebuilding the body the way
    # _offset_faces does. Measured, one subprocess per (shape, distance) so a
    # segfault shows up as an exit code rather than as an exception nobody
    # catches:
    #
    #                       +5    +1.5  +0.5  -0.5   -1.5   -5
    #   revolved spline     ok    ok    ok    ok     ok     ok      REVOLUTION
    #   revolved bulge      ok    ok    ok    ok     ok     ok      REVOLUTION
    #   swept tube          ok    ok    ok    CRASH  CRASH  refused BSPLINE
    #   lofted tube         ok    ok    ok    ok     ok     ok      BSPLINE
    #
    # So a surface of revolution goes both ways and a BSPLINE only outward. The
    # asymmetry is not a guess about why: it is where the measurement stops, and
    # the inward BSPLINE case keeps the refusal it already had, which is the one
    # place an access violation was ever observed. Anything joining this rule
    # should arrive the same way OFFSETTABLE_CURVED's members did.
    if _wrapped_thickenable(gt, d) and face_wraps(face):
        try:
            return _thicken_press_pull(part, face, d)
        except Exception:
            pass
    return _sweep_press_pull(part, face, d)


def _wrapped_thickenable(gt, d):
    """May a wrapping face of this surface type be thickened by this distance?"""
    if gt == GeomType.REVOLUTION:
        return True
    return gt == GeomType.BSPLINE and d > 0


def _distance_to_target(src_face, target_pt, target_n):
    """Signed distance to extrude `src_face` along its own normal so it lands on the
    target plane (a point `target_pt` on it + its normal `target_n`) — i.e. "up to
    that surface". Raises if the face is parallel to the target (it never reaches).
    MVP: assumes a planar source and a planar target."""
    c, n = src_face.center(), src_face.normal_at()
    denom = n.X * target_n.X + n.Y * target_n.Y + n.Z * target_n.Z
    if abs(denom) < 1e-6:
        raise ValueError("Press/Pull: the face is parallel to the 'up to' surface — can't reach it")
    num = (target_pt.X - c.X) * target_n.X + (target_pt.Y - c.Y) * target_n.Y + (target_pt.Z - c.Z) * target_n.Z
    return num / denom


def _clamp_cylinder(face, d):
    """Cap |d| to 90% of the cylinder radius so an inward offset can't collapse the
    radius to ~0 (which segfaults OCCT)."""
    try:
        r = float(face.radius)
    except Exception:
        return d
    if r > 1e-6:
        limit = 0.9 * r
        d = max(-limit, min(limit, d))
    return d


def _clamp_planar(part, face, d):
    """For an inward push (−, toward the body), cap it to 90% of the body's extent
    along the face normal so the face can't be pushed clean through the solid."""
    if d >= 0:
        return d  # pulling outward is always safe
    try:
        n = face.normal_at()
        proj = [v.X * n.X + v.Y * n.Y + v.Z * n.Z for v in part.vertices()]
        thickness = max(proj) - min(proj)
    except Exception:
        return d
    if thickness > 1e-6:
        d = max(d, -0.9 * thickness)
    return d


def _guard_offsetable(part, faces, label):
    """Shared precondition for the OCCT offset family (Offset Face, Thicken).
    Raises ValueError — which the rebuild loop renders as user-facing prose —
    rather than letting BRepOffset take the sidecar down.

    Scope is deliberately the SAME check press/pull already trusts, no more.
    An earlier, broader "refuse any faceted body" guard was tried and removed: a
    cylinder STL imported through _refacet_clean reduces to 26 clean planar faces
    and offsets correctly (measured: 2278 → 2502 mm³), so refusing it would have
    blocked legitimate work. The import path already rejects meshes that DON'T
    reduce (MAX_IMPORT_FACES), and server.py's out-of-process worker is the
    backstop for whatever still manages to crash OCCT."""
    for f in faces:
        # The type gate is WIDER than it was (cone, sphere and torus join the
        # planes and cylinders — see OFFSETTABLE_CURVED for the measurements) but
        # it is still a gate, because freeform surfaces do not fail on this path,
        # they crash it.
        try:
            gt = f.geom_type
        except Exception:
            gt = None
        if gt != GeomType.PLANE and gt not in OFFSETTABLE_CURVED:
            raise ValueError(
                f"{label} needs a flat or a regularly-curved face "
                "(round, cone, sphere or torus) — this one is freeform"
            )
        # a lone mesh facet on a dense body: reject rather than offset a sliver
        try:
            if len(part.faces()) > 300 and f.area < 1.0:
                raise ValueError(
                    f"can't {label.lower()} this region — it's a single mesh facet, "
                    "not a clean face"
                )
        except ValueError:
            raise
        except Exception:
            pass


def _sweep_press_pull(part, face, d):
    """Move a face by SWEEPING it along one direction and booleaning the result,
    instead of offsetting its surface.

    This is the same thing the planar path has always done, pointed at the faces
    the offset path cannot take. It touches no BRepOffset, which is what makes it
    survive a freeform face: measured on a lofted body with four BSpline sides,
    +-1.5 / 5 / 20mm all produce valid solids, where the local offset crashes the
    worker outright at the same distances.

    It is NOT an offset, and the difference shows on a strongly curved face: the
    face keeps its shape and travels, with straight side walls, rather than the
    surface thickening. That is what "push this patch" means and is the honest
    behaviour to offer where the exact one is unavailable — but it is the reason
    this stays a FALLBACK and analytic faces keep the real offset, which resizes
    a hole, a boss or a blend properly.

    The direction is the face normal at its parametric centre. A freeform face
    has no single normal, so a face that wraps — the side of a swept tube, which
    closes on itself — has no direction that means anything, and sweeping it
    produces a prism that swallows the body.

    Validity is NOT enough to catch that. Measured on exactly that tube: the
    result passes BRepCheck_Analyzer and has volume 0.0, i.e. a perfectly
    well-formed nothing. So the volume is checked too, for sign and direction,
    and a sweep that does not move material the way the drag asked for is
    refused rather than committed.
    """
    n = face.normal_at()
    prism = extrude(face, abs(d), dir=(n if d > 0 else -n))
    out = (part + prism) if d > 0 else (part - prism)
    from OCP.BRepCheck import BRepCheck_Analyzer

    if not BRepCheck_Analyzer(out.wrapped).IsValid():
        raise ValueError(_SWEEP_REFUSAL)
    before, after = _solid_volume(part), _solid_volume(out)
    if after <= 0 or (after > before) != (d > 0):
        raise ValueError(_SWEEP_REFUSAL)
    return out


_SWEEP_REFUSAL = (
    "can't press/pull this face — it is freeform and wraps around, so there is "
    "no one direction to push it in. Try a neighbouring face instead."
)


def _solid_volume(shape):
    """Volume in mm3, or 0.0 when the shape has none to measure."""
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    try:
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape.wrapped, props)
        return float(props.Mass())
    except Exception:
        return 0.0


def _offset_face(part, face, d):
    """Single-face convenience wrapper over _offset_faces (curved Press/Pull)."""
    return _offset_faces(part, [(face, d)])


def _thicken_press_pull(part, face, d):
    """Move a face by THICKENING it into a slab and booleaning the slab in.

    _offset_faces rebuilds the WHOLE body, so a face it could move perfectly well
    is refused because some other face of the same solid defeats BRepOffset.
    Measured on the reported document: two bores in a body carrying six blend
    surfaces could not be resized by any amount, in either direction.

    This asks a smaller question. Thicken the one face by |d| along its own
    normal, then fuse (d > 0, the body grows across the face's front) or cut
    (d < 0). On a bore the slab is the annulus between r and r ∓ |d|, so the hole
    changes radius by exactly d — measured 2.2124 → 1.2124 at d = +1.

    Unlike _sweep_press_pull the slab follows the SURFACE, which is what lets it
    take a face that wraps round on itself; a linear prism has no direction to
    travel along there, and that refusal is what a hole used to land in.

    OCCT returns the slab REVERSED for one sign of the offset — a solid of
    negative volume — and fusing that erases the body (measured: 44082 mm³ → 0).
    Normalising the orientation is not tidying, it is the difference between the
    right answer and an empty document."""
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepOffset import BRepOffset_MakeOffset, BRepOffset_Mode
    from OCP.GeomAbs import GeomAbs_JoinType

    mk = BRepOffset_MakeOffset()
    mk.Initialize(
        face.wrapped, d, 1e-4, BRepOffset_Mode.BRepOffset_Skin,
        False, False, GeomAbs_JoinType.GeomAbs_Intersection, True,
    )
    mk.MakeThickSolid()
    if not mk.IsDone():
        raise ValueError("can't offset this face by that amount")
    slab = _wrap_topods(mk.Shape())
    if slab is None:
        raise ValueError("can't offset this face by that amount")
    if _solid_volume(slab) < 0:
        slab = _wrap_topods(mk.Shape().Reversed())
        if slab is None:
            raise ValueError("can't offset this face by that amount")
    out = (part + slab) if d > 0 else (part - slab)
    before, after = _solid_volume(part), _solid_volume(out)
    if not BRepCheck_Analyzer(out.wrapped).IsValid() or after <= 0 or (after > before) != (d > 0):
        raise ValueError(
            "that offset ran past what this surface can hold — try a smaller amount"
        )
    return out


def _offset_faces(part, pairs):
    """Local surface offset via OCCT (BRepOffset in Skin mode with per-face
    offsets, global offset 0). `pairs` is [(face, signed_distance_mm), ...];
    every face is registered before ONE MakeOffsetShape() pass so adjacent
    offsets close against each other instead of fighting over shared edges.
    Returns a fixed-up Solid."""
    import OCP.BRepOffset as _bro
    from OCP.GeomAbs import GeomAbs_JoinType
    from OCP.TopAbs import TopAbs_ShapeEnum
    from OCP.TopoDS import TopoDS
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid

    pairs = [(f, d) for f, d in pairs if abs(d) > 1e-9]
    if not pairs:
        return part

    mk = _bro.BRepOffset_MakeOffset()
    # GeomAbs_Intersection join is what makes a local single-face offset close up
    # cleanly against the neighbouring faces (the Arc join fails here).
    mk.Initialize(
        part.wrapped,
        0.0,
        1e-4,
        _bro.BRepOffset_Mode.BRepOffset_Skin,
        False,
        False,
        GeomAbs_JoinType.GeomAbs_Intersection,
        False,
        False,
    )
    for face, d in pairs:
        mk.SetOffsetOnFace(face.wrapped, d)
    mk.MakeOffsetShape()
    if not mk.IsDone():
        raise ValueError("can't offset this face by that amount")
    sh = mk.Shape()
    # the offset yields a Shell; wrap it back into a Solid so downstream booleans,
    # tessellation and export all see a uniform solid.
    if sh.ShapeType() == TopAbs_ShapeEnum.TopAbs_SHELL:
        sh = BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(sh)).Solid()
    # IsDone() is not the same as "produced a usable solid": BRepOffset reports
    # success while emitting a shell that self-intersects where the offset ran
    # past the local curvature. Letting that into the document is worse than
    # refusing, because it survives until some later boolean fails somewhere the
    # user cannot connect to what they did. This is the check that lets the type
    # gate above be dropped — the operation now polices its own result.
    from OCP.BRepCheck import BRepCheck_Analyzer

    if not BRepCheck_Analyzer(sh).IsValid():
        raise ValueError(
            "that offset ran past what this surface can hold — try a smaller amount"
        )
    return Solid(sh)
