"""Fusing, cutting and splitting bodies, and knowing when not to bother.

Split out of builder.py. A boolean between two solids is one OCCT call; the rest
of this module is everything around it that stops a document from quietly going
wrong — bounding-box screening so a cut that cannot possibly touch anything is
skipped rather than run, volume checks that catch a no-op, a serial fallback for
a fuse OCCT refuses in one go, and the retargeting that keeps a delete-face
selection pointing at the right face after a body was split in two.

The `bodies` list is the shared thing every one of these edits, so it is passed
in explicitly rather than closed over.
"""

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import Compound, Vector, split

import pick_fuzz
from geom_select import resolve_faces
from plane_spec import KEEP, _plane_of
from progress import progress_tick
from shape_util import _as_compound, _unify_body, _wrapped_or_none

def _bbox_overlap(a, b, tol=1e-6):
    """Cheap AABB overlap test (no boolean, can't crash)."""
    return _bbox_pair_overlap(bbox_of(a), bbox_of(b), tol)


# Memoized exact bounding boxes, keyed by shape OBJECT identity.
#
# An AddOptimal_s walk costs 95.5 s over the 3,072 bodies of the reference
# assembly, and BOTH callers loop over every body in the document — on every
# boolean feature and every interference run. Bodies a feature did not touch keep
# their shape object across rebuilds (rebuild_cached resumes from snapshots), so
# after the first pass a large assembly's boxes are free.
#
# Keyed by id() with the shape held ALIVE in the value, exactly like _SIG_MEMO:
# the strong reference is what makes id() reuse impossible, which is the only way
# an id-keyed cache can go wrong. It relies on the same identity assumption
# _MESH_CACHE already does — a feature that changes geometry produces a NEW shape
# object rather than mutating one in place (texture.py's module docstring spells
# out the one place that could have violated it, and does not).
_BBOX_MEMO = {}
_BBOX_MEMO_CAP = 20000  # ~6 generations of the largest assembly seen; then reset


def bbox_of(shape):
    """A shape's EXACT AABB as a PLAIN TUPLE (minX, minY, minZ, maxX, maxY, maxZ),
    memoized on shape identity (see _BBOX_MEMO).

    The underlying walk is EXPENSIVE and deliberately so: `.bounding_box()` is
    OCCT's AddOptimal_s, measured at 95.5 s over the 3,072 bodies of the 356 MiB
    reference assembly. Callers that loop over every body must still tick (see
    `_interference_job`) — the memo makes the SECOND pass free, not the first.

    The obvious cheap substitute — `BRepBndLib.Add_s(..., useTriangulation=False)`,
    the poles box `_body_fingerprint` uses — was tried here and REJECTED. It is 165x
    faster and usually looser, but on that same assembly it came out up to 0.164 mm
    TIGHTER than exact on 3 of 3,072 bodies (against a 1e-6 compare tol). For a
    fingerprint that is irrelevant; for these callers a box tighter than the truth
    silently drops a real interference or a body a boolean should have touched. If
    you retry this, the property to prove is CONSERVATISM per body over the whole
    document, not average speed — a 500-body sample showed zero violations and was
    simply too small. (Its one genuine advantage: it reports empty compounds as
    void, where the exact call hands back a degenerate point-box at the origin that
    spuriously overlaps anything near it — 8 such bodies in the reference assembly.)

    Two reasons it is a tuple and not the BoundBox.

    The pair sweep is O(n^2) in PAIRS but only O(n) in distinct shapes, so
    recomputing both boxes inside the test does quadratic work for linear
    information: at 3,060 bodies that is 9,360,540 OCCT bounding-box walks
    instead of 3,060.

    And `BoundBox.min.X` is a pybind11 property that calls into OCP on EVERY
    access, up to 12 per pair. Measured over 4,680,270 pairs (3,060 bodies):
    2.58 s reading BoundBox attributes against 0.40 s reading a tuple. The walk
    is hoisted; this hoists the reads out of the walk's result too."""
    key = id(shape)
    hit = _BBOX_MEMO.get(key)
    if hit is not None and hit[0] is shape:
        return hit[1]
    bb = _as_compound(shape).bounding_box()
    box = (bb.min.X, bb.min.Y, bb.min.Z, bb.max.X, bb.max.Y, bb.max.Z)
    if len(_BBOX_MEMO) >= _BBOX_MEMO_CAP:
        # Coarse but bounded: dropping everything costs one repopulating pass,
        # where an LRU would cost a comparison on every hit forever.
        _BBOX_MEMO.clear()
    _BBOX_MEMO[key] = (shape, box)
    return box


def _bbox_pair_overlap(a, b, tol=1e-6):
    """AABB overlap for two boxes already reduced to tuples by `bbox_of`."""
    return (
        a[0] <= b[3] + tol and a[3] >= b[0] - tol
        and a[1] <= b[4] + tol and a[4] >= b[1] - tol
        and a[2] <= b[5] + tol and a[5] >= b[2] - tol
    )


def _try_vol(shape):
    """Best-effort |volume| of a shape. Returns 0.0 for a genuinely EMPTY shape (so
    the no-op boolean guards fire on it), and None only when OCCT truly can't measure
    a non-empty shape. build123d >=0.11 asserts on empty shapes instead of reporting
    zero, so we detect emptiness via `_wrapped_or_none` first."""
    try:
        s = _as_compound(shape)
    except Exception:
        return None
    if _wrapped_or_none(s) is None:
        return 0.0  # empty shape -> zero volume
    try:
        return abs(s.volume)
    except Exception:
        return None


def _noop_eps(ref):
    """Volume change smaller than this (per the op's reference volume) counts as
    "the boolean did nothing": an absolute floor plus a 0.01% relative slice,
    mirroring the tolerances used by _unify_body / cleanup elsewhere in this
    file. The ONE definition every boolean no-op guard shares
    (_boolean_into_bodies for extrude/revolve/loft/sweep, _do_boolean for the
    three body booleans) — tune it here, never inline a copy."""
    return max(1e-6, 1e-4 * (ref or 0.0))


def _shape_extent(*shapes):
    """How far from the origin these shapes reach — the magnitude pick_fuzz
    scales its tolerance by.

    A COARSE box on purpose (BRepBndLib.Add_s walks control points), not
    `bbox_of`'s exact one: this feeds an order-of-magnitude tolerance, and the
    exact walk is AddOptimal_s, measured at 95.5 s over the reference assembly's
    bodies. A control-point box reads a few percent large on curved geometry,
    which moves the fuzz by a few percent and nothing else.
    """
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    box = Bnd_Box()
    for s in shapes:
        for t in s if isinstance(s, (list, tuple)) else [s]:
            w = getattr(t, "wrapped", None)
            if w is None:
                continue
            try:
                BRepBndLib.Add_s(w, box)
            except Exception:
                pass  # a shape we cannot box just doesn't vote on the extent
    if box.IsVoid():
        return None
    lo, hi = box.CornerMin(), box.CornerMax()
    return max(abs(v) for v in (lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()))


def _serial_bool(base, tool, kind):
    """A boolean (kind = "fuse" | "cut" | "common") forced SERIAL.

    build123d's `+`/`-`/`&` hardcode `SetRunParallel(True)`, but OCCT's parallel BOP is
    pathologically slow — ~5-6x — when the tool is MANY small disjoint solids, e.g.
    joining/cutting the ~36 glyph prisms of a sketch text into a body (measured on the
    Basket doc: 1.3s parallel -> 0.23s serial, byte-identical volume + face count). Same
    UnifySameDomain clean and result shape as build123d, so it's a drop-in for the
    operators. `base`/`tool` must already be Compound/Solid (have `.wrapped`);
    `tool` may be a LIST of shapes — one N-tool boolean beats a chained per-tool
    loop, which redoes the whole op + clean per step (O(n²)).

    Runs with a FUZZY VALUE, sized by pick_fuzz — see that module for why. Short
    version: the tool was built from numbers read off the rendered mesh, which is
    single precision, so a profile sketched ON a face is a fraction of an ulp off
    it and OCCT sees two planes where the user meant one. Left exact, a cut from
    such a sketch removes the right volume and still leaves the hole sealed by a
    membrane a nanometre thick, which draws as a filled-in flickering disc."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse, BRepAlgoAPI_Cut, BRepAlgoAPI_Common
    from OCP.TopTools import TopTools_ListOfShape
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

    op = {"fuse": BRepAlgoAPI_Fuse, "cut": BRepAlgoAPI_Cut, "common": BRepAlgoAPI_Common}[kind]()
    la = TopTools_ListOfShape(); la.Append(base.wrapped)
    lb = TopTools_ListOfShape()
    for t in tool if isinstance(tool, (list, tuple)) else [tool]:
        lb.Append(t.wrapped)
    op.SetArguments(la)
    op.SetTools(lb)
    op.SetRunParallel(False)
    op.SetFuzzyValue(pick_fuzz.pick_fuzz(_shape_extent(base, tool)))
    op.Build()
    shape = op.Shape()
    up = ShapeUpgrade_UnifySameDomain(shape, True, True, True)
    up.AllowInternalEdges(False)
    try:
        up.Build()
        shape = up.Shape()
    except Exception:
        pass  # keep the un-cleaned result rather than fail the whole boolean
    return Compound(shape)


def _boolean_into_bodies(bodies, solid, op, new_body, hidden=frozenset()):
    """MCAD-style extrude operation: New Body adds a separate body; Join / Cut /
    Intersect boolean the new solid against EVERY VISIBLE body it overlaps — so an
    extrude that bridges two bodies merges both. Join with nothing to act on just
    adds a new body. HIDDEN bodies are never touched (a hidden body is intentionally
    protected from edits), so they're excluded from the overlap set.

    Guards no-op / destructive booleans: a Join whose prism is already inside the
    body, or a Cut/Intersect that meets no material, used to return the model
    UNCHANGED with no error ("I extruded and nothing happened"). Each op is now
    measured by volume and, when it changed nothing (or Intersect would empty a
    body), raises ValueError — the rebuild loop records it as a feature error and
    flags the feature red, instead of silently doing nothing. Volume-read failures
    fall through to the old behavior (never raise a misleading no-op error)."""
    # Extruding several DISJOINT region faces (e.g. 38 selected honeycomb cells)
    # yields a build123d ShapeList, which has no .bounding_box()/boolean ops —
    # normalize to one Compound so overlap-testing and cut/join/intersect work.
    solid = _as_compound(solid)
    if op == "new":
        new_body(solid)
        return
    # Tick per body. `_bbox_overlap` runs the EXACT `bbox_of` on each candidate,
    # measured 95.5 s over the 3,072 bodies of the 356 MiB reference assembly —
    # past the 60 s STALL_TIMEOUT, and `rebuild`'s tick is per FEATURE, so it has
    # already been spent by the time this loop starts. Unticked, a Join/Cut on a
    # freshly imported assembly is reaped mid-filter and dies with nothing logged.
    # This is still slow; the tick is what lets it finish and report progress.
    hits = []
    for b in bodies:
        progress_tick()
        if (b.get("shape") is not None
                and b.get("id") not in hidden
                and _bbox_overlap(b["shape"], solid)):
            hits.append(b)
    # a change smaller than this counts as "nothing happened" — shared by every
    # boolean guard site (here and _do_boolean) so the tolerance convention
    # can't drift between features.
    eps = _noop_eps

    prism_vol = _try_vol(solid)
    if op == "join":
        if not hits:
            new_body(solid)
            return
        merged = solid
        for b in hits:
            merged = _serial_bool(merged, _as_compound(b["shape"]), "fuse")  # serial: parallel BOP is ~5x slower for many-glyph tools
        # No-op guard: the fused volume should exceed what was already there. If it
        # doesn't, the prism sat entirely inside the body and added no material.
        merged_vol, hit_vol = _try_vol(merged), _sum_hit_vol(hits)
        if merged_vol is not None and hit_vol is not None \
                and merged_vol <= hit_vol + eps(prism_vol):
            # LESS than was there before is a different diagnosis. Nothing a
            # union can legitimately do removes material, so the fuse itself came
            # back wrong, and the usual reason is that the two shapes meet along a
            # surface rather than crossing one another: a thread whose root sits
            # exactly on the shank it is wound onto, a boss landing exactly on the
            # plane it was drawn from. Measured on such a thread, the fuse of a
            # 942 mm3 shank and a 168 mm3 thread came back as 56 mm3. Telling that
            # user the profile is "already inside the body" sends them to look in
            # entirely the wrong place.
            if merged_vol < hit_vol - eps(hit_vol):
                raise ValueError(
                    "Join failed: the result came out smaller than the body it "
                    "started from. That usually means the two shapes touch along "
                    "a surface instead of overlapping. Move the profile so it "
                    "reaches a little way into the body."
                )
            raise ValueError(
                "Join added no material — the profile is already inside the body. "
                "Did you mean Cut?"
            )
        name = hits[0]["name"]
        for b in hits:
            bodies.remove(b)
        # joins of ragged bodies GLUE solids instead of merging them (interior
        # walls, coincident skins, visible seams at every contact); unify right
        # here so a join yields ONE true solid. Fast no-op on clean results
        # (single right-side-out solid), hard-gated otherwise.
        new_body(_unify_body(merged), name)
    elif op == "cut":
        # compute every cut first, measure how much came off, and only commit when
        # the extrude actually removed material from some body.
        results, removed, measured = [], 0.0, False
        for b in hits:
            before = _try_vol(b["shape"])
            newshape = _serial_bool(_as_compound(b["shape"]), solid, "cut")
            after = _try_vol(newshape)
            # A cut that consumes a whole body leaves nothing to select, nothing
            # to see and nothing in the timeline saying where it went — the body
            # is simply gone at the next repaint. Say so, the same way Intersect
            # already does, and leave the model as it was.
            if before is not None and after is not None and after < eps(before):
                raise ValueError(
                    f"Cut would remove all of {b.get('name') or 'this body'}. "
                    "Shorten it, or select a smaller area."
                )
            results.append((b, newshape))
            if before is not None and after is not None:
                measured = True
                removed += max(0.0, before - after)
        if not hits or (measured and removed < eps(prism_vol)):
            raise ValueError(
                "Cut removed nothing — the extrude doesn't reach any body. "
                "Drag the other way, or use Join."
            )
        for b, newshape in results:
            b["shape"] = newshape
    elif op == "intersect":
        if not hits:
            raise ValueError(
                "Intersect left nothing — the profile doesn't overlap any body."
            )
        results = []
        for b in hits:
            newshape = _serial_bool(_as_compound(b["shape"]), solid, "common")
            v = _try_vol(newshape)
            if v is not None and v < eps(_try_vol(b["shape"])):
                raise ValueError(
                    "Intersect would leave the body empty — the profile doesn't "
                    "overlap it."
                )
            results.append((b, newshape))
        for b, newshape in results:  # commit only after all hits pass the guard
            b["shape"] = newshape
    else:
        raise ValueError(f"unknown extrude operation: {op}")


def _sum_hit_vol(hits):
    """Total |volume| of the hit bodies, or None if any can't be measured (so the
    join no-op guard stays conservative rather than firing on a bad read)."""
    total = 0.0
    for b in hits:
        v = _try_vol(b["shape"])
        if v is None:
            return None
        total += v
    return total


def _vertex_components(solids):
    """Group solids into physically-connected pieces (union-find over solids that
    share a vertex). A connected lump — even one OCCT reports as many sub-solids
    (a honeycomb half is dozens) — collapses to one group; genuinely separate lumps
    stay apart. Returns a list of solid-lists."""
    n = len(solids)
    if n <= 1:
        return [list(solids)] if solids else []
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    vmap = {}
    for i, s in enumerate(solids):
        for v in s.vertices():
            vmap.setdefault((round(v.X, 3), round(v.Y, 3), round(v.Z, 3)), []).append(i)
    for idxs in vmap.values():
        for j in idxs[1:]:
            parent[find(idxs[0])] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(solids[i])
    return list(groups.values())


def _do_split(f, bodies, find_body, active, new_body, datums):
    """Cut a body by a plane. keep=top/bottom keeps one side (replaces the body);
    keep=both splits it into separate bodies. `bodies` cuts every listed body
    ("cut all visible"); new pieces append to the global list, not `targets`, so
    the loop is snapshot-safe."""
    # cut by an existing datum plane (planeId) or an inline plane
    plane = _plane_of(f.get("planeId") or f["plane"], datums)
    keep = f.get("keep", "both")
    if keep not in KEEP:
        raise ValueError(f"unknown split keep mode: {keep}")
    if f.get("bodies"):
        targets = [t for t in (find_body(b) for b in f["bodies"]) if t is not None]
    else:
        one = find_body(f["body"]) if f.get("body") else active()
        targets = [one] if one is not None else []
    if not targets:
        raise ValueError("Split needs an existing body")
    for target in targets:
        res = split(target["shape"], bisect_by=plane, keep=KEEP[keep])
        pieces = res.solids()
        if keep == "both" and len(pieces) > 1:
            if f.get("groupSides"):
                # One body per physically-SEPARATE piece. First split the solids by
                # SIDE of the plane (the two halves touch along the cut, so pure
                # connectivity would falsely merge them), then within each side group
                # solids that are actually connected. So a connected half stays ONE
                # body (a honeycomb half is dozens of solids → one piece), while
                # genuinely disconnected lumps (separate tabs) each get their own.
                # OPT-IN (new splits only) — body ids are positional, so changing the
                # count would renumber downstream bodies and break older files.
                n, o = plane.z_dir, plane.origin
                top = [p for p in pieces if (p.center() - o).dot(n) >= 0]
                bottom = [p for p in pieces if (p.center() - o).dot(n) < 0]
                groups = _vertex_components(top) + _vertex_components(bottom)
                if groups:
                    def _one(g):
                        return g[0] if len(g) == 1 else Compound(g)
                    target["shape"] = _one(groups[0])
                    for g in groups[1:]:
                        new_body(_one(g), "Split")
                else:
                    target["shape"] = res
            else:
                # legacy: one body per disconnected solid. Kept as the default so files
                # saved before `groupSides` keep their exact positional body ids (any
                # change to the body count cascades into every downstream body ref).
                target["shape"] = pieces[0]
                for p in pieces[1:]:
                    new_body(p, "Split")
        elif not pieces:
            # a plane that misses one of several bodies shouldn't fail the whole
            # cut — only error when the sole target wasn't intersected.
            if len(targets) == 1:
                raise ValueError("the plane does not intersect the body")
        else:
            target["shape"] = res


def _retarget_delete_faces(named, bodies, sels, diag, fid):
    """Resolve deleteFace selectors with global geometric re-targeting.

    Nearest-point selectors resolve across ALL bodies: the face closest to the
    recorded pick point wins, wherever it lives. This keeps the app's core
    invariant (geometry by geometric selector, never index) honest for the BODY
    reference too — body ids are positional, so an upstream split/boolean
    renumbers them and the named body can quietly become a different piece of
    the part; the delete's nearest match on that wrong piece is then some
    distant face and the heal fails (measured: one inserted split turned all 9
    saved deletes red). Legitimate geometry shifts (an edited upstream dimension
    moving the face) keep working exactly as before — the moved face is still
    the global nearest. Non-point selectors (normal/axis/match) have no pick
    point to re-anchor by and stay on the named body.

    Returns (body, faces); body is None when nothing can anchor the delete. A
    re-target to a body other than the named one is recorded in `diag` as a
    lossy resolution."""
    live = [b for b in bodies if b.get("shape") is not None]
    points = [
        Vector(*sel["point"])
        for sel in sels
        if isinstance(sel, dict) and sel.get("by") == "nearest" and sel.get("point")
    ]
    has_named = named is not None and named.get("shape") is not None

    if not points or not live:
        # nothing to re-anchor by — classic resolution on the named body
        if not has_named:
            return None, []
        faces = []
        for sel in sels:
            faces.extend(resolve_faces(named["shape"], sel, diag=diag, feature_id=fid))
        return named, faces

    def bbox_dist(b, p):
        # _as_compound: a mid-timeline body can be a disjoint ShapeList, which
        # has neither .bounding_box() nor a single wrapped TopoDS
        bb = _as_compound(b["shape"]).bounding_box()
        dx = max(bb.min.X - p.X, 0.0, p.X - bb.max.X)
        dy = max(bb.min.Y - p.Y, 0.0, p.Y - bb.max.Y)
        dz = max(bb.min.Z - p.Z, 0.0, p.Z - bb.max.Z)
        return (dx * dx + dy * dy + dz * dz) ** 0.5

    # pass 1: the body owning the globally-nearest face to the first pick point
    # (a delete heals ONE solid; all of a multi-face delete's picks were made on
    # the same body, so the first point is a sound anchor). Cheap bbox lower
    # bound first, so distant bodies never pay a face scan.
    p0 = points[0]
    winner = None  # (dist, body)
    for b in sorted(live, key=lambda b: bbox_dist(b, p0)):
        if winner is not None and bbox_dist(b, p0) >= winner[0]:
            break
        try:
            d = min(fc.distance_to(p0) for fc in _as_compound(b["shape"]).faces())
        except Exception:
            continue
        if winner is None or d < winner[0]:
            winner = (d, b)
    if winner is None:
        return (named, []) if has_named else (None, [])

    target = winner[1]
    if has_named and target is not named and diag is not None:
        diag.append({
            "feature_id": fid,
            "kind": "deleteFace",
            "resolved": 1,
            "confidence": 0.8,
            "lossy": True,
            "reason": f"picked face found on {target['id']} "
                      f"(body ids shifted upstream); re-targeted from {named['id']}",
        })

    # pass 2: resolve every selector on the winning body
    faces = []
    for sel in sels:
        faces.extend(resolve_faces(target["shape"], sel, diag=diag, feature_id=fid))
    return target, faces


# The document's word for each boolean -> the kernel's. The frontend writes
# union/subtract/intersect, which is what the three commands are called; OCCT
# calls the same three fuse/cut/common.
#
# The v8 spellings are accepted too. document/migrate.ts rewrites `combine`
# features on load so the app never sends them, but a document does not have to
# arrive through the app — a fixture, a script, a hand-written test — and a
# three-entry dict is cheaper than a class of input that opens and will not
# build.
_BOOL_KINDS = {
    "union": "fuse",
    "subtract": "cut",
    "intersect": "common",
    "join": "fuse",
    "cut": "cut",
}


def _do_boolean(f, bodies, find_body, diag=None):
    """A boolean between bodies: union (+), subtract (-) or intersect (&). The
    target body is modified in place; tool bodies are consumed unless
    keepOriginals is set.

    Dangling references are NON-FATAL: if the target — or every tool — has already
    been consumed by an earlier boolean (or renumbered away by an upstream edit;
    body ids are positional), the feature becomes a no-op recorded in `diag` rather
    than halting the whole rebuild. Re-uniting a body an earlier union already
    merged is geometrically idempotent, so skipping a stale duplicate yields the
    intended result; for subtract/intersect, doing nothing is the safe fallback over
    cutting the wrong body. A malformed operation is still a hard error."""
    op = f["operation"]
    kind = _BOOL_KINDS.get(op)
    if kind is None:
        raise ValueError(f"unknown boolean operation: {op}")
    label = {"fuse": "Union", "cut": "Subtract", "common": "Intersect"}[kind]
    target = find_body(f["target"]) if f.get("target") else (bodies[0] if bodies else None)
    if target is None:
        _skip_feature(diag, f, "boolean", "target body already consumed or missing")
        return
    tool_ids = f.get("tools") or [b["id"] for b in bodies if b["id"] != target["id"]]
    tools = [t for t in (find_body(tid) for tid in tool_ids) if t is not None and t["id"] != target["id"]]
    if not tools:
        _skip_feature(diag, f, "boolean", "tool bodies already consumed or missing")
        return

    shape = target["shape"]
    before_vol = _try_vol(shape)
    # _serial_bool, not build123d's +/-/&: a tool body is often a compound of
    # MANY disjoint solids (explode:false import, multi-region extrude) —
    # exactly the shape class where OCCT's parallel BOP is ~5x slower than
    # serial (see _serial_bool). Same UnifySameDomain clean, same result.
    for t in tools:
        shape = _serial_bool(_as_compound(shape), _as_compound(t["shape"]), kind)
    # No-op / destructive guards, same volume-eps convention as
    # _boolean_into_bodies. Only the SILENT failure modes raise: a subtract that
    # removed nothing still consumes the tools (the user loses bodies and gains
    # nothing), and an intersect that empties the target destroys it outright.
    # Union-with-embedded-tool and intersect-inside-tool are NOT guarded — their
    # volume is unchanged but they visibly absorb the tool bodies, which is a
    # legitimate, observable operation (unlike extrude, nothing here is silent).
    # Volume-read failures skip the guard (never raise a misleading no-op error).
    after_vol = _try_vol(shape)
    if before_vol is not None and after_vol is not None:
        guard_eps = _noop_eps(before_vol)
        if kind == "cut" and after_vol >= before_vol - guard_eps:
            raise ValueError(
                f"{label} removed nothing — no tool body overlaps the one being kept."
            )
        # ...and the mirror-image silent failure: a subtract that removes
        # EVERYTHING. Cutting a body with an identical coincident one left a body
        # of volume 0.0 and no error at all, so the browser tree gained a phantom
        # body that cannot be seen, selected meaningfully, or printed
        # (docs/EDGE-CASES.md §3). Same class as the no-op above — the user loses
        # their body and is told nothing.
        if kind == "cut" and after_vol < guard_eps:
            raise ValueError(
                f"{label} would remove the whole body — the tools cover all of it."
            )
        if kind == "common" and after_vol < guard_eps:
            raise ValueError(
                f"{label} would leave nothing — the tools don't overlap the body."
            )
    # A union of ragged/facet-heritage bodies GLUES solids instead of merging
    # them: the "united" body stays a compound of pieces sharing interior
    # walls, with coincident skins and a visible seam at every contact — the
    # boolean-rot class the cleanUp feature repairs after the fact. Repair it
    # AT THE SOURCE so a union yields one true solid. _unify_body is a fast
    # no-op on clean results and hard-validated (any doubt → unchanged), and
    # replayed history heals existing unions on the next rebuild.
    target["shape"] = _unify_body(shape) if kind == "fuse" else shape

    # keepOriginals leaves the tool bodies in the model, which is what makes one
    # body usable as a cutter more than once. `keepTools` is the pre-v9 spelling,
    # read for the same reason the pre-v9 operation names are.
    if not (f.get("keepOriginals") or f.get("keepTools")):
        consumed = {t["id"] for t in tools}
        bodies[:] = [b for b in bodies if b["id"] not in consumed]


def _skip_feature(diag, f, kind, reason):
    """Record a non-fatal stale-body-reference skip for any feature (same
    shape as geom_select's selector diagnostics) — so the rebuild result
    surfaces that the feature did nothing instead of silently dropping it.
    No `diag` list = nothing recorded, and the feature is simply skipped."""
    if diag is None:
        return
    diag.append(
        {
            "feature_id": f.get("id"),
            "kind": kind,
            "resolved": 0,
            "confidence": 0.0,
            "lossy": True,
            "reason": reason,
        }
    )
