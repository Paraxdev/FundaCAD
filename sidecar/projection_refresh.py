"""Projected sketch geometry: re-resolving it against the model each rebuild, and projecting new sources."""

import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py
from geom_select import (
    _edge_dedup_key,
    edge_fingerprint,
    resolve_edges,
    resolve_faces,
)
from handler_util import _make_val
from plane_spec import _plane_of, _sketch_plane_ref
from projection import (
    _assign_silhouette,
    _curve_close,
    _project_edge_to_plane,
    _project_silhouette,
)
from sketch_build import _entity_edges


def _recompute_projections(f, ctx):
    """Associative refresh of one sketch's projected entities, run by
    _handle_sketch right after the sketch is built: re-resolve every source
    against the TIMELINE-PREFIX state (ctx.bodies = the bodies built before
    this sketch; the features list before it for cross-sketch sources) and
    append change entries to ctx.projections.

    Convergence contract (what terminates the frontend's refresh loop): steady
    state emits NOTHING. A fresh curve is emitted only when it differs from the
    cached one beyond _curve_close's 1e-4 tolerance, or the entity was stale
    and resolves again (stale:false clears the flag). {stale: true} is emitted
    only on the not-stale -> stale TRANSITION. Resolution here is LENIENT
    (keep-last-shape + stale flag); the strict refuse-at-pick path is
    project_geometry's.

    Multi-edge sketchCurve correspondence: a source entity yielding several
    edges (rectangle/polygon/slot) was projected as N sibling entities sharing
    source.group. The pick site persists each sibling's edge index within
    _entity_edges' deterministic order as source.index, the authoritative
    correspondence, stable across sibling deletions AND source moves. A
    multi-edge sibling WITHOUT an index is unresolvable -> stale, like an
    unknown source kind. An index beyond the fresh edge count means that
    edge is gone -> stale.

    Silhouette correspondence: a silhouette source has NO per-curve selectors,
    the source is the whole body, and the fresh HLR curve LIST can change count
    and order across rebuilds. Each group's siblings (shortlex id order) are
    matched against the fresh list in three passes, each fresh curve consumed
    at most once: (1) cached-curve match within _curve_close tolerance (steady
    state); (2) NEAREST same-kind curve by _curve_dist, endpoint + midpoint
    distance, pairs consumed in globally ascending order, so a resized
    cylinder's silhouette lines track their own side; (3) the remaining
    siblings positionally against the remaining fresh curves. Assigned curves
    are orientation-normalized to the cached endpoint order (_curve_oriented).
    Siblings beyond the fresh set go stale; fresh curves with no sibling are
    DROPPED (re-run the Project pick to pick up new outline curves, auto-add
    from a refresh is deferred)."""
    ents = [e for e in f.get("entities") or []
            if isinstance(e, dict) and e.get("type") == "projected" and e.get("id")]
    if not ents:
        return
    plane = _plane_of(_sketch_plane_ref(f), ctx.datums)
    # features strictly BEFORE this sketch: the prefix a source may live in
    prefix = []
    for ft in ctx.features or []:
        if ft is f or ft.get("id") == f.get("id"):
            break
        prefix.append(ft)
    # per-(sketch, entity) fresh sketchCurve projection memo, filled lazily by
    # _fresh_projection, siblings of one multi-edge source share the projected
    # list instead of re-projecting the whole source per sibling
    curve_fresh = {}

    # silhouette groups: one fresh HLR curve list per BODY (computed once), each
    # (body, group) sibling set assigned from its own copy of that list
    sil_groups = {}
    for e in ents:
        s = e.get("source") or {}
        if s.get("kind") == "silhouette":
            sil_groups.setdefault((s.get("body"), s.get("group")), []).append(e)
    sil_assign = {}
    sil_fresh = {}
    for (body_id, _g), group in sil_groups.items():
        group.sort(key=lambda x: (len(x["id"]), x["id"]))
        if body_id not in sil_fresh:
            body = ctx.find_body(body_id)
            try:
                sil_fresh[body_id] = (
                    _project_silhouette(body["shape"], plane)
                    if body is not None and body.get("shape") is not None
                    else None
                )
            except Exception:
                sil_fresh[body_id] = None  # HLR failure = lost source (lenient)
        sil_assign.update(_assign_silhouette(group, sil_fresh[body_id]))

    for e in ents:
        if (e.get("source") or {}).get("kind") == "silhouette":
            fresh = sil_assign.get(e["id"])
        else:
            try:
                fresh = _fresh_projection(e, plane, prefix, curve_fresh, ctx)
            except Exception:
                fresh = None  # any resolution/projection failure = lost source
        if fresh is None:
            if not e.get("stale"):
                ctx.projections.append(
                    {"sketch": f["id"], "entity": e["id"], "stale": True}
                )
        elif e.get("stale") or not _curve_close(fresh, e.get("curve") or {}):
            ctx.projections.append(
                {"sketch": f["id"], "entity": e["id"], "curve": fresh, "stale": False}
            )


def _fresh_projection(e, plane, prefix, curve_fresh, ctx):
    """The freshly-projected curve for one projected entity, or None when its
    source no longer resolves against the prefix state (missing body / sketch /
    entity, ambiguous match). `curve_fresh` memoizes the projected edge list
    per sketchCurve source across one sketch's entities. Silhouette entities
    never reach here, their group-level correspondence runs in
    _recompute_projections."""
    src = e.get("source") or {}
    kind = src.get("kind")
    if kind in ("edge", "faceBoundary"):
        # faceBoundary persists PER-EDGE by:"match" sels too (see the pick site
        # in sketchMode.ts), both kinds resolve via resolve_edges. LENIENT on
        # purpose: an upstream resize makes the fingerprint a "marginal match"
        # (length changed), which is exactly the association we must follow,
        # only a body/edge that no longer resolves AT ALL goes stale.
        body = ctx.find_body(src.get("body"))
        if body is None or body.get("shape") is None:
            return None
        edges = resolve_edges(body["shape"], src.get("sel"))
        if not edges:
            return None  # the source edge is gone, keep last shape
        return _project_edge_to_plane(edges[0], plane)
    if kind == "sketchCurve":
        key = (src.get("sketch"), src.get("entity"))
        if key not in curve_fresh:
            try:
                src_plane, eds = _resolve_sketch_curve(prefix, src, ctx.datums, ctx.val)
                curve_fresh[key] = [
                    _project_edge_to_plane(src_plane * ed, plane) for ed in eds
                ]
            except Exception:
                curve_fresh[key] = None  # lost source (lenient), memoized
        fresh = curve_fresh[key]
        if not fresh:
            return None
        if len(fresh) == 1:
            return fresh[0]
        idx = src.get("index")
        if isinstance(idx, int):
            # authoritative pick-time edge index (see the docstring above)
            return fresh[idx] if 0 <= idx < len(fresh) else None
        return None  # multi-edge sibling without an index: unresolvable
    return None  # unknown kind: unresolvable


def _require_body(bodies, bid):
    """The prefix body `bid` with live shape, or the strict pick-time refusal."""
    body = next((b for b in bodies if b["id"] == bid), None)
    if body is None or body.get("shape") is None:
        raise ValueError(
            f'source body "{bid}" is not available here, '
            "it may have been created after this sketch"
        )
    return body


def _resolve_sketch_curve(features, src, datums, val):
    """Resolve a sketchCurve source against `features` to (source plane, local
    boundary edges). Raises with the strict pick-time messages on a missing
    sketch / entity or an entity with no curve; the lenient refresh path
    (_fresh_projection) catches any raise and treats it as a lost source."""
    sf = next(
        (f for f in features
         if f.get("type") == "sketch" and f.get("id") == src.get("sketch")),
        None,
    )
    if sf is None:
        raise ValueError(
            f'source sketch "{src.get("sketch")}" is not available here, '
            "it may have been created after this sketch"
        )
    ent = next(
        (e for e in sf.get("entities") or [] if e.get("id") == src.get("entity")),
        None,
    )
    if ent is None:
        raise ValueError("the source curve no longer exists in its sketch")
    eds = _entity_edges(ent, val)
    if not eds:
        raise ValueError(f'a "{ent.get("type")}" entity has no curve to project')
    return _plane_of(sf["plane"], datums), eds


def _project_source(src, plane, document, bodies, datums):
    """Resolve ONE projection source to its [{fp?, curve}] list, or raise with a
    user-facing message. Source kinds: edge / faceBoundary / sketchCurve /
    silhouette (whole-body HLR outline)."""
    kind = src.get("kind")
    if kind in ("edge", "faceBoundary"):
        body = _require_body(bodies, src.get("body"))
        shape = body["shape"]
        diag = []
        if kind == "edge":
            edges = resolve_edges(shape, src["sel"], diag=diag)
        else:
            seen = {}
            for fc in resolve_faces(shape, src["sel"], diag=diag):
                for e in fc.edges():
                    seen.setdefault(_edge_dedup_key(e), e)
            edges = list(seen.values())
        if not edges:
            raise ValueError("the source geometry no longer exists on the body")
        # LOSSY is the flag that means "this resolution took a best-effort or
        # marginal path", every diagnostic assertion in the suite keys on it.
        # Refusing on a merely non-empty `diag` was equivalent once, but it also
        # swept up advisory entries and turned a perfectly good pick into a hard
        # failure (see the note in geom_select._nearest_one).
        lossy = next((d for d in diag if d.get("lossy")), None)
        if lossy is not None:
            raise ValueError(
                "the source selection is ambiguous on this body, "
                + (lossy.get("reason") or "low-confidence match")
            )
        return [
            {"fp": edge_fingerprint(e, shape), "curve": _project_edge_to_plane(e, plane)}
            for e in edges
        ]
    if kind == "sketchCurve":
        val = _make_val(document.get("parameters", {}))
        src_plane, eds = _resolve_sketch_curve(
            document.get("features", []), src, datums, val
        )
        return [{"curve": _project_edge_to_plane(src_plane * ed, plane)} for ed in eds]
    if kind == "silhouette":
        body = _require_body(bodies, src.get("body"))
        curves = _project_silhouette(body["shape"], plane)
        if not curves:
            raise ValueError("the body has no visible silhouette on this plane")
        # whole-body source: no per-curve fingerprints (refresh re-runs HLR and
        # re-matches by curve, see _recompute_projections)
        return [{"curve": c} for c in curves]
    raise ValueError(f"unknown projection source kind: {kind}")
