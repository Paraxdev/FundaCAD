"""Whole-body edge finishing: elephant-foot chamfer and vertical edge fillet.

Both find their own edges from the body and the build direction rather than
from a pick, then blend them with a batch kernel call first and a one-edge-at-
a-time fallback second (blends._sequential_blend), so one edge the kernel
refuses does not cost the whole feature: it is skipped and counted instead.
"""

import math

import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py
from build123d import Face as B3Face

import ptb_occ as g
from blends import SMOOTH_EDGE_DEG, _edge_dihedral_deg, _sequential_blend, native_fillet, native_two_distance_chamfer
from geom_select import _edge_curve, _edge_dir, _edge_mid
from ptb_read import bodies_from_ids, plane_of
from section_blend import _faces_of

_VERTICAL_TOL_DEG = 1.0


def _bottom_faces(shape, bdir, label):
    hits = []
    for fc in shape.faces():
        pl = plane_of(fc)
        if pl is None:
            continue
        n, p = pl
        if g.dot(n, bdir) < -0.999:
            hits.append((g.dot(p, bdir), fc))
    if not hits:
        raise ValueError(f"{label}: no face of this body faces opposite the build direction")
    zmin = min(z for z, _ in hits)
    return [fc for z, fc in hits if z <= zmin + 1e-4]


def _edge_key(e):
    p = _edge_mid(e)
    return (round(p.X, 4), round(p.Y, 4), round(p.Z, 4))


def _bottom_edges(shape, bdir, label):
    seen = {}
    for fc in _bottom_faces(shape, bdir, label):
        for e in fc.outer_wire().edges():
            seen.setdefault(_edge_key(e), e)
    if not seen:
        raise ValueError(f"{label}: the lowest face has no edges to chamfer")
    return list(seen.values())


def _into_face(mid, n, t, center):
    """Unit vector tangent to a face, perpendicular to the shared edge, pointing
    from the edge INTO that face's own extent (resolved via its centroid, so the
    two faces need not be ordered consistently)."""
    w = g.cross((t.X, t.Y, t.Z), (n.X, n.Y, n.Z))
    if g.norm(w) < 1e-9:
        return None
    to_center = g.sub((center.X, center.Y, center.Z), (mid.X, mid.Y, mid.Z))
    if g.dot(w, to_center) < 0:
        w = g.mul(w, -1.0)
    return g.unit(w)


def _is_convex(shape, edge, probe):
    """True when the material's dihedral angle at this edge is under 180
    degrees (an outer corner), false for a reflex/concave edge (an inner notch).

    Neither face normal alone says which: both a 90 degree box corner and a 270
    degree notch have their outward normals pointing away from material, so a
    single probe along their average lands in air either way. What tells them
    apart is where the STRAIGHT CHORD between the two faces sits: cutting a
    convex corner with a chord stays inside the material (the corner sticks out
    past it), cutting a reflex one stays in the void (the material wraps around
    it instead).
    """
    f1, f2 = _faces_of(shape.wrapped, edge.wrapped)
    mid = _edge_mid(edge)
    t = edge.tangent_at(0.5)
    face1, face2 = B3Face(f1), B3Face(f2)
    w1 = _into_face(mid, face1.normal_at(mid), t, face1.center())
    w2 = _into_face(mid, face2.normal_at(mid), t, face2.center())
    if w1 is None or w2 is None:
        return True
    a = g.lin((mid.X, mid.Y, mid.Z), (probe, w1))
    b = g.lin((mid.X, mid.Y, mid.Z), (probe, w2))
    chord_mid = g.mul(g.add(a, b), 0.5)
    return g.inside(shape.wrapped, chord_mid)


def _vertical_edges(shape, bdir, only_convex, radius, label):
    cos_tol = math.cos(math.radians(_VERTICAL_TOL_DEG))
    probe = max(0.01, 0.1 * radius)
    out = []
    for e in shape.edges():
        if _edge_curve(e) != "line":
            continue
        d = _edge_dir(e)
        if abs(g.dot((d.X, d.Y, d.Z), bdir)) < cos_tol:
            continue
        dh = _edge_dihedral_deg(shape, e)
        if dh is None or dh < SMOOTH_EDGE_DEG:
            continue
        if only_convex and not _is_convex(shape, e, probe):
            continue
        out.append(e)
    if not out:
        raise ValueError(f"{label}: no edges run parallel to the build direction on this body")
    return out


def _blend_with_fallback(f, ctx, label, body, shape, edges, batch_fn, one_fn, size, verb):
    try:
        body["shape"] = batch_fn(shape, edges)
        return
    except Exception:
        pass
    new_shape, unresolved = _sequential_blend(shape, edges, one_fn, size, shape)
    resolved = len(edges) - len(unresolved)
    if resolved == 0:
        raise ValueError(f"{label}: the kernel could not {verb} any of the {len(edges)} edge(s), try a smaller size")
    body["shape"] = new_shape
    if unresolved and ctx.diagnostics is not None:
        ctx.diagnostics.append({
            "feature_id": f.get("id"),
            "kind": "edgeOpFailed",
            "reason": f"{len(unresolved)} of {len(edges)} edges could not be {verb}ed and were skipped",
            "resolved": resolved,
            "confidence": 0.5,
            "lossy": True,
        })


def handle_elephant_foot_chamfer(f, ctx):
    label = "Elephant-foot chamfer"
    size = float(ctx.val(f.get("size", 0.4)))
    if not 0.01 <= size <= 20.0:
        raise ValueError(f"{label}: the chamfer size must be between 0.01 and 20 mm (got {size:g})")
    bdir = g.build_dir(f, label)
    for body in bodies_from_ids(f, ctx, label):
        shape = body["shape"]
        edges = _bottom_edges(shape, bdir, label)
        _blend_with_fallback(
            f, ctx, label, body, shape, edges,
            batch_fn=lambda s, es: native_two_distance_chamfer(s, es, size, size),
            one_fn=lambda s, e: native_two_distance_chamfer(s, [e], size, size),
            size=size, verb="chamfer",
        )


def handle_vertical_fillet(f, ctx):
    label = "Vertical edge fillet"
    radius = float(ctx.val(f.get("radius", 2)))
    if not 0.01 <= radius <= 100.0:
        raise ValueError(f"{label}: the radius must be between 0.01 and 100 mm (got {radius:g})")
    bdir = g.build_dir(f, label)
    only_convex = bool(f.get("onlyConvex", False))
    for body in bodies_from_ids(f, ctx, label):
        shape = body["shape"]
        edges = _vertical_edges(shape, bdir, only_convex, radius, label)
        _blend_with_fallback(
            f, ctx, label, body, shape, edges,
            batch_fn=lambda s, es: native_fillet(s, es, [radius] * len(es)),
            one_fn=lambda s, e: native_fillet(s, [e], [radius]),
            size=radius, verb="fillet",
        )
