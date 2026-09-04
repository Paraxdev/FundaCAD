"""Which feature made this face, and taking a feature back off a body.

Split out of builder.py. Two jobs that are really one, because both turn on
being able to name a face without a topology index:

  - PROVENANCE. Every body carries {face fingerprint -> feature id}, so clicking
    a chamfer face can select the chamfer. The fingerprint is (area, centre)
    quantised into the world frame, which survives a move because a move can be
    applied to the key.
  - DEFEATURING. Removing a fillet or a boss means deleting its faces and
    healing the hole — either by filling it with a tool solid built from the
    surrounding walls (_tool_fill), or by cutting the protrusion away
    (_tool_cut). _expand_blend_chain is what turns one picked fillet face into
    the whole tangent run it belongs to, since a user means the rounded edge,
    not the one strip they happened to hit.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import (
    Box,
    Compound,
    Edge,
    Face,
    Keep,
    Plane,
    Pos,
    Solid,
    Vector,
    split,
)

from shape_util import _as_compound, _wrap_topods, _wrapped_or_none
from topo_adj import FaceAdjacency

def _fp_world(area, cx, cy, cz, loc):
    """Round a LOCAL-frame (area, centre) into the world-frame fingerprint.

    Module level, not a closure inside _face_fp: that allocated a function
    object on all ~70k calls per rebuild, and re-ran the gp_Pnt import lookup
    on the hot memo-hit path. The import now only happens when there is an
    actual transform to apply."""
    if loc is None or loc.IsIdentity():
        return (round(area, 2), round(cx, 1), round(cy, 1), round(cz, 1))
    from OCP.gp import gp_Pnt

    p = gp_Pnt(cx, cy, cz)
    p.Transform(loc.Transformation())
    return (round(area, 2), round(p.X(), 1), round(p.Y(), 1), round(p.Z(), 1))


def _face_fp(face):
    """Quantized (area, centre) fingerprint, memoized by the face's TShape.

    The memo caches the face's geometry in its OWN (local) frame and applies the
    face's Location on retrieval. Area is invariant under a rigid transform and
    the centre is equivariant, so this is exact — verified on the 3,072-body
    reference assembly: 25,523 of 25,523 fingerprints byte-identical to the
    direct world-frame computation, zero differences.

    It used to memoize ONLY when the Location was already identity, on the
    measurement that >99% of faces are identity-located after booleans. That
    holds for modelled geometry and is completely false for IMPORTED assemblies:
    step_assembly places every leaf with `.Moved()`, so 0 of 133,295 faces on the
    reference file qualified and the memo was entirely dead there — the same
    `.Moved()` blind spot that killed the edge memo in tessellate.py. Since
    `_face_fp` is called twice per face on an open (once building the owner map
    in _update_owners, once resolving faceOwners in server._body_payload) and
    each call is a GProp surface integration at ~137 us, that dead memo was the
    single largest quality-preserving cost on the open path.

    TShape identity implies identical local geometry, which is what makes the
    key sound; the Location supplies everything else."""
    w = _wrapped_or_none(face)
    key = loc = None
    if w is not None:
        try:
            key = w.TShape()
            loc = w.Location()
            hit = _FP_MEMO.get(key)
            if hit is not None:
                return _fp_world(*hit, loc)
        except Exception:
            # both, or a half-set loc would be applied to a world-frame centre
            # below and transform it twice
            key = loc = None
    try:
        # Evaluate in the LOCAL frame and transform, rather than evaluating in
        # world and separately caching a local copy: that did TWO GProp
        # integrations per miss and measured 43.6 s -> 82.1 s on the first pass,
        # eating the whole benefit. One integration, same as before the memo.
        lf = face
        if loc is not None and not loc.IsIdentity():
            from OCP.TopLoc import TopLoc_Location
            from build123d import Face

            lf = Face(w.Located(TopLoc_Location()))
        c = lf.center()
        local = (lf.area, c.X, c.Y, c.Z)
        fp = _fp_world(*local, loc)
    except Exception:
        return None
    if key is not None:
        if len(_FP_MEMO) > 200_000:
            _FP_MEMO.clear()  # bound process-lifetime growth; it's only a cache
        _FP_MEMO[key] = local
    return fp


_FP_MEMO = {}
_WIDTH_MEMO = {}


def _shape_face_fps(shape):
    try:
        faces = shape.faces()
    except Exception:
        return []
    return [fp for fp in (_face_fp(f) for f in faces) if fp is not None]


def _move_fp(fp, trsf):
    from OCP.gp import gp_Pnt
    area, cx, cy, cz = fp
    p = gp_Pnt(cx, cy, cz)
    p.Transform(trsf)
    return (area, round(p.X(), 1), round(p.Y(), 1), round(p.Z(), 1))


def _remove_features(shape, faces):
    """One low-level BOPAlgo_RemoveFeatures attempt. Returns (healed | None, alerts).

    None means OCCT errored, produced no solid, or silently returned the shape
    UNCHANGED — per-feature failure is a WARNING by design (the BRepAlgoAPI wrapper
    hides it), so the face-count drop is the real success signal. `alerts` carries
    the OCCT warning keys (e.g. BOPAlgo_AlertUnableToRemoveTheFeature) for an
    honest error message."""
    from OCP.BOPAlgo import BOPAlgo_RemoveFeatures
    from OCP.Message import Message_Gravity
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    rf = BOPAlgo_RemoveFeatures()
    rf.SetShape(_as_compound(shape).wrapped)
    for fc in faces:
        rf.AddFaceToRemove(fc.wrapped)
    rf.SetRunParallel(True)
    rf.Perform()
    alerts = []
    try:
        rep = rf.GetReport()
        for grav in (
            Message_Gravity.Message_Warning,
            Message_Gravity.Message_Alarm,
            Message_Gravity.Message_Fail,
        ):
            for a in rep.GetAlerts(grav):
                alerts.append(a.GetMessageKey())
    except Exception:
        pass
    if rf.HasErrors():
        return None, alerts
    solids = []
    exp = TopExp_Explorer(rf.Shape(), TopAbs_SOLID)
    while exp.More():
        solids.append(Solid(TopoDS.Solid_s(exp.Current())))
        exp.Next()
    if not solids:
        return None, alerts
    before = len(_as_compound(shape).faces())
    after = sum(len(s.faces()) for s in solids)
    if after >= before:
        return None, alerts
    return (solids[0] if len(solids) == 1 else Compound(solids)), alerts


def _face_width(f):
    """Characteristic band width: 2·area/perimeter (≈ true width for a long strip,
    small for a corner patch, large for a real base face). Same TShape memo as
    _face_fp (width is location-invariant, so identity-location gating isn't even
    needed — but reuse the same safe pattern)."""
    w = _wrapped_or_none(f)
    key = None
    if w is not None:
        try:
            key = w.TShape()
            hit = _WIDTH_MEMO.get(key)
            if hit is not None:
                return hit
        except Exception:
            key = None
    per = sum(e.length for e in f.edges())
    out = (2.0 * f.area / per) if per > 0 else 0.0
    if key is not None:
        if len(_WIDTH_MEMO) > 200_000:
            _WIDTH_MEMO.clear()
        _WIDTH_MEMO[key] = out
    return out


def _expand_blend_chain(shape, seeds, width_factor=4.0, max_faces=64):
    """Grow the picked face(s) into the connected chamfer/fillet chain they belong to.

    RemoveFeatures heals by extending the faces ADJACENT to the removed set. Pick one
    member of a chamfer chain and its neighbours are the OTHER blend faces — tangent
    or shallow, so extension fails and the whole delete no-ops. Feeding it the full
    chain makes the true base faces the neighbours, which extend exactly.

    Chain membership is geometric: a candidate must be narrow (width within
    `width_factor` of the widest seed) AND band-shaped (width well under its own
    longest edge — the oblique-dihedral test alone is symmetric, a support meets
    its chamfer at 45° too; a base face is never a narrow band of the chamfer's
    scale, so these two filters are what stop expansion at the supports) and
    blend-like:
      * planar band meeting some neighbour at a clearly oblique dihedral
        (a chamfer strip against its supports — never ~0° or ~90°), or
      * cylinder/cone/torus/sphere band tangent to a neighbour (a fillet), or
      * a small patch adjacent to ≥2 faces already in the chain (a corner patch).
    Returns the seeds unchanged when nothing qualifies — or when expansion hits
    `max_faces`, which means the "chain" is really a mesh of narrow faces (e.g. a
    honeycomb wall lattice), not a blend: retrying on that is doomed and slow."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_SurfaceType
    from OCP.TopoDS import TopoDS

    adj = FaceAdjacency(_as_compound(shape))
    face_at = adj.face

    seed_idx = [adj.index_of(s) for s in seeds]
    seed_idx = [i for i in seed_idx if i > 0]
    if not seed_idx:
        return list(seeds)

    neighbors_cache = {}

    def neighbors(i):
        """[(other_face_index, shared_edge_midpoint)] over the face's edges.

        Cached: the chain walk revisits a face once per neighbour that reaches
        it, and the midpoint costs a curve evaluation each time."""
        out = neighbors_cache.get(i)
        if out is None:
            out = [(j, Edge(TopoDS.Edge_s(e)).position_at(0.5)) for j, e in adj.walk(i)]
            neighbors_cache[i] = out
        return out

    def dihedral(i, j, pt):
        """Angle in degrees between the two faces' surface normals at pt (a point
        on the shared edge). ~0 = tangent, ~90 = perpendicular, between = oblique."""
        try:
            n1, n2 = face_at(i).normal_at(pt), face_at(j).normal_at(pt)
            d = max(-1.0, min(1.0, n1.dot(n2)))
            return math.degrees(math.acos(abs(d)))
        except Exception:
            return 90.0

    FILLET_TYPES = (
        GeomAbs_SurfaceType.GeomAbs_Cylinder,
        GeomAbs_SurfaceType.GeomAbs_Cone,
        GeomAbs_SurfaceType.GeomAbs_Torus,
        GeomAbs_SurfaceType.GeomAbs_Sphere,
    )
    BAND_ASPECT_MAX = 0.4  # width / longest edge — a band, not a full face
    blend_cache = {}

    def is_blend(i):
        if i in blend_cache:
            return blend_cache[i]
        f = face_at(i)
        longest = max((e.length for e in f.edges()), default=0.0)
        if longest <= 0 or _face_width(f) / longest > BAND_ASPECT_MAX:
            blend_cache[i] = False
            return False
        t = BRepAdaptor_Surface(adj.key(i)).GetType()
        if t in FILLET_TYPES:
            r = any(dihedral(i, j, pt) < 10.0 for j, pt in neighbors(i))
        elif t == GeomAbs_SurfaceType.GeomAbs_Plane:
            r = any(15.0 <= dihedral(i, j, pt) <= 75.0 for j, pt in neighbors(i))
        else:
            r = False
        blend_cache[i] = r
        return r

    cap = width_factor * max(_face_width(face_at(i)) for i in seed_idx)
    # the ≥2-chain-neighbours fallback is for CORNER PATCHES only — without a hard
    # size limit it absorbs base faces once several strips surround them
    patch_area_max = (cap / 2.0) ** 2
    chain = set(seed_idx)
    queue = list(seed_idx)
    while queue:
        i = queue.pop()
        for j, _pt in neighbors(i):
            if j in chain or _face_width(face_at(j)) > cap:
                continue
            in_chain_neighbors = sum(1 for k, _ in neighbors(j) if k in chain)
            if is_blend(j) or (
                in_chain_neighbors >= 2 and face_at(j).area <= patch_area_max
            ):
                chain.add(j)
                queue.append(j)
                if len(chain) >= max_faces:
                    return list(seeds)  # runaway absorb — not a blend chain
    return [face_at(i) for i in chain]


def _wound_boundary(comp, faces):
    """Faces of `comp` adjacent (edge-sharing) to `faces` but not in the set —
    the faces that would border the wound if `faces` were removed."""
    adj = FaceAdjacency(comp)
    removed = {adj.index_of(x) for x in faces}
    # index 0 means "not a face of comp", which nothing here can be adjacent to
    ring = {j for i in removed if i > 0 for j, _ in adj.walk(i)} - removed
    return [adj.face(j) for j in ring]


def _tool_fill(shape, targets, feature_faces=None, max_planes=12):
    """Erase a MISSING-material region (chamfer/fillet cut into a corner) by
    boolean emulation instead of healing: build the filler wedge as the
    intersection of the local support faces' material half-spaces, clipped to a
    box around the targets, and fuzzy-fuse it in. Never extends or intersects the
    feature faces themselves — the restored corner emerges from the boolean — so
    it works exactly where RemoveFeatures' adjacent-face extension gives up
    (tangent neighbours, ragged facet supports).

    `targets` = the face(s) to erase THIS round (one convex pocket's worth);
    `feature_faces` = the whole feature (defaults to targets) — fellow feature
    faces are excluded from the support set, since a tangent chamfer continuation
    must never act as a bounding half-space. Returns the filled shape or None,
    with hard validation: planar supports only, ≥1 target face consumed, valid
    B-rep, and the void bounded to the targets' own extent so a wedge that would
    flood an unrelated feature (a hole) or extrude past an unbounded side (a
    deleted top face, a tab end) is rejected."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.GeomAbs import GeomAbs_SurfaceType
    from OCP.TopTools import TopTools_ListOfShape

    comp = _as_compound(shape)
    feature_faces = feature_faces or targets
    feat_fps = {fp for fp in (_face_fp(f) for f in feature_faces) if fp is not None}
    # supports = faces adjacent to the TARGETS that aren't part of the feature.
    # Facet-debris slivers (STL heritage) can sit between a chamfer and its true
    # support — look THROUGH them one ring: the sliver's own neighbours join the
    # support set (the wrong-side filter below discards any that don't actually
    # bound this pocket).
    first_ring = [
        b for b in _wound_boundary(comp, targets) if _face_fp(b) not in feat_fps
    ]
    bases, seen = [], set(feat_fps)
    for b in first_ring:
        fp = _face_fp(b)
        if fp in seen:
            continue
        seen.add(fp)
        if _face_width(b) < 0.25 and b.area < 1.0:  # debris — pass through
            for c in _wound_boundary(comp, [b]):
                cfp = _face_fp(c)
                if cfp not in seen and not (
                    _face_width(c) < 0.25 and c.area < 1.0
                ):
                    seen.add(cfp)
                    bases.append(c)
        else:
            bases.append(b)
    if not bases:
        return None
    # v1 supports planar supports only (the wedge is a half-space intersection)
    for b in bases:
        if BRepAdaptor_Surface(b.wrapped).GetType() != GeomAbs_SurfaceType.GeomAbs_Plane:
            return None

    # dedupe bases into distinct support planes. Parallel same-direction planes at
    # different offsets are a facet STAIRCASE (STL heritage) approximating one
    # design plane — keep the OUTERMOST (largest material half-space): the wedge
    # then covers the whole wound, and the fill flattens the staircase instead of
    # being truncated by its innermost step (which strands the void short of the
    # feature faces).
    groups = []  # [(normal, max_material_offset)]
    for b in bases:
        p0, n = b.center(), b.normal_at(b.center())
        off = p0.dot(n)
        for g in groups:
            if n.dot(g[0]) > 0.9998:  # same direction (opposing normals differ)
                g[1] = max(g[1], off)
                break
        else:
            groups.append([n, off])
    # drop wrong-side "supports": a neighbour whose material half-space excludes
    # the target face itself (e.g. the step wall of a stacked-plate clip meeting
    # the chamfer at its far edge) is geometry BEYOND the pocket, not a bound of
    # it — keeping it pinches the wedge off the target. The solid surface still
    # bounds the void in that direction, so dropping it can't overfill. Sample the
    # target's own vertices + center (its bbox corners overestimate for oblique
    # faces).
    samples = []
    for f in targets:
        samples.append(f.center())
        samples.extend(Vector(v.X, v.Y, v.Z) for v in f.vertices())
    groups = [
        (n, off)
        for n, off in groups
        if all(p.dot(n) <= off + 0.1 for p in samples)
    ]
    if not groups:
        return None
    if len(groups) > max_planes:
        return None  # too many distinct supports — mis-scoped region
    planes = [(n * off, n) for n, off in groups]

    # local clip box around the feature. Inflate a side only when some support
    # half-space bounds the wedge there; on an unbounded side, clip at the
    # feature's own bbox — the band spans exactly the void it cut, so the restored
    # material ends flush with the feature's extent (e.g. a chamfer chain that
    # wraps a tab END has no support plane past the end; the fill must stop at the
    # tab end, not run on into the inflation box).
    # clip/guard region = the WHOLE feature, not just this round's targets: a
    # clipped per-target fill leaves an end-cap that later rounds would see as a
    # support capping their wedge below the remaining pocket. Extending the wedge
    # through fellow feature faces' region is safe — the solid itself bounds the
    # void there — and lets sequential fills meet instead of walling each other off.
    region = Compound(list(feature_faces))
    bb = region.bounding_box()
    d = (bb.max - bb.min).length * 0.2 + 0.5
    lo = [bb.min.X, bb.min.Y, bb.min.Z]
    hi = [bb.max.X, bb.max.Y, bb.max.Z]
    for ax in range(3):
        comps = [(n.X, n.Y, n.Z)[ax] for n, _ in groups]
        # strict-with-epsilon: a support at EXACTLY 0.5 (hex-pocket walls tilted
        # 30° off-axis produce ±0.5 components with float dust on top) barely
        # bounds the wedge on this axis — inflating for it lets the wedge tube
        # run past the feature into a neighbouring pocket's void, and the
        # bounds guard then rejects a perfectly fillable notch. Clip flush at
        # the feature bbox instead, per the design above.
        if any(v < -0.5 - 1e-9 for v in comps):
            lo[ax] -= d
        if any(v > 0.5 + 1e-9 for v in comps):
            hi[ax] += d
    if min(h - l for h, l in zip(hi, lo)) < 1e-6:
        return None  # flat, unbounded region (e.g. a lone big face) — no wedge
    tool = Pos(
        (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2
    ) * Box(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    for p0, n in planes:
        # material lies on the -n side of each base plane (n = outward normal)
        pl = Plane(origin=(p0.X, p0.Y, p0.Z), z_dir=(-n.X, -n.Y, -n.Z))
        tool = split(tool, bisect_by=pl, keep=Keep.TOP)
        if tool is None or not tool.solids():
            return None

    # the actual fill = the void components of (wedge − solid) that TOUCH the
    # feature faces. Selecting components (a) leaves unrelated voids inside the
    # wedge region alone (a screw hole near the corner must not get plugged) and
    # (b) exposes the degenerate case for the bounds guard below.
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape

    try:
        outside = _as_compound(tool) - comp
    except Exception:
        return None
    voids = [
        s
        for s in outside.solids()
        if BRepExtrema_DistShapeShape(s.wrapped, region.wrapped).Value() < 1e-2
    ]
    if not voids:
        return None
    # bounds guard: a real chamfer/fillet void lies within the feature's own
    # bounding box (the band spans the void it cut — the restored corner/edge sits
    # on the box boundary), so only fuzz-scale slack is legitimate. A void escaping
    # the box — e.g. deleting a box's whole top face makes the "wedge" an unbounded
    # slab clipped only by the inflation box — is NOT a feature void; filling it
    # would silently extrude the part. Reject.
    margin = 0.5
    vb = Compound(voids).bounding_box()
    if (
        vb.min.X < bb.min.X - margin or vb.min.Y < bb.min.Y - margin
        or vb.min.Z < bb.min.Z - margin or vb.max.X > bb.max.X + margin
        or vb.max.Y > bb.max.Y + margin or vb.max.Z > bb.max.Z + margin
    ):
        return None
    # a feature void can't exceed feature-area × feature-extent; bigger means
    # the wedge flooded something that isn't this feature
    gain_cap = max(1.0, sum(f.area for f in feature_faces)) * max(
        1.0, max(_face_width(f) for f in feature_faces)
    ) * 3.0
    if sum(v.volume for v in voids) > gain_cap:
        return None

    fu = BRepAlgoAPI_Fuse()
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(comp.wrapped)
    for v in voids:
        tools.Append(v.wrapped)
    fu.SetArguments(args)
    fu.SetTools(tools)
    fu.SetFuzzyValue(1e-5)
    fu.Build()
    if not fu.IsDone():
        return None
    result = _wrap_topods(fu.Shape())
    if result is None:
        return None
    n_before = len(comp.solids())
    if len(result.solids()) != n_before:
        return None
    gain = result.volume - comp.volume
    if gain <= 1e-9 or gain > gain_cap:
        return None
    # progress check: the fill must consume at least one feature face. A single
    # convex wedge can only fill ONE convex pocket — a chain that wraps several
    # corners (e.g. around a tab end) is filled pocket-by-pocket by _tool_fill_all,
    # so partial consumption here is progress, not failure.
    fps_targets = {fp for fp in (_face_fp(f) for f in targets) if fp is not None}
    consumed = fps_targets - set(_shape_face_fps(result))
    if fps_targets and not consumed:
        return None  # the wedge missed the wound entirely
    if not BRepCheck_Analyzer(result.wrapped).IsValid():
        return None
    solids = result.solids()
    return solids[0] if len(solids) == 1 else Compound(list(solids))


def _tool_fill_all(shape, feature_faces, max_rounds=24):
    """Erase a whole (possibly non-convex) missing-material feature by repeated
    convex wedge fills. A chain that wraps several corners has DIFFERENT support
    pairs per segment — a single global wedge (AND of all half-spaces) degenerates
    — so fill face-by-face: each round targets one remaining face using only ITS
    adjacent supports (fellow feature faces excluded), largest faces first (corner
    patches often gain usable supports only after their strips are filled).
    Succeeds only when EVERY feature face is consumed — a half-filled chamfer
    chain is worse than an honest error. Returns the filled shape or None.

    The ACCUMULATED gain across rounds is capped to the whole feature's
    gain_cap: each round's fill respects its own per-round cap, but a
    degenerate flat remnant can otherwise staircase — round after round each
    under-cap — into many times the feature's volume (measured +20.7 mm³
    from a 1.5 mm² ledge on the DDR honeycomb rim)."""
    cur = shape
    v0 = _as_compound(shape).volume
    total_cap = max(1.0, sum(f.area for f in feature_faces)) * max(
        1.0, max(_face_width(f) for f in feature_faces)
    ) * 3.0
    remaining = sorted(feature_faces, key=lambda f: -f.area)
    for _ in range(max_rounds):
        filled = None
        for target in remaining:
            filled = _tool_fill(cur, [target], feature_faces=remaining)
            if filled is not None:
                break
        if filled is None:
            return None  # no remaining face could be filled — give up honestly
        if _as_compound(filled).volume - v0 > total_cap:
            return None  # staircasing past the whole feature's budget
        # remember the surfaces of the pre-fill remaining set: the fuse can SPLIT
        # a band face at the clip boundary, and the stub keeps its plane but gets
        # a new fingerprint — losing it would hand it to later rounds as a
        # SUPPORT, whose half-space then cuts the next wedge to nothing
        prev = []
        for f in remaining:
            try:
                c = f.center()
                prev.append((f.normal_at(c), c, f.bounding_box()))
            except Exception:
                pass
        cur = filled
        left_fps = {
            fp for fp in (_face_fp(f) for f in remaining) if fp is not None
        } & set(_shape_face_fps(cur))

        def is_fragment(g):
            try:
                gc = g.center()
                gn = g.normal_at(gc)
            except Exception:
                return False
            for n, c, fb in prev:
                if (
                    abs(gn.dot(n)) > 0.999
                    and abs((gc - c).dot(n)) < 0.05
                    and fb.min.X - 0.5 <= gc.X <= fb.max.X + 0.5
                    and fb.min.Y - 0.5 <= gc.Y <= fb.max.Y + 0.5
                    and fb.min.Z - 0.5 <= gc.Z <= fb.max.Z + 0.5
                ):
                    return True
            return False

        remaining = sorted(
            (
                f
                for f in _as_compound(cur).faces()
                if _face_fp(f) in left_fps or is_fragment(f)
            ),
            key=lambda f: -f.area,
        )
        if not remaining:
            return cur
    return None


def _tool_cut(shape, targets, max_planes=12):
    """Erase an EXTRA-material remnant (a broken wall stub, or the ledge left
    by a prior wedge fill) by boolean emulation — the mirror of _tool_fill:
    build the same support-half-space wedge, clipped FLUSH to the remnant's
    own bbox on unbounded axes, and SUBTRACT it instead of fusing. The flush
    clip is what makes the cut honest: on the DDR honeycomb rim the remnant's
    top edge lies exactly on the rim line, so the cut plane coincides with
    real geometry and the rim continues straight across — no invented gash.

    The remnant = the picked face(s) plus the narrow wound-boundary bands
    attached to them (a stub's own side slivers and cap — they'd otherwise
    wall the tool off from the material). Hard-validated like the fill:
    planar supports only, loss capped to remnant size, ≥1 target consumed,
    solid count preserved, valid B-rep; any doubt → None."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.GeomAbs import GeomAbs_SurfaceType

    comp = _as_compound(shape)
    # remnant companions are TARGET-sized: cap band area relative to the
    # picked face(s), else a structural rim band (13 mm² next to a 1.4 mm²
    # ledge) joins the cut set and the tool eats real wall material
    band_cap = 2.0 * sum(t.area for t in targets)
    bands = [
        b
        for b in _wound_boundary(comp, targets)
        if _face_width(b) < 2.5 and b.area <= band_cap
    ]
    cut_set = list(targets) + bands
    cut_fps = {fp for fp in (_face_fp(f) for f in cut_set) if fp is not None}
    supports = [
        b for b in _wound_boundary(comp, cut_set) if _face_fp(b) not in cut_fps
    ]
    if not supports:
        return None
    for b in supports:
        if BRepAdaptor_Surface(b.wrapped).GetType() != GeomAbs_SurfaceType.GeomAbs_Plane:
            return None
    # group parallel same-direction planes, keep the outermost (same staircase
    # rule as _tool_fill), then keep only half-spaces containing the remnant
    groups = []
    for b in supports:
        p0, n = b.center(), b.normal_at(b.center())
        off = p0.dot(n)
        for g in groups:
            if n.dot(g[0]) > 0.9998:
                g[1] = max(g[1], off)
                break
        else:
            groups.append([n, off])
    samples = []
    for f in cut_set:
        samples.append(f.center())
        samples.extend(Vector(v.X, v.Y, v.Z) for v in f.vertices())
    groups = [
        (n, off)
        for n, off in groups
        if all(p.dot(n) <= off + 0.1 for p in samples)
    ]
    if not groups or len(groups) > max_planes:
        return None

    region = Compound(cut_set)
    bb = region.bounding_box()
    d = (bb.max - bb.min).length * 0.2 + 0.5
    lo = [bb.min.X, bb.min.Y, bb.min.Z]
    hi = [bb.max.X, bb.max.Y, bb.max.Z]
    for ax in range(3):
        comps = [(n.X, n.Y, n.Z)[ax] for n, _ in groups]
        if any(v < -0.5 - 1e-9 for v in comps):
            lo[ax] -= d
        if any(v > 0.5 + 1e-9 for v in comps):
            hi[ax] += d
    if min(h - l for h, l in zip(hi, lo)) < 1e-6:
        return None  # flat remnant with no thickness anywhere — nothing to cut
    tool = Pos(
        (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2
    ) * Box(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    for n, off in groups:
        p0 = n * off
        pl = Plane(origin=(p0.X, p0.Y, p0.Z), z_dir=(-n.X, -n.Y, -n.Z))
        tool = split(tool, bisect_by=pl, keep=Keep.TOP)
        if tool is None or not tool.solids():
            return None

    # loss cap mirrors _tool_fill's gain cap: a remnant can't outweigh its
    # own area × extent; more means the tool caught unrelated material
    loss_cap = max(1.0, sum(f.area for f in cut_set)) * max(
        1.0, max(_face_width(f) for f in cut_set)
    ) * 3.0
    # raw OCCT cut, NOT build123d's `-`: the operator's clean() runs a GLOBAL
    # coplanar merge that dissolves the small remnant companions of every
    # OTHER cell into the big skin/floor faces — after one ledge cut, the
    # next ledge would have no band topology left to recognize its stub by.
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.TopTools import TopTools_ListOfShape

    cu = BRepAlgoAPI_Cut()
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(comp.wrapped)
    tools.Append(_as_compound(tool).wrapped)
    cu.SetArguments(args)
    cu.SetTools(tools)
    cu.SetFuzzyValue(1e-5)
    cu.Build()
    if not cu.IsDone():
        return None
    result = _wrap_topods(cu.Shape())
    if result is None:
        return None
    result = _as_compound(result)
    loss = comp.volume - result.volume
    if loss <= 1e-9 or loss > loss_cap:
        return None
    if len(result.solids()) != len(comp.solids()):
        return None
    fps_targets = {fp for fp in (_face_fp(f) for f in targets) if fp is not None}
    if fps_targets and not (fps_targets - set(_shape_face_fps(result))):
        return None  # the cut missed the picked face entirely
    if not BRepCheck_Analyzer(result.wrapped).IsValid():
        return None
    solids = result.solids()
    return solids[0] if len(solids) == 1 else Compound(list(solids))


def _defeature(shape, faces):
    """Remove one or more faces from a solid and heal the gap — deleting an
    (imported) chamfer/fillet or a small protrusion where there's no feature
    history to edit. Four rungs, cheapest first:
      1. stock OCCT defeaturing on the picked face(s),
      2. retry with the whole recognized chamfer/fillet chain (rescues corner
         chamfers — see _expand_blend_chain),
      3. tool-solid fill: fuse a wedge built from the base faces' half-spaces
         (works where extension-healing is structurally unable — ragged or
         tangent supports; see _tool_fill),
      4. tool-solid cut: the subtractive mirror, for EXTRA-material remnants
         (broken wall stubs, prior-fill ledges) that have no bounded fill —
         see _tool_cut. Last on purpose: additive/extension heals are more
         conservative and must win when both apply."""
    healed, alerts = _remove_features(shape, faces)
    if healed is not None:
        return healed
    chain = _expand_blend_chain(shape, faces)
    expanded = len(chain) > len(faces)
    if expanded:
        healed, alerts2 = _remove_features(shape, chain)
        if healed is not None:
            return healed
        alerts += alerts2
    # a FLAT picked face (zero-thickness bbox — e.g. the horizontal ledge a
    # prior wedge fill left on the honeycomb rim) can never be a chamfer to
    # fill: blend-chain expansion from it grabs tangent structural bands and
    # the fill floods their wounds instead. For flat faces the subtractive
    # cut is the honest heal — try it FIRST; sloped chamfers keep fill-first.
    fbb = Compound(list(faces)).bounding_box()
    flat = min(
        fbb.max.X - fbb.min.X, fbb.max.Y - fbb.min.Y, fbb.max.Z - fbb.min.Z
    ) < 1e-6
    if flat:
        cut = _tool_cut(shape, faces)
        if cut is not None:
            return cut
        # no fill fallback for flat faces: a flat face is never a fillable
        # blend, and chain expansion from one grabs tangent structural bands
        # whose wound-fill floods (+20.7 mm³ measured) — honest error instead
    else:
        filled = _tool_fill_all(shape, chain if expanded else faces)
        if filled is not None:
            return filled
        cut = _tool_cut(shape, faces)
        if cut is not None:
            return cut
    detail = f" (OCCT: {', '.join(sorted(set(alerts)))})" if alerts else ""
    tried = (
        f" — even removing its whole {len(chain)}-face chamfer/fillet chain and "
        "wedge-filling the corner"
        if expanded
        else " — wedge-filling didn't apply either"
    )
    raise ValueError(
        "can't heal after removing that face" + tried
        + " — use Press/Pull to cut it instead" + detail
    )
