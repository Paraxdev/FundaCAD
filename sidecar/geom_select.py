"""Selector resolution — the topological-naming mitigation.

Geometry is NEVER referenced by index. References are queryable property
descriptors, re-resolved against the freshly built solid on every rebuild.

Edge selectors:
  {"kind":"edge", "by":"axis",    "axis":"Z"}          edges parallel to Z (ALL of them)
  {"kind":"edge", "by":"all"}                          every edge
  {"kind":"edge", "by":"nearest", "point":[x,y,z]}     edge nearest a 3D point
  {"kind":"edge", "by":"match",   "fp":{...}, "nth":k} ONE edge by scored fingerprint
  {"kind":"edge", "by":"tangentChain", "seed":{...}}   an edge + its tangent-continuous chain
  {"kind":"edge", "by":"ofFace",  "face":{...}}        all edges bounding a face

Face selectors:
  {"kind":"face", "by":"normal",  "dir":[0,0,1]}       faces whose normal ~ dir (ALL)
  {"kind":"face", "by":"nearest", "point":[x,y,z]}     face nearest a 3D point
  {"kind":"face", "by":"match",   "fp":{...}, "nth":k} ONE face by scored fingerprint
  {"kind":"face", "by":"all"}                          every face

--- selector v2 (`by:"match"` / structural forms) -----------------------------

The legacy `axis`/`normal` forms mean "ALL parallel / co-normal entities" — they
cannot mean "this ONE edge/face". `nearest` is the only single-entity legacy form
and it collides when two entities share a midpoint/centroid (concentric circles,
mirrored features) or when the rebuilt OCCT geometry drifts slightly from the kernel
that authored the selector.

`match` fixes that: it carries a multi-invariant geometric FINGERPRINT (edge:
midpoint + direction + length [+ radius/center for arcs]; face: centroid + normal +
area [+ radius]) and resolves by SCORING every candidate on the fields that are
present, lowest cost wins. Two concentric circles differ in radius/center; two
mirrored edges differ in midpoint; a drifted edge still matches because each invariant
is compared with tolerance, not equality. The margin to the runner-up is the
confidence; a genuine tie (symmetric twins) is broken by `nth` over a rebuild-stable
canonical order.

Resolution is BEST-EFFORT and never raises on a poor match: it returns the
lowest-cost candidate and records a `ResolveDiag` (confidence + lossy flag) via the
optional `diag` accumulator, so the rebuild always completes and downstream tooling
can see which selections were shaky. It returns nothing only when the body has no
candidates at all.

NOTE: the frontend now emits `by:"match"` edge selectors — the Project tool
persists sidecar-authored fingerprints as the source reference of projected
sketch entities (builder._recompute_projections resolves them on every rebuild,
and the projectGeometry op authors them). `by:"tangentChain"` is implemented and
covered by test_selector_v2.py but still has no frontend caller.
"""

import json
import math
import os

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import Axis, Vector, GeomType

AXES = {"X": Axis.X, "Y": Axis.Y, "Z": Axis.Z}

# --- tunable scoring constants -----------------------------------------------
# The ONLY thing governing how `by:"match"` scores candidates. Externalized to
# selector_tuning.json so an optimization loop can tune them without touching
# resolver logic; the defaults below are authoritative fallbacks, so a missing key
# (or the whole file) leaves shipped behaviour unchanged.
#
#   ANG_TOL      ~1.1deg of slack on (1 - |dot|) for dir/normal
#   POS_DRIFT    mm of absolute positional drift budget (kernel disagreement)
#   REL_DRIFT    + this * bbox diagonal (position tol scales with the part)
#   LEN_REL_TOL  2% on length / radius
#   AREA_REL_TOL 5% on area
#   TIE_BAND     runner-up within 15% of best => a genuine tie (need nth)
#   NEAREST_TIE_BAND  same idea for by:"nearest" but on RAW DISTANCE, so far
#                tighter. What must be refused is the degenerate case where two
#                entities are indistinguishable by this metric at all (a point on a
#                shared edge, or on a circle's axis). On the real corpus the
#                references that silently flipped were EXACT ties (margin 0.0000)
#                while legitimate picks cleared 2% easily.
#   ACCEPT_MAX   best cost above this => resolvable but marginal (lossy)
#   W_*          scoring weights, per normalized error term
#   W_RANK       penalty per rank step for concentric rims (scale-invariant)
_DEFAULTS = {
    "ANG_TOL": 0.02,
    "POS_DRIFT": 0.5,
    "REL_DRIFT": 1e-3,
    "LEN_REL_TOL": 0.02,
    "AREA_REL_TOL": 0.05,
    "TIE_BAND": 0.15,
    "NEAREST_TIE_BAND": 0.02,
    "ACCEPT_MAX": 2.5,
    "W_POS": 3.0,
    "W_DIR": 2.0,
    "W_LEN": 1.0,
    "W_RAD": 2.0,
    "W_AREA": 1.0,
    "W_TYPE": 4.0,
    "W_RANK": 2.0,
}
_TUNING = dict(_DEFAULTS)


def _apply_tuning():
    """Push the current _TUNING values onto module globals (ANG_TOL, W_POS, ...)."""
    globals().update({k: float(_TUNING[k]) for k in _DEFAULTS})


def configure(src):
    """Override tuning constants from a dict or a JSON file path.

    Missing keys keep their default. Unknown keys are ignored. The oracle calls
    this once per experiment with the config under test; the app auto-loads
    selector_tuning.json at import (below) for the shipped values.
    """
    if isinstance(src, str):
        with open(src) as f:
            src = json.load(f)
    _TUNING.update({k: src[k] for k in _DEFAULTS if k in src})
    _apply_tuning()


_apply_tuning()
try:
    configure(os.path.join(os.path.dirname(__file__), "selector_tuning.json"))
except FileNotFoundError:
    pass


# --- small helpers -----------------------------------------------------------


def _v(seq):
    return Vector(*seq) if not isinstance(seq, Vector) else seq


def _finite3(seq, want=None):
    """A document-supplied coordinate list, rounded, or None if it is not one.

    Selector points come out of the document file with no schema in front of
    them, and build123d's Vector SILENTLY collapses non-numeric args to (0,0,0)
    rather than raising, so an unchecked point does not fail, it relocates.
    Callers that need a real point must treat None as "no point". `want` pins the
    length where the caller knows it (3 for a coordinate)."""
    try:
        vals = list(seq)
    except TypeError:
        return None
    if want is not None and len(vals) != want:
        return None
    out = []
    for v in vals:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        if not math.isfinite(v):
            return None
        out.append(round(float(v), 6))
    return out or None


def _dist(a, b):
    return (a - b).length


def _unit(v):
    n = v.length
    return v / n if n > 1e-12 else v


def _rel_err(a, b):
    d = max(abs(a), abs(b), 1e-9)
    return abs(a - b) / d


def _bbox_diag(part):
    try:
        bb = part.bounding_box()
        return (bb.max - bb.min).length or 1.0
    except Exception:
        return 1.0


def _edge_curve(e):
    """Coarse curve class name matching EdgeFingerprint.curve."""
    try:
        n = e.geom_type.name.lower()
    except Exception:
        return "other"
    if n == "line":
        return "line"
    if n == "circle":
        return "circle"
    if n == "ellipse":
        return "ellipse"
    if n in ("bspline", "bezier"):
        return "bspline"
    return "other"


def _edge_mid(e):
    """Midpoint of the edge (fraction 0.5 of its LENGTH), with a center() fallback."""
    try:
        return e.position_at(0.5)
    except Exception:
        return e.center()


def _edge_dir(e):
    """Unit tangent at the midpoint, sign-normalized (edges are unoriented, so a
    reversed rebuilt edge still matches). Falls back to the chord direction."""
    try:
        d = _unit(e.tangent_at(0.5))
    except Exception:
        try:
            verts = e.vertices()
            d = _unit(Vector(verts[-1].to_tuple()) - Vector(verts[0].to_tuple()))
        except Exception:
            return Vector(0, 0, 0)
    return _sign_normalize(d)


def _sign_normalize(d):
    """Make the first non-tiny component positive, so +dir and -dir hash the same."""
    for c in (d.X, d.Y, d.Z):
        if abs(c) > 1e-9:
            return d if c > 0 else d * -1
    return d


def _edge_radius(e):
    try:
        return float(e.radius)
    except Exception:
        return None


def _edge_center(e):
    try:
        return e.arc_center
    except Exception:
        return None


def _face_surface(f):
    try:
        n = f.geom_type.name.lower()
    except Exception:
        return "other"
    if n in ("plane", "cylinder", "cone", "sphere", "torus"):
        return n
    if n in ("bspline", "bezier"):
        return "bspline"
    return "other"


def _face_centroid(f):
    try:
        return f.center()
    except Exception:
        return _v((0, 0, 0))


def _face_normal(f):
    try:
        return _unit(f.normal_at())
    except Exception:
        return Vector(0, 0, 0)


def _face_radius(f):
    try:
        return float(f.radius)
    except Exception:
        return None


# --- concentric rank (scale-invariant rim discriminator) ---------------------


def _rank_in_center_group(e, part, tol):
    """(rank, group_size) for a circle edge `e` within its shared-center group in
    `part`. rank = number of concentric siblings with strictly smaller radius
    (0 = innermost); scale-invariant under a uniform mutation. Returns (None, None)
    for a non-circle / degenerate edge. Strictly-less-than counting is robust to `e`
    appearing (or not) in a fresh part.edges() list."""
    c, r = _edge_center(e), _edge_radius(e)
    if c is None or r is None:
        return None, None
    sibs = []
    for x in part.edges():
        if _edge_curve(x) == "circle":
            cc, rr = _edge_center(x), _edge_radius(x)
            if cc is not None and rr is not None and _dist(cc, c) < tol:
                sibs.append(rr)
    rank = sum(1 for rr in sibs if rr < r - 1e-9)
    return rank, len(sibs)


def _circle_center_groups(edges, tol):
    """Map id(e) -> (rank, group_size) for every circle edge in `edges`. Circles whose
    centers coincide within `tol` form one group; rank is the index in the group's
    ascending-radius order. Keyed by id(e), so the caller MUST score over this same
    edge-list instance."""
    circles = []
    for e in edges:
        if _edge_curve(e) == "circle":
            c, r = _edge_center(e), _edge_radius(e)
            if c is not None and r is not None:
                circles.append((e, c, r))
    out = {}
    for e, c, r in circles:
        sibs = [rr for (_x, cc, rr) in circles if _dist(cc, c) < tol]
        out[id(e)] = (sum(1 for rr in sibs if rr < r - 1e-9), len(sibs))
    return out


# --- fingerprint authoring (canonical; corpus + frontend should both use this) ---


def edge_fingerprint(e, part):
    """Author an edge selector fingerprint from a real edge. For a circle, additionally
    records radius_rank/radius_group so concentric rims survive a scale mutation that
    makes the absolute radius (and midpoint, a circumference point) stale."""
    m, d = _edge_mid(e), _edge_dir(e)
    fp = {"mid": [m.X, m.Y, m.Z], "dir": [d.X, d.Y, d.Z], "length": e.length, "curve": _edge_curve(e)}
    if _edge_curve(e) == "circle":
        r, c = _edge_radius(e), _edge_center(e)
        if r is not None:
            fp["radius"] = r
        if c is not None:
            fp["center"] = [c.X, c.Y, c.Z]
        rank, gsize = _rank_in_center_group(e, part, POS_DRIFT + REL_DRIFT * _bbox_diag(part))
        if gsize is not None:
            fp["radius_rank"], fp["radius_group"] = rank, gsize
    return fp


def face_fingerprint(f, part):
    """Author a face selector fingerprint. `part` is accepted for symmetry with
    edge_fingerprint and future concentric-face rank support (unused today)."""
    c, n = _face_centroid(f), _face_normal(f)
    fp = {"centroid": [c.X, c.Y, c.Z], "normal": [n.X, n.Y, n.Z], "area": f.area, "surface": _face_surface(f)}
    r = _face_radius(f)
    if r is not None:
        fp["radius"] = r
    return fp


# --- scoring -----------------------------------------------------------------


def _edge_cost(e, fp, tol_pos, rank_info=None):
    # Concentric rim (radius_group >= 2): under a uniform scale mutation the midpoint
    # (a CIRCUMFERENCE point, not the center), length, and absolute radius all go stale
    # and favor the wrong rim. Score only the scale-stable signals — center (locates the
    # family), curve type, and the radius RANK within the shared-center group. rank_info
    # is (rank, group_size) for THIS edge in the current part, or None.
    if _edge_curve(e) == "circle" and fp.get("radius_group", 1) >= 2 and "radius_rank" in fp:
        c = _edge_center(e)
        cost = W_POS * _dist(c, _v(fp["center"])) / tol_pos if (c is not None and "center" in fp) else 0.0
        if fp.get("curve") and _edge_curve(e) != fp["curve"]:
            cost += W_TYPE
        if rank_info is not None and rank_info[1] == fp["radius_group"]:
            cost += W_RANK * abs(rank_info[0] - fp["radius_rank"])
        else:
            # group size changed under mutation: fall back to the (stale) absolute radius
            r = _edge_radius(e)
            if "radius" in fp and r is not None:
                cost += W_RAD * _rel_err(r, fp["radius"]) / LEN_REL_TOL
        return cost

    cost = W_POS * _dist(_edge_mid(e), _v(fp["mid"])) / tol_pos
    if "dir" in fp:
        dot = abs(_edge_dir(e).dot(_unit(_v(fp["dir"]))))
        cost += W_DIR * (1.0 - dot) / ANG_TOL
    if "length" in fp:
        cost += W_LEN * _rel_err(e.length, fp["length"]) / LEN_REL_TOL
    if fp.get("curve") and _edge_curve(e) != fp["curve"]:
        cost += W_TYPE
    if _edge_curve(e) == "circle":
        r = _edge_radius(e)
        if "radius" in fp and r is not None:
            cost += W_RAD * _rel_err(r, fp["radius"]) / LEN_REL_TOL
        c = _edge_center(e)
        if "center" in fp and c is not None:
            cost += W_POS * _dist(c, _v(fp["center"])) / tol_pos  # kills concentrics
    return cost


def _face_cost(f, fp, tol_pos):
    cost = W_POS * _dist(_face_centroid(f), _v(fp["centroid"])) / tol_pos
    if "normal" in fp:
        dot = _face_normal(f).dot(_unit(_v(fp["normal"])))  # signed: an inward twin is rejected
        cost += W_DIR * (1.0 - dot) / ANG_TOL
    if "area" in fp:
        cost += W_AREA * _rel_err(f.area, fp["area"]) / AREA_REL_TOL
    if fp.get("surface") and _face_surface(f) != fp["surface"]:
        cost += W_TYPE
    if "radius" in fp:
        r = _face_radius(f)
        if r is not None:
            cost += W_RAD * _rel_err(r, fp["radius"]) / LEN_REL_TOL
    return cost


def _canonical_key_edge(e):
    p = _edge_mid(e)
    try:
        ln = e.length
    except Exception:
        ln = 0.0
    return (round(p.X, 3), round(p.Y, 3), round(p.Z, 3), round(ln, 3))


def _canonical_key_face(f):
    p = _face_centroid(f)
    try:
        ar = f.area
    except Exception:
        ar = 0.0
    return (round(p.X, 3), round(p.Y, 3), round(p.Z, 3), round(ar, 3))


def _resolve_one(cands, cost_fn, key_fn, nth):
    """Score `cands`, return (best_entity_or_None, confidence, lossy, reason).

    Best-effort: always returns the lowest-cost candidate (never raises on a poor
    match). A near-tie is broken by `nth` over a rebuild-stable canonical order.
    """
    if not cands:
        return None, 0.0, True, "no candidates on this body"
    scored = sorted(((cost_fn(x), x) for x in cands), key=lambda t: t[0])
    best_cost, best = scored[0]
    runner = scored[1][0] if len(scored) > 1 else math.inf
    margin = (runner - best_cost) / (runner + 1e-9) if math.isfinite(runner) else 1.0

    if margin < TIE_BAND:
        tied = [x for c, x in scored if (c - best_cost) / (runner + 1e-9) < TIE_BAND]
        tied.sort(key=key_fn)
        idx = nth if (isinstance(nth, int) and 0 <= nth < len(tied)) else 0
        reason = "tie broken by nth" if nth is not None else "tie; canonical-first"
        return tied[idx], margin, (nth is None), reason

    lossy = best_cost > ACCEPT_MAX
    return best, margin, lossy, ("marginal match" if lossy else None)


def _push_diag(diag, feature_id, kind, resolved, confidence, lossy, reason, at=None,
               candidates=None, code=None):
    if diag is None or not (lossy or confidence < 0.5):
        return
    entry = {
        "feature_id": feature_id,
        "kind": kind,
        "resolved": resolved,
        "confidence": round(float(confidence), 3),
        "lossy": bool(lossy),
        "reason": reason,
    }
    # `at` is the selector's OWN stored point, not the geometry we found. It is
    # what lets the UI identify WHICH selector of a multi-selector feature went
    # ambiguous, so it can offer to re-pick that one. Without it the frontend
    # knows a feature failed but not which of its five faces to ask about.
    if at is not None:
        pt = _finite3(at, want=3)
        # A malformed `at` is DROPPED rather than raised on. It comes straight
        # out of the document, and round(float(v)) on a hand-edited file whose
        # point holds a string raised right here, which the rebuild handler then
        # reported as the feature failing — document text in the sidecar's own
        # voice. Losing the Re-pick button on a reference that is already
        # unrepairable is the cheaper of the two.
        if pt is None:
            entry.pop("at", None)
        else:
            entry["at"] = pt
    if code:
        entry["code"] = code
    if candidates:
        entry["candidates"] = list(candidates)
    diag.append(entry)


# --- public API --------------------------------------------------------------


def _nearest_one(cands, dist_of, key_fn, describe, kind, sel, diag, feature_id):
    """Resolve a `by:"nearest"` selector — or REFUSE, when the pick is ambiguous.

    A bare `min()` over the candidates cannot fail. It returns the closest entity
    however far away and, the case that actually bit us, however close the
    RUNNER-UP is. On a real document (1.sindri, feature f73) two faces sat ~2mm
    from the stored point; which one won flipped when an unrelated commit
    perturbed topology, so a press/pull silently pushed a wall instead of the
    face the user clicked. Nothing errored, because nothing could.

    So: score exactly as before (nearest wins, byte-for-byte for a clear winner)
    but also measure the margin to the runner-up, the same way _resolve_one does
    for v2 `match`. Below TIE_BAND the pick is not determined by the data and we
    raise, naming both candidates, so the timeline red-chips and the user can
    re-pick. `nth` overrides — a selector that deliberately means "the second of
    the tied pair" can still say so.

    NOTE the discriminator is AMBIGUITY, not absolute distance. A gate on "how
    far is the point from the winner" would break ordinary parametric motion:
    raise a box's height and its top face moves far from the stored point, yet
    it is still the unique nearest by a wide margin and must keep resolving.
    """
    cands = list(cands)
    if not cands:
        raise ValueError(f"no {kind} to select from")
    # Collapse candidates that no pick could tell apart. Two entities sharing a
    # canonical key sit in the same place at the same size, so the refusal below
    # — "re-pick, the saved reference no longer identifies one" — asks for
    # something that cannot exist: any pick finding one finds the other.
    #
    # Not hypothetical. Two prisms that meet at a single corner fuse into a body
    # carrying that corner's edge TWICE (measured on the reported document: one
    # duplicated key, an edge against itself at 2.140mm vs 2.140mm), and every
    # blend on that body died on it. Deduping BEFORE the margin is measured is
    # what makes the runner-up the nearest genuinely different entity.
    unique = {}
    for c in cands:
        unique.setdefault(key_fn(c), c)
    cands = list(unique.values())
    scored = sorted(((dist_of(c), c) for c in cands), key=lambda t: t[0])
    best_d, best = scored[0]
    runner = scored[1][0] if len(scored) > 1 else math.inf
    margin = (runner - best_d) / (runner + 1e-9) if math.isfinite(runner) else 1.0

    if margin >= NEAREST_TIE_BAND:
        # Record NOTHING: this pick is unambiguous by the gate's own rule two lines
        # up, so there is nothing for a consumer to act on. It used to push an
        # informational entry carrying `margin` as `confidence`, which broke two
        # ways: `confidence` means a distance MARGIN here but a fingerprint
        # match-QUALITY on the by:"match" path, and `_push_diag` admits anything
        # under 0.5 — so a clear winner at margin 0.11 was logged as low
        # confidence. `_project_source` (builder.py) then refused the projection
        # outright, which is how a cylinder-rim projection started reporting
        # "the source selection is ambiguous on this body". Keep `diag` meaning
        # "resolutions worth acting on"; every consumer already assumes that.
        return best

    tied = [c for d, c in scored if (d - best_d) / (runner + 1e-9) < NEAREST_TIE_BAND]
    tied.sort(key=key_fn)
    nth = sel.get("nth")
    if isinstance(nth, int) and 0 <= nth < len(tied):
        _push_diag(diag, feature_id, kind, 1, margin, True, "tie broken by nth")
        return tied[nth]

    pt = sel.get("point") or []
    where = ", ".join(f"{float(v):.2f}" for v in pt)
    described = [describe(c) for c in tied[:3]]
    _push_diag(diag, feature_id, kind, 0, margin, True, "ambiguous nearest pick",
               at=pt, candidates=described)
    raise ValueError(
        f"ambiguous {kind} reference at ({where}): "
        + " and ".join(described)
        + f" are equally close ({best_d:.3f}mm vs {runner:.3f}mm) — re-pick the {kind}"
    )


def _describe_face(f):
    c = f.center()
    return f"a face at ({c.X:.2f},{c.Y:.2f},{c.Z:.2f}) area {f.area:.1f}"


def _describe_edge(e):
    c = e.center()
    try:
        n = f" length {e.length:.1f}"
    except Exception:
        n = ""
    return f"an edge at ({c.X:.2f},{c.Y:.2f},{c.Z:.2f}){n}"


def resolve_edges(part, sel, diag=None, feature_id=None):
    """Resolve an edge selector — or a LIST of selectors — to build123d edges.

    `diag`/`feature_id` are optional: when a list is given, low-confidence v2 matches
    append a ResolveDiag dict for the rebuild to surface.
    """
    if part is None:
        raise ValueError("no part to select edges from")

    # a list of selectors (multi-edge fillet/chamfer): union, de-duplicated.
    if isinstance(sel, list):
        seen = {}
        for s in sel:
            for e in resolve_edges(part, s, diag, feature_id):
                seen.setdefault(_edge_dedup_key(e), e)
        return list(seen.values())

    # A FACE selector in an edge field means "the edges around that face" — the
    # `ofFace` intent, arriving by point-pick rather than by fingerprint. It gets
    # here two ways: a fillet seeded from a selected face, and the re-pick repair,
    # which used to hand back a face selector whatever kind had gone ambiguous.
    # Falling through to the by:"nearest" branch below read the face's pick point
    # as an EDGE point and rounded whichever edge happened to be closest to it —
    # 2.14mm away on the reported document, an edge nobody had selected.
    if sel.get("kind") == "face":
        out = {}
        for f in resolve_faces(part, sel, diag, feature_id):
            for e in f.edges():
                out.setdefault(_edge_dedup_key(e), e)
        return list(out.values())

    by = sel.get("by")
    if by == "axis":
        return list(part.edges().filter_by(AXES[sel["axis"]]))
    if by == "all":
        return list(part.edges())
    if by == "nearest":
        p = _v(sel["point"])
        return [_nearest_one(part.edges(), lambda e: _dist(e.center(), p),
                             _canonical_key_edge, _describe_edge, "edge", sel, diag, feature_id)]
    if by == "match":
        fp = sel["fp"]
        edges = list(part.edges())
        # A circle reference resolves to a circle when any exist: a rim selector must not
        # collapse onto a straight body edge just because its absolute position drifted
        # (e.g. a mirror-twin hole that translated under an upstream edit). Removing only
        # non-circles is monotonic — it never reorders the circle candidates.
        if fp.get("curve") == "circle":
            circles = [e for e in edges if _edge_curve(e) == "circle"]
            if circles:
                edges = circles
        tol_pos = POS_DRIFT + REL_DRIFT * _bbox_diag(part)
        rank_of = _circle_center_groups(edges, tol_pos)
        best, conf, lossy, reason = _resolve_one(
            edges, lambda e: _edge_cost(e, fp, tol_pos, rank_of.get(id(e))), _canonical_key_edge, sel.get("nth")
        )
        _push_diag(diag, feature_id, "edge", 1 if best else 0, conf, lossy, reason)
        return [best] if best is not None else []
    if by == "ofFace":
        faces = _faces_matching(part, sel["face"], diag, feature_id)
        out = {}
        for f in faces:
            for e in f.edges():
                out.setdefault(_edge_dedup_key(e), e)
        return list(out.values())
    if by == "tangentChain":
        fp = sel["seed"]
        edges = list(part.edges())
        tol_pos = POS_DRIFT + REL_DRIFT * _bbox_diag(part)
        rank_of = _circle_center_groups(edges, tol_pos)
        seed, conf, lossy, reason = _resolve_one(
            edges, lambda e: _edge_cost(e, fp, tol_pos, rank_of.get(id(e))), _canonical_key_edge, None
        )
        if seed is None:
            _push_diag(diag, feature_id, "edge", 0, 0.0, True, "tangentChain seed not found")
            return []
        chain = _tangent_chain(part, seed)
        _push_diag(diag, feature_id, "edge", len(chain), conf, lossy, reason)
        return chain
    raise ValueError(f"unknown edge selector: {by}")


def resolve_faces(part, sel, diag=None, feature_id=None):
    """Resolve a face selector — or a LIST of selectors — to build123d faces."""
    if part is None:
        raise ValueError("no part to select faces from")

    # a list of selectors (multi-face offset/thicken/shell/draft): union,
    # de-duplicated — mirrors resolve_edges. Without this branch a list reaches
    # sel.get("by") and dies with a bare AttributeError, which the rebuild loop
    # renders as an unhelpful "Shell failed (AttributeError)".
    if isinstance(sel, list):
        seen = {}
        for s in sel:
            for f in resolve_faces(part, s, diag, feature_id):
                seen.setdefault(_face_dedup_key(f), f)
        return list(seen.values())

    by = sel.get("by")
    if by == "normal":
        d = _unit(_v(sel["dir"]))
        return list(part.faces().filter_by(lambda f: _face_normal(f).dot(d) > 0.99))
    if by == "nearest":
        p = _v(sel["point"])
        faces = list(part.faces())
        # distance_to is the true point-to-surface distance; it can throw on a
        # degenerate/faceted face, in which case fall back to centre distance for
        # ALL of them so the comparison stays like-for-like (a mixed metric would
        # make the runner-up margin meaningless).
        try:
            for f in faces:
                f.distance_to(p)
            dist_of = lambda f: f.distance_to(p)
        except Exception:
            dist_of = lambda f: _dist(f.center(), p)
        return [_nearest_one(faces, dist_of, _canonical_key_face, _describe_face,
                             "face", sel, diag, feature_id)]
    if by == "all":
        return list(part.faces())
    if by == "match":
        return _faces_matching(part, sel["fp"], diag, feature_id, nth=sel.get("nth"))
    raise ValueError(f"unknown face selector: {by}")


def _faces_matching(part, fp, diag, feature_id, nth=None):
    tol_pos = POS_DRIFT + REL_DRIFT * _bbox_diag(part)
    best, conf, lossy, reason = _resolve_one(
        list(part.faces()), lambda f: _face_cost(f, fp, tol_pos), _canonical_key_face, nth
    )
    _push_diag(diag, feature_id, "face", 1 if best else 0, conf, lossy, reason)
    return [best] if best is not None else []



# --- face-anchored planes (sketch / datumPlane) ------------------------------
#
# The codes a face-anchored plane can report. Flat lowerCamel, matching the
# shipped ResolveDiag.kind value "edgeOpFailed", and read by
# features/repickReference.ts to decide whether a pick can repair the reference.
# Constants at both ends so rewording the prose beside them cannot silently
# unhook the button.
CODE_AMBIGUOUS_REFERENCE = "ambiguousReference"  # the selector matched several faces
CODE_REFERENCE_NOT_FOUND = "referenceNotFound"   # the selector matched nothing
CODE_PLANE_TILTED = "planeTilted"                # the face is no longer parallel

# How far a face's normal may drift from the cached plane's and still be "the
# same face": 1 - |dot| <= 1e-3, about 2.6 degrees. A PLANAR face tessellates
# exactly, so the client's raycast normal is the B-rep normal to float
# precision; anything past this is a tilt, not drift. SAME-SIGN, with abs only
# as a last resort: the body's antiparallel face is co-normal too, and admitting
# it alongside the real one lets the far side win on distance alone.
PLANE_ANG_TOL = 1e-3
# mm of slack on a face's plane offset (n . centre) when deciding two co-normal
# faces are the SAME plane, the coplanar-tie gate below.
PLANE_COPLANAR_TOL = 1e-3


def plane_fallback_reason(code, label, detail=None):
    """The user-facing sentence for a face-anchored plane that fell back.

    Two of the three share one tail, "stayed at its saved position, re-pick the
    face", because the user's next action is the same for both. Kept in one
    function so the wording cannot drift between the places that push it.

    The tilted case does NOT say re-pick, and must not: the candidate filter
    below is taken against the CACHED plane's normal and a re-pick writes only
    the selector, so picking the tilted face again reproduces this exact
    diagnostic. Its repair is a different gesture, so it gets different words,
    and features/repickReference.ts leaves the button off for it.

    `label` is "Sketch" or "Plane"; it is ours, never document text."""
    noun = label.lower()
    stayed = f"{noun} stayed at its saved position. Re-pick the face."
    if code == CODE_PLANE_TILTED:
        return (f"{label}: the face this {noun} sits on has tilted, so the {noun} "
                f"stayed at its saved position. Put it on the face again to "
                f"follow the new angle.")
    if code == CODE_AMBIGUOUS_REFERENCE:
        return (f"{label}: this {noun}'s face reference no longer identifies one "
                f"face, {detail}. The {stayed}")
    return f"{label}: the face this {noun} sits on is gone, so the {stayed}"


def push_plane_fallback(diag, feature_id, code, label, sel, detail=None):
    """Record a face-anchored plane falling back to its cached placement.

    `lossy` STAYS FALSE. It means "a best-effort match was taken", and this is
    the opposite: no match was taken at all. builder._project_source refuses a
    projection source when any diagnostic in its list is lossy, so a true here
    would turn an unrelated stale sketch anchor into a failed Project pick.
    confidence 0.0 is what gets it past _push_diag's head gate.

    `at` is the selector's own stored point, not the geometry, which is how the
    Re-pick repair finds WHICH selector to replace."""
    _push_diag(diag, feature_id, "face", 0, 0.0, False,
               plane_fallback_reason(code, label, detail),
               at=(sel.get("point") if isinstance(sel, dict) else None), code=code)


def resolve_face_on_plane(part, sel, normal, label, diag=None, feature_id=None):
    """The body face a sketch / datum plane is anchored to, or None, having
    recorded WHY in `diag`.

    THE CO-NORMAL FILTER IS THE WHOLE FIX. Plain by:"nearest" over every face
    binds whatever is closest to the stored raycast point, and after exactly the
    edit this exists to survive, a box's height 10 to 20, the anchored top face
    has moved away while the SIDE WALL still sits right next to the stored
    point. Keeping only faces parallel to the cached plane's normal removes
    every one of those; what is left can only be the face itself, its coplanar
    halves, or a parallel sibling, and the filter and the metric below are what
    stop each of those three from being the silent wrong answer.

    NEVER RAISES. The caller is a ROOT feature (a sketch), so a refusal has to
    come back as "keep the cached plane". `label` only shapes the prose."""
    planar = [f for f in (part.faces() if part is not None else [])
              if _face_surface(f) == "plane"]
    if not planar:
        # Nothing flat left to sit on: the anchor is GONE (shelled away, replaced
        # by an import, booleaned out) rather than merely turned. The two get
        # different words because they need different fixes.
        push_plane_fallback(diag, feature_id, CODE_REFERENCE_NOT_FOUND, label, sel)
        return None

    pt = _finite3(sel.get("point"), want=3) if isinstance(sel, dict) else None
    if pt is None:
        # A point that is not three finite numbers cannot be believed, and must
        # not be GUESSED at either: Vector(*args) collapses anything non-numeric
        # to (0,0,0) without complaint, so the anchor would quietly bind
        # whichever co-normal face is nearest the world origin, a clear winner
        # and so not even an ambiguity.
        push_plane_fallback(diag, feature_id, CODE_REFERENCE_NOT_FOUND, label, sel)
        return None

    d = _unit(_v(normal))
    # SAME-SIGN FIRST. `abs` alone keeps the body's FAR SIDE as a candidate, and
    # the metric below then hands it the anchor the moment it is closer to the
    # stored point than the anchored face is. The caller flips the resolved
    # normal back to the cached side afterwards, so the wrong face would come
    # back as a plausible plane with nothing recorded. The abs pass stays as a
    # fallback for the case it was written for: a face whose ORIENTATION flipped
    # under a boolean, where no same-sign face is left.
    cands = [f for f in planar if _face_normal(f).dot(d) >= 1.0 - PLANE_ANG_TOL]
    if not cands:
        cands = [f for f in planar if abs(_face_normal(f).dot(d)) >= 1.0 - PLANE_ANG_TOL]
    if not cands:
        push_plane_fallback(diag, feature_id, CODE_PLANE_TILTED, label, sel)
        return None

    p = _v(pt)

    # The metric is the IN-PLANE distance. The survivors of the filter above are
    # the face itself, its coplanar halves, and PARALLEL SIBLINGS (a step, a
    # plate under a boss). Ranked in 3-D a sibling takes the anchor as soon as
    # the anchored face travels further from the frozen pick point than the
    # sibling sits from it. The point stays OVER the face it was picked on
    # however far that face slides ALONG its normal, which is the only motion
    # this exists to follow, so project it onto each candidate's plane first.
    def _flat(f):
        n = _face_normal(f)
        return p - n * (n.dot(p) - n.dot(_face_centroid(f)))

    # How far a candidate sits from the SAVED plane along the normal. The stored
    # point was ON the anchored face when it was picked, so d.p IS the cached
    # plane's offset: zero here means the face never moved.
    def _travel(f):
        return abs(d.dot(_face_centroid(f)) - d.dot(p))

    # The same like-for-like fallback resolve_faces' nearest branch uses: a mixed
    # metric would make the runner-up margin below meaningless.
    try:
        for f in cands:
            f.distance_to(_flat(f))

        def dist_of(f):
            return f.distance_to(_flat(f))
    except Exception:
        def dist_of(f):
            return _dist(_face_centroid(f), _flat(f))

    # The ambiguity rule is _nearest_one's, deliberately: same NEAREST_TIE_BAND,
    # same margin-to-the-runner-up definition. Spelled out here rather than
    # delegated because the gate below has to see the TIED SET, and because a
    # refusal must return None instead of raising.
    scored = sorted(((dist_of(f), i) for i, f in enumerate(cands)), key=lambda t: t[0])
    best_d, best_i = scored[0]

    # THE UNMOVED-FACE OVERRIDE. Two stories explain a winner that contains the
    # point but sits off the saved plane: the anchored face MOVED there, or a cut
    # removed the material under the point and this is the floor of that cut.
    # Prefer the story with the smaller displacement: an unmoved face whose
    # in-plane gap is SHORTER than the winner's normal travel is the better
    # explanation. Only an unmoved face can override, never a sibling that both
    # moved and does not contain the point, and only within the winner's travel,
    # so a face that merely happens to sit at the saved height elsewhere on the
    # part cannot steal the anchor.
    travel = _travel(cands[best_i])
    if best_d <= PLANE_COPLANAR_TOL and travel > PLANE_COPLANAR_TOL:
        stayed = [(dd, i) for dd, i in scored
                  if _travel(cands[i]) <= PLANE_COPLANAR_TOL and dd < travel]
        if stayed:
            scored = stayed
            best_d, best_i = scored[0]
    runner = scored[1][0] if len(scored) > 1 else math.inf
    margin = (runner - best_d) / (runner + 1e-9) if math.isfinite(runner) else 1.0
    if margin >= NEAREST_TIE_BAND:
        return cands[best_i]

    tied = [cands[i] for dd, i in scored if (dd - best_d) / (runner + 1e-9) < NEAREST_TIE_BAND]
    # COPLANAR-TIE GATE. A tie between faces that are the SAME PLANE has nothing
    # to be wrong about: a through-slot splits the anchored face in two and the
    # stored point lands over the removed slot, so both halves are EXACTLY
    # equidistant. The plain rule refuses that, and the sketch would go amber on
    # an edit that did nothing to it. Both halves give an identical plane, so
    # accept iff every tied face collapses onto one. A tie across DISTINCT planes
    # (the top and bottom of a thin plate) is a real ambiguity and still refuses.
    # Do NOT harden this into a cost-margin gate: the split-face tie is exact by
    # construction, so any margin rule rejects it again. Co-normality is already
    # guaranteed by the filter above, so comparing the offset along `d` is a
    # complete same-plane test.
    off = d.dot(_face_centroid(cands[best_i]))
    if all(abs(d.dot(_face_centroid(f)) - off) <= PLANE_COPLANAR_TOL for f in tied):
        return cands[best_i]

    tied.sort(key=_canonical_key_face)  # stable prose across rebuilds
    push_plane_fallback(diag, feature_id, CODE_AMBIGUOUS_REFERENCE, label, sel,
                        detail=" and ".join(_describe_face(f) for f in tied[:3]))
    return None

def _edge_dedup_key(e):
    """De-dup key for a union of edge selectors. Keys on the rounded midpoint AND
    length, so concentric edges (same center, different circumference) are NOT
    collapsed — fixing the old center-only key that silently dropped them."""
    p = _edge_mid(e)
    try:
        ln = round(e.length, 4)
    except Exception:
        ln = 0.0
    return (round(p.X, 4), round(p.Y, 4), round(p.Z, 4), ln)


def _face_dedup_key(f):
    """De-dup key for a union of face selectors. Centroid AND area, so two
    coplanar concentric faces (same centroid, different size) stay distinct —
    the face-side twin of _edge_dedup_key."""
    p = _face_centroid(f)
    try:
        ar = round(f.area, 4)
    except Exception:
        ar = 0.0
    return (round(p.X, 4), round(p.Y, 4), round(p.Z, 4), ar)


def _tangent_chain(part, seed):
    """Grow a tangent-continuous chain from `seed`: edges connected through a shared
    vertex whose tangents are collinear within ANG_TOL. Best-effort BFS over the
    body's edges (OCCT has no one-call tangent walker).

    Visited edges are tracked by GEOMETRIC key, not id(): `seed` was resolved from a
    separate `part.edges()` call, so its twin in this local list has a different
    Python id — keying on id() would re-add it as its own neighbour."""
    edges = list(part.edges())

    def endpoints(e):
        try:
            vs = e.vertices()
            return _v(vs[0].to_tuple()), _v(vs[-1].to_tuple())
        except Exception:
            return None, None

    def tangent_at_point(e, p):
        # tangent at whichever end coincides with p (fallback: midpoint tangent)
        try:
            a, b = endpoints(e)
            if a is not None and _dist(a, p) < _dist(b, p):
                return _sign_normalize(_unit(e.tangent_at(0.0)))
            return _sign_normalize(_unit(e.tangent_at(1.0)))
        except Exception:
            return _edge_dir(e)

    seen = {_edge_dedup_key(seed)}
    chain = [seed]
    frontier = [seed]
    while frontier:
        cur = frontier.pop()
        a, b = endpoints(cur)
        if a is None:
            continue
        for e in edges:
            k = _edge_dedup_key(e)
            if k in seen:
                continue
            ea, eb = endpoints(e)
            if ea is None:
                continue
            for shared in (a, b):
                if _dist(ea, shared) < 1e-6 or _dist(eb, shared) < 1e-6:
                    if abs(tangent_at_point(cur, shared).dot(tangent_at_point(e, shared))) > 1.0 - ANG_TOL:
                        seen.add(k)
                        chain.append(e)
                        frontier.append(e)
                    break
    return chain
