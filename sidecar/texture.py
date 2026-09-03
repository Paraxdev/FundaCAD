"""Printed surface texture: knurl/hex/waves/ribs/voronoi/noise/image height fields,
displaced into a face's triangulation at tessellation/export time.

Two-phase design (mirrors selector-v2's own resolve-lazily pattern): builder.py's
_handle_texture validates the spec against the CURRENT shape (for red-timeline
feedback) and appends the raw spec to body["_textures"] — it never touches
body["shape"]. The actual face selectors are resolved lazily, ONCE, against the
FINAL shape by resolve_body_textures() below, called from tessellate.py right
before meshing. This sidesteps every downstream-feature topology change the same
way every other selector-based feature already does (best-effort nearest-match +
diagnostic on drift, never a hard failure).

Displacement never edits the BRep (no variable-offset API in OCCT for this); it
subdivides + displaces the MESH at tessellation time. See displace_face().
"""

import math

import numpy as np

# Split out when this file passed 1,900 lines. Re-exported because builder.py,
# tessellate.py and the texture tests reach for several of these by name.
from texture_height import (  # noqa: F401
    _HEX_CORNERS,
    _facet_wave,
    _hash01,
    _height_hex,
    _height_image,
    _height_knurl,
    _height_noise,
    _height_ribs,
    _height_voronoi,
    _height_waves,
    _hex_nearest_site,
    _hex_wall_width,
    _is_facet,
    _perlin2,
    _rotate,
    _sharpen,
    _steps_from,
    _terrace,
    _trapezoid,
    _tri_wave,
    _u_period,
    _wave_levels,
    _wave_phases,
    height_field,
)
from texture_mesh import (  # noqa: F401
    LATTICE_SURFACES,
    _aligned_grid_triangulation,
    _axis_lines,
    _boundary_edges,
    _boundary_taper,
    _cell_lattice_points,
    _crease_phases,
    _face_frame,
    _face_uv_to_mm,
    _flip_to_creases,
    _force_cell_diagonals,
    _manifold_check,
    _pattern_axes,
    _points_in_polygon,
    _refine_face_triangulation,
    _revolved_reference_radius,
    _segment_crossings,
    _surface_kind,
    _turn_mm,
    _uncharter,
)

TEXTURE_KINDS = {"knurl", "hex", "waves", "ribs", "voronoi", "noise", "image"}
_DIRECTIONS = {"out", "in", "both"}
# "facet" = hard-surface (planar facets, real creases — the default, because it
# is what a printer can actually resolve); "round" = the original smooth fields.
_PROFILES = {"facet", "round"}

# Export-tier safety net even when the caller passes density_cap=None — a
# pathologically fine scale/depth combo must not be able to allocate unbounded
# memory. server.py's EXPORT_DENSITY_CAP_PER_FACE is normally what applies.
_DEFAULT_DENSITY_CAP = 2_000_000

# Bump on ANY change to the displacement algorithm or output: it participates in the
# persistent mesh-cache key, so a code update invalidates cached textured meshes
# instead of serving stale geometry from the previous version.
# 5: crease-aligned lattices — vertices land ON the pattern's gradient breakpoints
#    instead of a uniform grid, so faceted kinds are exact.
# 6: seam-aware ring on closed faces — UV-seam columns densified with the lattice's
#    own on-seam points, and the lattice no longer culled against them, so hex cells
#    straddling the seam keep their crease corners (was: ~half crushed by up to 46%
#    of depth, staggered by row).
# 7: consistent triangle winding — lattice Delaunay orientation is arbitrary (half a
#    tube face wound inward), and a double-sided renderer negates the shading normal
#    on back-wound triangles, lighting half the model inside-out; it also rode into
#    STL/3MF exports. Now oriented to agree with the analytic normals.
# 8: waves got its own faceted profile (a sine polyline). Under `facet` it had
#    returned the same _trapezoid as ribs, so the two were byte-identical on the
#    default profile; `sharpness` now picks its facet count. Existing documents
#    change shape.
CODE_VERSION = 8


def validate_texture_spec(f):
    """Validate a raw texture feature dict and return the CLEANED spec stored on
    body["_textures"]. Raises ValueError with a user-facing message — the same
    convention every other handler uses (see _handle_shell/_handle_draft)."""
    kind = f.get("kind")
    if kind not in TEXTURE_KINDS:
        raise ValueError(f"unknown texture kind: {kind!r}")
    depth = f.get("depth", 0.4)
    if not isinstance(depth, (int, float)) or depth <= 0:
        raise ValueError("texture depth must be a positive number")
    scale = f.get("scale", 2.0)
    if not isinstance(scale, (int, float)) or scale <= 0:
        raise ValueError("texture scale must be a positive number")
    direction = f.get("direction", "out")
    if direction not in _DIRECTIONS:
        raise ValueError(f"unknown texture direction: {direction!r}")
    profile = f.get("profile", "facet")
    if profile not in _PROFILES:
        raise ValueError(f"unknown texture profile: {profile!r} (expected facet or round)")
    inset = f.get("boundaryInset", 0.0)
    if not isinstance(inset, (int, float)) or inset < 0:
        raise ValueError("texture edge blend must be zero or a positive number")
    image_path = f.get("imagePath")
    if kind == "image":
        if not image_path:
            raise ValueError("image texture needs an image path")
        try:
            from PIL import Image

            with Image.open(image_path) as im:
                im.verify()
        except Exception as ex:
            raise ValueError(f"can't read texture image {image_path!r}: {ex}") from ex
    spec = {
        "feature_id": f.get("id"),
        "kind": kind,
        "faces": f.get("faces") or {"by": "all"},
        "body": f.get("body"),
        "depth": float(depth),
        "scale": float(scale),
        "angle": float(f.get("angle", 0.0)),
        "offset": float(f.get("offset", 0.0)),
        "sharpness": float(f.get("sharpness", 0.5)),
        "profile": profile,
        "direction": direction,
        "seed": int(f.get("seed") or 0),
        "octaves": max(1, min(int(f.get("octaves") or 3), 6)),
        "invert": bool(f.get("invert", False)),
        "boundaryInset": max(float(inset), 0.0),
    }
    if kind == "image":
        spec["imagePath"] = image_path
    # Two-tone inlay: which palette slot the textured faces print in. Kept out
    # of the spec when unset so old docs hash identically (texture_key). Never
    # affects displaced geometry — do NOT bump CODE_VERSION for it.
    color_slot = f.get("colorSlot")
    if isinstance(color_slot, (int, float)) and not isinstance(color_slot, bool) and int(color_slot) >= 0:
        spec["colorSlot"] = int(color_slot)
    return spec


def _resolve_texture_faces(shape, sel, diag=None, feature_id=None):
    """resolve_faces() (geom_select.py) only takes ONE selector dict; a texture's
    `faces` may be a list (like press-pull's multi-face `face`). Union + dedup by
    _face_fp, same pattern _handle_press_pull uses for its own sels loop."""
    from builder import _face_fp
    from geom_select import resolve_faces

    sels = sel if isinstance(sel, list) else [sel]
    seen = {}
    for s in sels:
        for face in resolve_faces(shape, s, diag=diag, feature_id=feature_id):
            seen.setdefault(_face_fp(face), face)
    return list(seen.values())


def resolve_body_textures(body, diag=None):
    """Lazily resolve every texture spec on `body` against its FINAL shape. Returns
    [(spec, [Face, ...]), ...] — specs whose selector now matches zero faces (the
    targeted face was fully consumed downstream) are dropped, same best-effort
    behavior as every other selector-based feature."""
    specs = body.get("_textures") or []
    if not specs:
        return []
    shape = body.get("shape")
    if shape is None:
        return []
    out = []
    for spec in specs:
        faces = _resolve_texture_faces(
            shape, spec.get("faces") or {"by": "all"}, diag, spec.get("feature_id")
        )
        if faces:
            out.append((spec, faces))
    return out



_GEOM_CACHE = {}
_GEOM_CACHE_MAX = 8


def _geometry_key(face, tri, flip, spec, scale, angle, inset_mm, cap):
    """Cache key for the height-INDEPENDENT skeleton.

    It must carry every spec field the SAMPLING geometry depends on. Before
    crease-aligned lattices the skeleton was genuinely kind-independent (a
    uniform grid at scale/angle), so kind/sharpness/profile/offset were
    correctly absent. A lattice derives its vertex placement from the pattern
    itself, so all four now move vertices — leaving them out serves a knurl
    skeleton for a hex texture at the same scale and angle."""
    node1 = tri.Node(1)
    return (
        face.wrapped.TShape(), tri.NbNodes(), tri.NbTriangles(),
        round(node1.X(), 9), round(node1.Y(), 9), round(node1.Z(), 9),
        flip, round(scale, 6), round(angle, 6), round(inset_mm, 6), cap,
        spec["kind"], round(float(spec.get("sharpness", 0.5)), 6),
        spec.get("profile", "facet"), round(float(spec.get("offset", 0.0)), 6),
    )


def _displacement_geometry(face, tri, loc, ident, spec, scale, target_edge_mm, cap, flip):
    """The height-independent skeleton for one textured face: refined sampling
    mesh, mm chart, boundary taper, surface frame, manifold verdict."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    
    trsf = loc.Transformation()
    node = tri.Node
    uvnode = tri.UVNode
    n_nodes = tri.NbNodes()
    base_pts = []
    base_uv = []
    for i in range(1, n_nodes + 1):
        p = node(i)
        if not ident:
            p = p.Transformed(trsf)
        base_pts.append((p.X(), p.Y(), p.Z()))
        uvp = uvnode(i)
        base_uv.append((uvp.X(), uvp.Y()))

    get_tri = tri.Triangle
    ntri = tri.NbTriangles()
    base_tris = []
    for i in range(1, ntri + 1):
        a, b, c = get_tri(i).Get()
        a, b, c = a - 1, b - 1, c - 1
        if flip:
            b, c = c, b
        base_tris.append((a, b, c))

    surf = BRepAdaptor_Surface(face.wrapped)

    # Three tiers, most exact first:
    #   1. CREASE-ALIGNED LATTICE — sample lines on the pattern's own gradient
    #      breakpoints, so the mesh reproduces the faceted profile exactly.
    #   2. uniform pattern-aligned grid — the sampled approximation. An
    #      axis-aligned grid beats against a diagonal pattern (roped/beaded
    #      ridges); alignment gives straight crests at the same triangle budget.
    #   3. general subdivision — anything the mm chart cannot place a line on.
    # Tier 2 is a real fallback, not a failure: a fine pattern on a large face
    # has a line count fixed by the pattern rather than the budget, and dropping
    # straight to tier 3 there would be far worse than a coarser grid.
    #
    # Tiers 1-2 now cover CYLINDERS and CONES as well as planes, which is where
    # the win is largest — a knurled knob is a cylinder, and the subdivision path
    # spent 834 triangles per pattern cell on one (against ~10 for a plane)
    # because it refines uniformly from a coarse base mesh with no idea where the
    # pattern is.
    pts = None
    lattice_used = False
    if _surface_kind(surf) is not None:
        base_uv_arr = np.asarray(base_uv, dtype=np.float64)
        u_period = _u_period(spec, scale)
        bu_mm, bv_mm = _face_uv_to_mm(surf, base_uv_arr[:, 0], base_uv_arr[:, 1], u_period)
        phases = _pattern_axes(spec["kind"], spec)
        tex_offset = float(spec.get("offset", 0.0))
        # a closed cylinder/cone is periodic in u: the seam is an artificial
        # cut. Every kind's assembly needs to know where it is — cellular kinds
        # to keep the lattice periodic, and ALL kinds so the crease-repair pass
        # may fix seam-strip triangles (their ring vertices displace with the
        # field, unlike a real rim's).
        wrap_u = None
        if _surface_kind(surf) in ("cylinder", "cone"):
            span = float(surf.LastUParameter() - surf.FirstUParameter())
            if abs(span - 2.0 * math.pi) < 1e-6:
                wrap_u = _turn_mm(surf, u_period)
        cell_points = None
        if phases == "cells":
            # cellular kinds place their own vertices, in mm coordinates; the
            # offset shifts u exactly as it does for the field
            phases = None
            pad = max(scale, target_edge_mm)
            cell_points = _cell_lattice_points(
                spec["kind"], spec, scale,
                float(bu_mm.min()) + tex_offset - pad, float(bu_mm.max()) + tex_offset + pad,
                float(bv_mm.min()) - pad, float(bv_mm.max()) + pad, wrap_u=wrap_u)
            if cell_points is not None:
                cell_points = cell_points - np.array([tex_offset, 0.0])

        def _field(pts_mm):
            # the same field displace_face will evaluate, offset included, so a
            # diagonal chosen here is the one the displaced mesh actually needs
            return height_field(spec["kind"], spec,
                                pts_mm[:, 0] + tex_offset, pts_mm[:, 1])

        attempts = ((phases, cell_points, True), (None, None, False)) \
            if (phases or cell_points is not None) else ((None, None, False),)
        for want_phases, want_cells, is_lattice in attempts:
            try:
                pts, uv, tris = _aligned_grid_triangulation(
                    base_pts, base_uv, base_tris, bu_mm, bv_mm,
                    float(spec.get("angle", 0.0)), target_edge_mm, cap,
                    pattern_period=scale, phases=want_phases,
                    offset=tex_offset, field=_field if is_lattice else None,
                    unchart=_uncharter(surf, u_period), cell_points=want_cells,
                    wrap_u=wrap_u,
                )
                lattice_used = is_lattice
                break
            except Exception:
                pts = None
    if pts is None:
        lattice_used = False
        pts, uv, tris = _refine_face_triangulation(surf, base_pts, base_uv, base_tris, target_edge_mm, cap)

    pts_arr = np.asarray(pts, dtype=np.float64)
    uv_arr = np.asarray(uv, dtype=np.float64)
    tris_arr = np.asarray(tris, dtype=np.int64)
    # median, not mean: the aligned-grid path stitches a sparse boundary ring
    # with a few long edges that would skew a mean and false-trigger the clamp
    mean_edge = float(np.median(np.linalg.norm(pts_arr[tris_arr[:, 0]] - pts_arr[tris_arr[:, 1]], axis=1)))

    u_mm, v_mm = _face_uv_to_mm(surf, uv_arr[:, 0], uv_arr[:, 1], _u_period(spec, scale))

    inset_mm = max(float(spec.get("boundaryInset", 0.0)), 0.0)
    # vertices sitting on a closed face's UV seam — an artificial cut, so they
    # must not be pinned like a real face boundary (see _boundary_taper)
    seam = None
    if _surface_kind(surf) in ("cylinder", "cone"):
        span = float(surf.LastUParameter() - surf.FirstUParameter())
        if abs(span - 2.0 * math.pi) < 1e-6:
            turn = _turn_mm(surf, _u_period(spec, scale))
            seam = (np.abs(u_mm) < 1e-6) | (np.abs(u_mm - turn) < 1e-6)
    taper, edge_count = _boundary_taper(pts_arr, tris, inset_mm, exempt=seam)
    manifold_ok, manifold_bad = _manifold_check(edge_count)

    normals, t_u, t_v = _face_frame(surf, uv_arr, flip)

    flat_indices = []
    for a, b, c in tris:
        flat_indices.append(a)
        flat_indices.append(b)
        flat_indices.append(c)

    return {
        "pts": pts_arr, "tris": len(tris), "flat_indices": flat_indices,
        "mean_edge": mean_edge, "u_mm": u_mm, "v_mm": v_mm,
        "lattice": lattice_used,
        "taper": taper, "manifold_ok": manifold_ok, "manifold_bad": manifold_bad,
        "normals": normals, "t_u": t_u, "t_v": t_v,
    }


def _orient_windings(P, I, normals):
    """Return I with every triangle wound to AGREE with its vertices' normals.

    The lattice assembly triangulates in the 2D chart with scipy's Delaunay,
    whose simplex orientation is NOT guaranteed consistent — measured on a
    reversed tube face: 40,062 triangles wound outward, 40,064 inward, split
    cleanly down two halves of the cylinder. The analytic normals were right,
    but a double-sided renderer decides front/back per PIXEL from the winding
    and NEGATES the shading normal on back faces, so the inward-wound half lit
    inside-out — a hard model-fixed light/dark split no lighting rig could
    remove (2026-08-02, the whole evening's "hard line"). Winding also rides
    into STL/3MF, where inconsistent orientation is a printability defect.

    An earlier patch flipped the emitted NORMAL to match the winding — exactly
    backwards under gl_FrontFacing negation. Orient the WINDING; normals are
    already correct."""
    e1 = P[I[:, 1]] - P[I[:, 0]]
    e2 = P[I[:, 2]] - P[I[:, 0]]
    gn = np.cross(e1, e2)
    ref = normals[I[:, 0]] + normals[I[:, 1]] + normals[I[:, 2]]
    flip = (gn * ref).sum(axis=1) < 0.0
    if flip.any():
        I = I.copy()
        I[flip, 1], I[flip, 2] = I[flip, 2], I[flip, 1].copy()
    return I


def displace_face(face, tri, loc, ident, spec, density_cap, diag=None, feature_id=None,
                  split_creases=False):
    """Return (positions, indices, normals) — a LOCAL (0-based) flat mesh for one
    textured face plus per-vertex displaced normals, ready for the caller to
    offset and append into the global buffers (same convention tessellate()'s
    own per-face loop already uses).

    `split_creases` (VIEWPORT ONLY — see the flat-shading note at the return)
    emits the face non-indexed with per-triangle normals, so a faceted profile
    reads as hard surface instead of being smoothed across its creases."""
    from OCP.TopAbs import TopAbs_Orientation

    flip = face.wrapped.Orientation() == TopAbs_Orientation.TopAbs_REVERSED
    kind = spec["kind"]
    scale = max(float(spec.get("scale", 2.0)), 0.05)
    target_edge_mm = max(scale / 4.0, 0.05)  # ~4 samples per pattern wavelength
    cap = density_cap if density_cap else _DEFAULT_DENSITY_CAP
    inset_mm = max(float(spec.get("boundaryInset", 0.0)), 0.0)

    key = _geometry_key(face, tri, flip, spec, scale, float(spec.get("angle", 0.0)), inset_mm, cap)
    geom = _GEOM_CACHE.pop(key, None)
    if geom is None:
        geom = _displacement_geometry(face, tri, loc, ident, spec, scale, target_edge_mm, cap, flip)
    _GEOM_CACHE[key] = geom  # (re)insert = most-recently-used
    while len(_GEOM_CACHE) > _GEOM_CACHE_MAX:
        _GEOM_CACHE.pop(next(iter(_GEOM_CACHE)))

    pts_arr = geom["pts"]
    taper = geom["taper"]
    normals, t_u, t_v = geom["normals"], geom["t_u"], geom["t_v"]
    mean_edge = geom["mean_edge"]

    spec_h = spec
    if kind != "image" and not geom.get("lattice") and mean_edge > target_edge_mm * 1.25:
        # the density cap stopped refinement short of the target sampling —
        # evaluating the pattern at its true frequency would alias into noise.
        # Clamp the wavelength to what this mesh can carry so an under-sampled
        # face shows a clean, coarser pattern; exports use a far larger cap.
        #
        # A crease-aligned lattice is exempt: its edge length is set by the
        # PATTERN (a rib cell is one period long however coarse the budget), not
        # by a sampling rate, and it reproduces the profile exactly at any size.
        # Clamping it would coarsen a pattern that was never under-sampled.
        spec_h = dict(spec, scale=4.0 * mean_edge)
        if diag is not None:
            diag.append({
                "feature_id": feature_id, "kind": "texture",
                "resolved": geom["tris"], "confidence": 0.5, "lossy": True,
                "reason": "texture shown coarser than print detail (display mesh cap); exports keep full detail",
            })

    offset = float(spec.get("offset", 0.0))
    u_mm = geom["u_mm"] + offset if offset else geom["u_mm"]
    v_mm = geom["v_mm"]
    u_range = (float(u_mm.min()), float(u_mm.max()))
    v_range = (float(v_mm.min()), float(v_mm.max()))

    invert = bool(spec.get("invert"))
    direction = spec.get("direction", "out")

    def signed_at(du, dv):
        """The signed height field sampled at a (mm) offset from the vertices —
        one function so the finite-difference gradient below differentiates the
        SAME invert/direction-transformed field the displacement uses."""
        hh = height_field(kind, spec_h, u_mm + du, v_mm + dv, u_range, v_range)
        if invert:
            hh = 1.0 - hh
        if direction == "in":
            return hh - 1.0
        if direction == "both":
            return (hh - 0.5) * 2.0
        return hh

    signed = signed_at(0.0, 0.0)

    depth = float(spec.get("depth", 0.4))
    disp = pts_arr + normals * (depth * signed * taper)[:, None]

    # Analytic displaced normals (the whole reason coarse displacement can still
    # SHADE smoothly): n' ∝ n − depth·taper·∇h, with the tangent-plane gradient
    # from central differences of the signed field — generic across every kind,
    # image included, at the cost of four extra vectorized height evaluations.
    # (∇taper is ignored: it varies over boundaryInset ≫ one wavelength.)
    eps = max(float(spec_h.get("scale", 2.0)) / 16.0, 1e-3)
    dhdu = (signed_at(eps, 0.0) - signed_at(-eps, 0.0)) / (2.0 * eps)
    dhdv = (signed_at(0.0, eps) - signed_at(0.0, -eps)) / (2.0 * eps)
    grad = (t_u * dhdu[:, None] + t_v * dhdv[:, None]) * (depth * taper)[:, None]
    disp_normals = normals - grad
    ln = np.linalg.norm(disp_normals, axis=1)
    ln[ln < 1e-12] = 1.0
    disp_normals /= ln[:, None]

    if not geom["manifold_ok"] and diag is not None:
        diag.append({
            "feature_id": feature_id, "kind": "texture",
            "resolved": geom["tris"], "confidence": 0.0, "lossy": True,
            "reason": f"{geom['manifold_bad']} non-manifold edge(s) in textured region (mesh crack risk)",
        })

    if split_creases and _is_facet(spec):
        # HARD-SURFACE SHADING. A shared vertex can carry only ONE normal, so on
        # a creased surface it is forced to average the two facets that meet
        # there — which is exactly why sharp geometry still rendered soft. Emit
        # the face non-indexed (3 vertices per triangle) with each triangle's own
        # geometric normal.
        #
        # VIEWPORT ONLY, deliberately: positions/indices from here also feed
        # STL/3MF export, and de-indexing a 3MF means shared edges no longer
        # share a vertex index — geometrically watertight but flagged as
        # non-manifold by some slicers. Printing correctness beats shading, so
        # the export path keeps the indexed mesh (STL is non-indexed regardless).
        idx = _orient_windings(disp, np.asarray(geom["flat_indices"], dtype=np.int64).reshape(-1, 3),
                               disp_normals)
        tri_pts = disp[idx]  # (T, 3, 3)
        fn = np.cross(tri_pts[:, 1] - tri_pts[:, 0], tri_pts[:, 2] - tri_pts[:, 0])
        ln = np.linalg.norm(fn, axis=1)
        ln[ln < 1e-12] = 1.0
        fn /= ln[:, None]
        out_pts = tri_pts.reshape(-1, 3)
        return (
            out_pts.ravel().tolist(),
            list(range(len(out_pts))),
            np.repeat(fn, 3, axis=0).ravel().tolist(),
        )

    idx = _orient_windings(disp, np.asarray(geom["flat_indices"], dtype=np.int64).reshape(-1, 3),
                           disp_normals)
    return disp.ravel().tolist(), idx.ravel().tolist(), disp_normals.ravel().tolist()