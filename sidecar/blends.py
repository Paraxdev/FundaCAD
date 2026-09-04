"""Fillets and chamfers, and explaining the ones OCCT will not do.

Split out of builder.py. Rounding an edge is one kernel call that fails often
and says nothing useful when it does, so most of this module is the difference
between "fillet failed" and a sentence the user can act on: which edges could
not be resolved, whether a smaller radius would have worked (_size_would_help
actually tries one), whether the edge was too smooth to round at all, and
whether the result folded over itself and would have been a corrupt solid.

_sequential_blend is the other half of that: when a batch refuses, the edges are
re-tried one at a time so the failure names the edge rather than the feature.
"""

import re
import math

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import Vector

from blend_overlap import folds_over_itself
from conic_blend import ConicNotApplicable, conic_blend
from geom_select import (
    POS_DRIFT,
    REL_DRIFT,
    _bbox_diag,
    _edge_center,
    _edge_cost,
    _edge_curve,
    _edge_dir,
    _edge_mid,
    _edge_radius,
    resolve_edges,
)
from shape_util import _wrap_topods

def _report_edge_failures(f, ctx, edges, try_one):
    """Failure-path-only probe for fillet/chamfer: which of `edges` fail the op
    INDIVIDUALLY? Appends an `edgeOpFailed` diagnostic naming the offenders'
    midpoints — or ALL members when every edge passes alone (the combination
    itself is the failure) — so the frontend can paint exactly those edges red.
    Bounded (skipped past 32 edges) and only ever paid AFTER the combined op
    already raised; the happy path stays a single OCCT build."""
    if ctx.diagnostics is None or len(edges) > 32:
        return
    failed = []
    for e in edges:
        try:
            try_one(e)
        except Exception:
            failed.append(e)
    probed = failed or edges
    from geom_select import _edge_mid

    def mid3(e):
        p = _edge_mid(e)
        return [round(float(p.X), 3), round(float(p.Y), 3), round(float(p.Z), 3)]

    ctx.diagnostics.append({
        "feature_id": f.get("id"),
        "kind": "edgeOpFailed",
        "resolved": len(edges),
        "confidence": 0.0,
        "lossy": True,
        "reason": "per-edge" if failed else "combination",
        "failed": [{"mid": mid3(e)} for e in probed],
    })


def _edge_identity(e):
    """A geometric fingerprint of a live edge, stable enough to RE-FIND it on a
    body whose topology changed underfoot (each fillet/chamfer renumbers and
    slightly reshapes neighbouring edges). Mirrors the fields `_edge_cost`
    scores, so the same weighting that resolves user selectors also re-matches
    an evolving body."""
    fp = {
        "mid": list(_edge_mid(e).to_tuple()),
        "dir": list(_edge_dir(e).to_tuple()),
    }
    try:
        fp["length"] = float(e.length)
    except Exception:
        pass
    cv = _edge_curve(e)
    if cv:
        fp["curve"] = cv
    if cv == "circle":
        r = _edge_radius(e)
        if r is not None:
            fp["radius"] = r
        c = _edge_center(e)
        if c is not None:
            fp["center"] = list(c.to_tuple())
    return fp


def _canonical_blend_key(fp):
    """Deterministic sort key for the sequential-blend order: the resolved edges'
    rounded-3dp midpoint (the generator's exact acceptance key), then direction,
    then length as tiebreakers. Merged-blend volumes are ORDER-DEPENDENT (adjacent
    fillets that fuse remove slightly different material per order, ~10%+ spread),
    so a fixed canonical order is what makes a full rebuild reproducible and keeps
    the removed volume matched to the reference. Midpoints are unique across every
    corpus edge set; direction/length only ever break a genuine coincident-midpoint
    tie."""
    mid = fp["mid"]
    d = fp.get("dir", (0.0, 0.0, 0.0))
    ln = fp.get("length", 0.0)
    return (
        round(mid[0], 3), round(mid[1], 3), round(mid[2], 3),
        round(d[0], 3), round(d[1], 3), round(d[2], 3),
        round(ln, 3),
    )


def _rematch_edge(shape, fp, max_mid_dist, tol_pos):
    """Find the edge on `shape` that is `fp`'s current incarnation, or None.

    A gate (`max_mid_dist`, scaled to the blend size) rejects everything the
    edge could NOT have drifted into — so if the edge genuinely vanished we
    return None and let the caller raise, rather than silently blending the
    wrong edge. Among the survivors we pick the lowest `_edge_cost`, the exact
    scorer the selector resolver trusts."""
    mid = Vector(*fp["mid"])
    cands = [e for e in shape.edges() if (_edge_mid(e) - mid).length <= max_mid_dist]
    if not cands:
        return None
    return min(cands, key=lambda e: _edge_cost(e, fp, tol_pos))


def _sequential_blend(shape, edges, apply_one, blend_size, diag_part):
    """Fallback for a combined fillet/chamfer that OCCT rejected: apply the
    blend to ONE edge at a time on the evolving body. Filleting an edge lets
    the kernel settle that surface before the next, which succeeds on
    reflex/tight-clearance sets the single combined call cannot solve.

    Edges are applied in a CANONICAL order (rounded-midpoint, see
    _canonical_blend_key). Because overlapping blends fuse into order-dependent
    solids, this fixed order is what makes a rebuild deterministic and its
    removed volume reproducible. Multi-pass to a fixpoint: a straggler that
    fails early is retried after its neighbours have blended (more material
    around a reflex edge can make it buildable), with canonical order preserved
    among the remaining edges each pass. Every remaining edge is re-found by
    geometric identity each step (topology renumbers under us). Returns
    (new_shape, unresolved_original_edges); the caller enforces the
    all-or-nothing product rule.

    `apply_one(shape, edge) -> new_shape` runs the actual kernel op.
    """
    # Fingerprint every target up front, on the ORIGINAL body, before anything
    # moves — then fix the canonical application order once.
    pending = [(e, _edge_identity(e)) for e in edges]
    pending.sort(key=lambda t: _canonical_blend_key(t[1]))
    # Positional gate: an edge shortened by a neighbouring blend shifts its
    # midpoint by at most ~blend_size; add the resolver's baseline drift budget.
    base = POS_DRIFT + REL_DRIFT * _bbox_diag(diag_part)
    max_mid_dist = 1.5 * float(blend_size) + base
    tol_pos = max(base, float(blend_size))

    current = shape
    progressed = True
    while pending and progressed:
        progressed = False
        still = []
        for orig, fp in pending:
            target = _rematch_edge(current, fp, max_mid_dist, tol_pos)
            if target is None:
                still.append((orig, fp))
                continue
            try:
                current = apply_one(current, target)
                progressed = True
            except Exception:
                still.append((orig, fp))
        pending = still
    return current, [orig for orig, _ in pending]


def _group_sels_by_body(sel, ctx, label):
    """Split a selector (or list of them) into [(body, [selectors])] groups, in
    first-seen order.

    A selector's OWN `body` decides which shape it resolves against — the tools
    stamp it from the edge/face the user actually clicked. Without this a
    multi-body model resolves every selector against require_active() =
    bodies[-1], and because `by:"nearest"` always returns SOME winner it edits
    whichever body happened to be created last, silently (the ring/hexagon bug).

    A selector with no `body` falls back to the active body: that is exactly the
    old behaviour, so documents saved before the tools stamped bodies keep
    building unchanged.
    """
    sels = sel if isinstance(sel, list) else [sel]
    groups = {}  # body id -> (body, [selectors]); dicts keep insertion order
    for s in sels:
        bid = s.get("body") if isinstance(s, dict) else None
        if bid:
            body = ctx.find_body(bid)
            if body is None:
                raise ValueError(f"{label}: the target body no longer exists")
        else:
            body = ctx.require_active(label)
        groups.setdefault(body["id"], (body, []))[1].append(s)
    return list(groups.values())


#: Below this angle between the two face normals at an edge, the faces meet
#: smoothly and the edge is not a corner. One degree rather than zero because a
#: blend that has been rebuilt, imported or re-tessellated carries a little
#: numerical noise on its tangency, and a blend of any size across a 0.3-degree
#: "corner" is a degenerate sliver nobody asked for.
SMOOTH_EDGE_DEG = 1.0


def _edge_dihedral_deg(shape, edge):
    """Angle between the surface normals of the two faces meeting at `edge`, in
    degrees at its midpoint — 0 where they meet smoothly, 90 on a box corner.

    None when the question does not apply: a seam edge, a free edge, or a point
    where a normal degenerates. None must be read as "unknown", never as
    "smooth", or the guard below starts refusing perfectly good work."""
    import math

    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
    from OCP.gp import gp_Pnt, gp_Vec
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopoDS import TopoDS
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape

    try:
        m = TopTools_IndexedDataMapOfShapeListOfShape()
        TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, m)
        faces = []
        for i in range(1, m.Extent() + 1):
            if m.FindKey(i).IsSame(edge.wrapped):
                faces = [TopoDS.Face_s(x) for x in m.FindFromIndex(i)]
                break
        # Deduped by identity: the ancestor map lists a face once per incidence,
        # so a seam edge shows the SAME face twice and is not two faces meeting.
        uniq = []
        for fc in faces:
            if not any(fc.IsSame(g) for g in uniq):
                uniq.append(fc)
        if len(uniq) != 2:
            return None
        mid = edge.position_at(0.5)
        p = gp_Pnt(mid.X, mid.Y, mid.Z)
        normals = []
        for fc in uniq:
            surf = BRep_Tool.Surface_s(fc)
            proj = GeomAPI_ProjectPointOnSurf(p, surf)
            u, v = proj.LowerDistanceParameters()
            ad = BRepAdaptor_Surface(fc)
            q, du, dv = gp_Pnt(), gp_Vec(), gp_Vec()
            ad.D1(u, v, q, du, dv)
            n = du.Crossed(dv)
            if n.Magnitude() < 1e-12:
                return None
            n.Normalize()
            normals.append(n)
        return math.degrees(math.acos(max(-1.0, min(1.0, normals[0].Dot(normals[1])))))
    except Exception:
        return None


def _refuse_smooth_edges(shape, edges, label):
    """Refuse a blend on an edge whose faces already meet smoothly, and say why.

    A fillet or a chamfer cuts across the corner between two faces. Where those
    faces are TANGENT there is no corner, so there is nothing to cut and no size
    of cut that would find one — the operation fails identically at 5mm and at
    0.05mm. This is not a rare shape: it is the boundary of every fillet on the
    model, so it is exactly what a user picks when they click the visible line
    around a round they already made.

    Without this, the failure surfaces as OCCT's own "try a smaller length
    value(s)", which is not merely unhelpful but actively wrong — it describes a
    size problem, so it sends someone into a retry loop that cannot terminate.
    Refusing here costs one dihedral measurement per feature and replaces that
    with the truth."""
    smooth = []
    for e in edges:
        ang = _edge_dihedral_deg(shape, e)
        if ang is not None and ang < SMOOTH_EDGE_DEG:
            smooth.append(e)
    if not smooth:
        return
    if len(edges) == 1:
        which = "that edge is already smooth"
    elif len(smooth) == len(edges):
        which = f"all {len(edges)} selected edges are already smooth"
    else:
        which = f"{len(smooth)} of the {len(edges)} selected edges are already smooth"
    raise ValueError(
        f"can't {label.lower()} here — {which}. The faces meet tangentially, so "
        "there is no corner to cut and no smaller value will help. To get the "
        "sharp edge back, delete the rounded face."
    )


def _refuse_seam_edges(shape, edges, label):
    """Refuse a blend when every selected edge is a SEAM, and say what a seam is.

    A face that wraps all the way round — the side of a cylinder, a cone, a
    360-degree revolve — closes on itself, and the kernel records that closure
    as a real topological edge. It is bookkeeping, not geometry: there is no
    crease there, and both sides of it are the SAME face. ChFi3d needs two
    different faces to blend between, so it refuses, and what it says is
    "ChFi3d_Builder:only 2 faces", which describes nothing anyone can act on.

    Only when EVERY selected edge is a seam. A broad selector — by:"axis", which
    on a cylinder picks up the seam along with the real edges, or by:"all" —
    routinely includes one, and OCCT blends those groups perfectly well
    (measured on a cone: by:"all" over a rim and its seam succeeds). Refusing
    those would break work that has always worked, and the seam in them is not
    what the user meant to pick anyway."""
    from topo_adj import FaceAdjacency

    if not edges:
        return
    adj = FaceAdjacency(shape)
    for e in edges:
        faces = adj.faces_of_edge(e)
        if not (len(faces) == 2 and faces[0] == faces[1]):
            return  # at least one real edge in the selection: nothing to say
    which = ("that edge is a seam" if len(edges) == 1
             else f"all {len(edges)} selected edges are seams")
    raise ValueError(
        f"can't {label.lower()} here — {which}. A seam is the line where a face "
        "that wraps all the way round meets itself, so both sides of it are the "
        "same face and there is no corner to cut. Pick the edges where that face "
        "meets its NEIGHBOURS instead."
    )


# How much smaller the probe below tries. A twentieth is far enough that any
# genuine clearance problem has gone away; if that fails too, size is not what is
# wrong.
SIZE_PROBE_FRACTION = 0.05

# ...but a twentieth of a HUGE value is still huge, and that made the probe lie.
# Measured on a 60x6x20 wedge whose tip blends at 2mm and not at 5mm: asked for
# 61mm, the probe tried 3.05mm, which also fails, and the refusal announced that
# no size would help — while 2mm builds. A drag that has run well past the limit
# produces exactly that, so the message was at its most misleading precisely when
# the user was furthest from a value that works.
#
# The probe is therefore also capped against the BODY, which is the scale a blend
# is actually small or large relative to. A thousandth of the body's diagonal is
# a blend nobody would ask for and every buildable edge accepts, so a failure
# there is a failure of geometry rather than of size.
SIZE_PROBE_BODY_FRACTION = 1e-3


def _size_probe(shape, blend_size):
    """The size to retry a failed blend at, or None when there is nothing to try."""
    if not blend_size or blend_size <= 0:
        return None
    small = blend_size * SIZE_PROBE_FRACTION
    try:
        small = min(small, _bbox_diag(shape) * SIZE_PROBE_BODY_FRACTION)
    except Exception:
        pass
    return small if small > 0 else None


def _size_would_help(shape, edges, one_edge_at, blend_size):
    """Does a much SMALLER blend build where this one didn't?

    OCCT answers every blend failure with "try a smaller length value(s)",
    whatever went wrong. When the real problem is where the blend has to END —
    an arc dying into a neighbouring face, a corner the kernel cannot close —
    that message is not merely unhelpful, it sends the user into a retry loop
    that cannot terminate, because the operation fails identically at 5mm and at
    0.05mm. Measured on a cylinder half sunk into a plate: the partial rim
    builds at 1.5mm and fails at 2.0mm (a real size limit), while the corner
    cases fail flat at every radius tried.

    One extra kernel attempt, only ever on the failure path.
    """
    small = _size_probe(shape, blend_size)
    if small is None or len(edges) > 8:
        return None
    for e in edges:
        try:
            one_edge_at(shape, e, small)
        except Exception:
            return False
    return True


def _kernel_sentence(err):
    """OCCT's own words, with the part nobody on this side can act on removed.

    build123d ends its fillet failure with "or use max_fillet() to find the
    largest valid fillet radius". That is a Python method on a build123d Shape,
    offered to someone whose entire interface is a radius box in a ribbon or a
    JSON field over a socket. Neither can call it, so the sentence spends its
    second half sending the reader after a thing that does not exist for them.
    The first half — try a smaller value — is good advice and stays.
    """
    return re.sub(r"[,;]?\s*or use max_fillet\(\)[^.]*", "", str(err)).strip()


def _blend_failure_message(label, body, unresolved, one_edge_at, blend_size, err):
    """What to actually tell the user about a blend the kernel would not build."""
    helps = _size_would_help(body["shape"], unresolved, one_edge_at, blend_size)
    probed = _size_probe(body["shape"], blend_size)
    if helps is not False:
        # Either a smaller size did build, or there were too many edges to probe.
        # OCCT's own sentence is the honest one here.
        return f"{label} failed on {body['name']}: {_kernel_sentence(err)}"
    which = ("that edge" if len(unresolved) == 1
             else f"{len(unresolved)} of the selected edges")
    return (
        f"can't {label.lower()} {which} on {body['name']} at ANY size — it fails "
        f"the same at {probed:g}mm as at {blend_size:g}mm. "
        "The blend has nowhere to end: add the neighbouring edges to it, or blend "
        "those first."
    )


def _refuse_folded_blend(body, new_shape):
    """Refuse a blend that built surface on top of surface, and say what it did.

    The kernel reports success here. The solid it returns is closed, valid and
    tolerance-tight, and the only thing wrong with it is that a patch of the
    model is covered twice, which the depth buffer cannot resolve and which
    therefore reaches the user as flickering triangles rather than as an error.
    See blend_overlap.py for the measurement and for why it is scoped to the
    faces the blend created.

    Refusing is the honest answer rather than the convenient one: there is no
    smaller version of this result that is right, and a shape that draws as a
    flicker is not a shape the user asked for."""
    if not folds_over_itself(body["shape"], new_shape):
        return
    # No operation name in here. Every path that shows this already puts one in
    # front, so naming it again gives "Fillet failed: Fillet folded over
    # itself", which spends the one line a toast has on saying it twice.
    raise ValueError(
        f"made surface that folds back over itself on {body['name']} — at this "
        "size the blend runs past its own face and covers the model twice. Try a "
        "different size, or blend this edge before the one next to it."
    )


def _blend_edges(f, ctx, label, combined, one_edge_at, blend_size):
    """Shared fillet/chamfer body: blend every selected edge, per owning body.

    `combined(shape, edges) -> shape` runs the kernel op on a whole group at
    once; `one_edge_at(shape, edge, size) -> shape` does a single edge at a given
    size (the fallback, the failure probe, and the size probe). Both take the
    body they are blending: build123d's own fillet/chamfer infer it from the
    edges, but a conic profile has to rebuild the solid itself.

    ALL-OR-NOTHING across bodies: every group's new shape is computed first and
    only assigned once they ALL succeed. Otherwise a two-body fillet whose
    second body raises would leave the first one blended while the timeline
    paints the feature red — a solid the user never asked for.
    """
    staged = []
    # A zero or negative blend is not a small blend, it is no blend. OCCT's own
    # message ("try a smaller value") is actively misleading for radius 0 or -3.
    if blend_size is not None and not (blend_size > 0):
        raise ValueError(
            f"{label}: size must be greater than 0 (got {blend_size:g})"
        )
    for body, sels in _group_sels_by_body(f["edges"], ctx, label):
        edges = resolve_edges(body["shape"], sels, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not edges:
            raise ValueError(f"no edge found to {label.lower()} on {body['name']}")
        _refuse_seam_edges(body["shape"], edges, label)
        _refuse_smooth_edges(body["shape"], edges, label)
        try:
            new_shape = combined(body["shape"], edges)
        except ConicNotApplicable:
            # NOT a failure of the fillet, and it must not be reported as one.
            # The plain fillet at this radius builds perfectly well; it is the
            # PROFILE that this face cannot carry. Letting it fall through to
            # the per-edge retry below would spend the work only to arrive at
            # the same refusal, and then dress it as "Fillet failed on Body1",
            # which sends the user hunting for a radius problem that isn't
            # there. Re-raised untouched so its own sentence — which names the
            # geometry and says to use profile 0 — is what reaches the toast.
            raise
        except Exception as combined_err:
            # Combined call failed: fall back to per-edge blending on the evolving body.
            one_edge = lambda s, e: one_edge_at(s, e, blend_size)  # noqa: E731
            new_shape, unresolved = _sequential_blend(
                body["shape"], edges, one_edge, blend_size, body["shape"]
            )
            if unresolved:
                # Hard no-silent-degradation rule: any edge we could not blend means
                # the feature FAILS — never a partial solid, never a smaller radius.
                # Paint exactly the offenders red, then re-raise the original error.
                _report_edge_failures(f, ctx, unresolved,
                                      lambda e: one_edge(body["shape"], e))
                raise ValueError(_blend_failure_message(
                    label, body, unresolved, one_edge_at, blend_size, combined_err
                )) from combined_err
        _refuse_folded_blend(body, new_shape)
        staged.append((body, new_shape))
    for body, shape in staged:
        body["shape"] = shape


def _conic_fillet(shape, edges, radius, profile):
    """A fillet whose section is a conic rather than a circular arc.

    Same tangency, same setback, different fullness — see conic_blend.py. Raw
    TopoDS in and out of the blend itself, because it rebuilds the solid's faces
    and edges directly; build123d only ever sees the wrapped result.
    """
    out = conic_blend(shape.wrapped, [e.wrapped for e in edges], radius, profile)
    wrapped = _wrap_topods(out)
    if wrapped is None:
        raise ValueError("Fillet: the conic profile produced no usable solid")
    return wrapped
