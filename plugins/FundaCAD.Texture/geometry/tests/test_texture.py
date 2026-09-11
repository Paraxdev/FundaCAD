"""Surface-texture tests (sidecar): two-phase validate/resolve, UV displacement,
boundary crack-freedom, the mesh-cache texture-key fix, and per-kind height
fields. Run: uv run python test_texture.py  (or: uv run pytest test_texture.py)
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import os
import tempfile

import numpy as np

import plugin_geometry
import server
import texture
import texture_height
import texture_mesh
from builder import rebuild
from tessellate import tessellate

PASS = "  ok"


def _box(idx, w, h, depth, x=0, y=0, op="new"):
    """Two features (sketch + extrude) that build a w×h×depth box at (x,y)."""
    s, e = f"s{idx}", f"e{idx}"
    return s, [
        {"id": s, "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]},
        {"id": e, "type": "extrude", "sketch": s, "distance": depth, "operation": op},
    ]


def test_validate_texture_spec_rejects_bad_input():
    try:
        texture.validate_texture_spec({"kind": "glitter"})
        assert False, "unknown kind should raise"
    except ValueError:
        pass
    try:
        texture.validate_texture_spec({"kind": "knurl", "depth": -1})
        assert False, "non-positive depth should raise"
    except ValueError:
        pass
    try:
        texture.validate_texture_spec({"kind": "waves", "direction": "sideways"})
        assert False, "unknown direction should raise"
    except ValueError:
        pass
    spec = texture.validate_texture_spec({"kind": "knurl", "depth": 0.4, "scale": 2.0})
    assert spec["kind"] == "knurl" and spec["faces"] == {"by": "all"}
    print(PASS, "validate_texture_spec rejects bad kind/depth/direction, defaults faces to 'all'")


def test_whole_body_knurl_increases_triangles_and_bounds_displacement():
    _s, feats = _box(1, 20, 20, 5)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "knurl", "faces": {"by": "all"},
         "depth": 0.4, "scale": 2.0},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = bodies[0]
    resolved = plugin_geometry.resolve(b)
    assert resolved and resolved[0][1], "the 'all' selector should resolve to every face"

    pos_plain, idx_plain, _ = tessellate(b["shape"], 0.1)
    pos_tex, idx_tex, _ = tessellate(b["shape"], 0.1, mesh_passes=resolved)
    assert len(idx_tex) > len(idx_plain), "textured mesh should gain triangles from subdivision"

    p = np.array(pos_tex).reshape(-1, 3)
    pp = np.array(pos_plain).reshape(-1, 3)
    # displacement is bounded by depth in every direction (plus float slack)
    assert (p.max(axis=0) - pp.max(axis=0) <= 0.4 + 1e-6).all(), "displacement exceeded depth"
    assert (pp.min(axis=0) - p.min(axis=0) <= 0.4 + 1e-6).all(), "displacement exceeded depth"
    print(PASS, f"whole-body knurl: {len(idx_plain)//3} -> {len(idx_tex)//3} tris, "
                f"displacement bounded by depth")


def test_selected_face_only_leaves_other_faces_unchanged():
    _s, feats = _box(1, 20, 20, 5)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "ribs",
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "depth": 0.3, "scale": 2.0},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = bodies[0]
    resolved = plugin_geometry.resolve(b)
    pos_p, idx_p, fid_p = tessellate(b["shape"], 0.1)
    pos_t, idx_t, fid_t = tessellate(b["shape"], 0.1, mesh_passes=resolved)

    def face_points(pos, idx, fids, target):
        P = np.array(pos).reshape(-1, 3)
        I = np.array(idx).reshape(-1, 3)
        tris = I[np.array(fids) == target]
        return set(map(tuple, np.round(P[tris.ravel()], 6))) if len(tris) else set()

    all_fids = sorted(set(fid_p) | set(fid_t))
    changed = [f for f in all_fids if face_points(pos_p, idx_p, fid_p, f) != face_points(pos_t, idx_t, fid_t, f)]
    assert len(changed) == 1, f"expected exactly 1 changed face, got {changed}"
    assert len(all_fids) - 1 == 5, all_fids
    print(PASS, f"texturing one selected face leaves the other {len(all_fids) - 1} faces byte-identical")


def test_boundary_taper_to_zero_at_edge():
    # a synthetic 5x5 grid over [0,4]x[0,4] (1mm cells), no OCCT needed, since
    # _boundary_taper is a pure geometry function over (points, triangles). The
    # center sits 2mm from every edge, well past a 1mm inset, so it should reach
    # full height while every boundary vertex tapers to exactly zero.
    n = 5
    pts = [(i, j, 0.0) for j in range(n) for i in range(n)]
    pts_arr = np.array(pts, dtype=float)

    def vid(i, j):
        return j * n + i

    tris = []
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)
            tris.append((a, b, c))
            tris.append((a, c, d))

    taper, edge_count = texture_mesh._boundary_taper(pts_arr, tris, inset_mm=1.0)
    for idx in (vid(0, 0), vid(n - 1, 0), vid(0, n - 1), vid(n - 1, n - 1)):
        assert taper[idx] < 1e-9, f"boundary vertex {idx} should taper to exactly 0, got {taper[idx]}"
    center = vid(n // 2, n // 2)
    assert taper[center] > 0.99, f"interior vertex 2mm from every edge should reach full height, got {taper[center]}"
    print(PASS, "boundary taper is exactly zero at face-boundary vertices, full height in the interior")


def test_manifold_check_flags_bad_edge_count():
    good = {(0, 1): 2, (1, 2): 2, (2, 0): 1, (0, 3): 1, (3, 1): 1}  # interior edges=2, boundary=1
    ok, bad = texture_mesh._manifold_check(good)
    assert ok and bad == 0, (ok, bad)

    broken = {(0, 1): 3, (1, 2): 2, (2, 0): 1}  # an edge shared by 3 triangles is a bug
    ok2, bad2 = texture_mesh._manifold_check(broken)
    assert not ok2 and bad2 == 1, (ok2, bad2)
    print(PASS, "manifold check accepts 1/2-shared edges and flags anything else")


def test_manifold_diagnostic_surfaces_from_displace_face():
    # a pathologically dense request (tiny scale) forces max subdivision against the
    # density cap; even so the SAME dedup logic keeps it manifold, the diagnostic
    # path itself is unit-tested above, so here we confirm displace_face never
    # raises and produces a closed, well-formed local mesh at the cap.
    _s, feats = _box(1, 10, 10, 5)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "noise", "faces": {"by": "all"},
         "depth": 0.2, "scale": 0.3, "seed": 1},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = bodies[0]
    resolved = plugin_geometry.resolve(b)
    diag = []
    pos, idx, fids = tessellate(b["shape"], 0.1, mesh_passes=resolved, density_cap=5000, diag=diag)
    assert len(idx) > 0
    # the cap-bound case legitimately emits a "shown coarser than print detail"
    # note (frequency clamped to what the mesh can carry), only a MANIFOLD
    # diagnostic would mean the mesh itself is broken.
    bad_diags = [d for d in diag if d.get("kind") == "texture" and "non-manifold" in d.get("reason", "")]
    assert not bad_diags, f"dense-but-valid subdivision should stay manifold, got {bad_diags}"
    coarse = [d for d in diag if "coarser than print detail" in d.get("reason", "")]
    assert coarse, "cap-bound subdivision should surface the coarse-preview note"
    print(PASS, "dense texture stays manifold under the density cap (coarse-preview note surfaced)")


def test_cache_key_changes_with_texture_params():
    """Regression test for the server.py _body_payload fix: a texture-only spec edit
    on the SAME shape object (the case a downstream unrelated timeline tweak can't
    tell apart from a no-op) must still invalidate the mesh cache. Without folding
    the texture-spec hash into the cache key, this would incorrectly serve the
    stale pre-texture mesh (same shape identity, same tolerance)."""
    _s, feats = _box(1, 10, 10, 5)
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = dict(bodies[0])
    b["id"] = "texcache-test-1"
    server._MESH_CACHE.pop(b["id"], None)

    b[plugin_geometry.BODY_KEY] = None
    # a small document keeps full quality, see server._viewport_profile
    profile = server._viewport_profile(1)
    ent1 = server._body_payload(b, 0.1, profile)
    b[plugin_geometry.BODY_KEY] = [texture.validate_texture_spec(
        {"kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0}
    )]
    ent2 = server._body_payload(b, 0.1, profile)

    assert ent1["etag"] != ent2["etag"], "a texture-only edit must invalidate the cached mesh"
    assert len(ent2["payload"]["positions"]) > len(ent1["payload"]["positions"]), \
        "the re-tessellated mesh should reflect the new texture (more verts from subdivision)"
    server._MESH_CACHE.pop(b["id"], None)
    print(PASS, "texture-spec-only edit changes the mesh cache key/etag (server.py fix verified)")


def test_height_field_kinds_in_zero_one_and_angle_rotates():
    # 1D u/v arrays, matching real usage: displace_face always calls height_field
    # with flattened per-vertex coordinate arrays, never a 2D meshgrid.
    rng = np.random.default_rng(0)
    U = rng.uniform(-5, 5, 1200)
    V = rng.uniform(-3, 3, 1200)

    for kind in ("knurl", "hex", "waves", "ribs"):
        spec = {"scale": 2.0, "angle": 15.0, "sharpness": 0.5}
        h = texture.height_field(kind, spec, U, V)
        assert h.shape == U.shape
        assert h.min() >= -1e-9 and h.max() <= 1 + 1e-9, f"{kind} field out of [0,1]: {h.min()}..{h.max()}"

    hv = texture.height_field("voronoi", {"scale": 2.0, "seed": 7}, U, V)
    assert hv.min() >= -1e-9 and hv.max() <= 1 + 1e-9

    hn = texture.height_field("noise", {"scale": 2.0, "seed": 3, "octaves": 3}, U, V)
    assert hn.min() >= -1e-9 and hn.max() <= 1 + 1e-9

    # rotate(u,v,90) == (-v,u): a 90-degree wave pattern must equal the unrotated
    # pattern evaluated with u <- -v, an exact algebraic transpose check.
    spec0 = {"scale": 2.0, "angle": 0.0, "sharpness": 0.5}
    spec90 = {"scale": 2.0, "angle": 90.0, "sharpness": 0.5}
    lhs = texture.height_field("waves", spec90, U, V)
    rhs = texture.height_field("waves", spec0, -V, np.zeros_like(V))
    assert np.allclose(lhs, rhs, atol=1e-9), "90-degree rotation should be an exact axis swap"
    print(PASS, "height_field kinds stay in [0,1]; angle rotation is exact")


def test_height_field_image_bilinear():
    from PIL import Image

    d = tempfile.mkdtemp()
    p = os.path.join(d, "grad.png")
    im = Image.new("L", (2, 2), 0)
    im.putpixel((1, 0), 255)
    im.putpixel((1, 1), 255)
    im.save(p)
    im.close()

    u = np.array([0.0, 5.0, 10.0])
    v = np.array([0.0, 0.0, 0.0])
    h = texture.height_field("image", {"imagePath": p}, u, v, u_range=(0.0, 10.0), v_range=(-1.0, 1.0))
    assert h[0] < 0.1, f"left edge should sample near-black, got {h[0]}"
    assert h[-1] > 0.9, f"right edge should sample near-white, got {h[-1]}"
    assert 0.3 < h[1] < 0.7, f"midpoint should be mid-gray, got {h[1]}"
    print(PASS, "image texture bilinear-samples across the face's UV bbox")


def test_texture_selector_survives_downstream_fillet():
    _s, feats = _box(1, 20, 20, 10)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "knurl",
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "depth": 0.3, "scale": 2.0},
        {"id": "fl", "type": "fillet", "edges": {"kind": "edge", "by": "axis", "axis": "Z"}, "radius": 1},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    b = bodies[0]
    assert b.get(plugin_geometry.BODY_KEY), "the texture spec should survive onto the body dict"
    resolved = plugin_geometry.resolve(b)
    assert resolved and resolved[0][1], "the texture selector should still match a face after the fillet"
    pos, idx, fids = tessellate(b["shape"], 0.1, mesh_passes=resolved)
    assert len(idx) // 3 > 0
    print(PASS, "texture selector survives a downstream fillet edit")


def test_missing_image_is_feature_error_not_crash():
    _s, feats = _box(1, 10, 10, 5)
    feats = feats + [
        {"id": "tex", "type": "texture", "kind": "image", "faces": {"by": "all"},
         "imagePath": "/nonexistent/path/does-not-exist.png", "depth": 0.3, "scale": 2.0},
    ]
    part, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert errors, "a missing image path should be a feature error, not a silent pass"
    assert errors[0]["feature_id"] == "tex", errors
    assert part is not None and part.volume > 0, "the prior box feature must still build (error containment)"
    print(PASS, "missing texture image is a contained feature error, not a crash")


def test_texture_targets_bound_body_not_active_in_multibody():
    # Regression: with >1 body, a texture that omits `body` falls back to the
    # ACTIVE (last-created) body and resolves its face selector against the wrong
    # shape, so it lands on a random face of the wrong body (field report). The
    # frontend now binds `body`; the sidecar must honor it over require_active.
    feats = _box(1, 20, 20, 5, x=0)[1] + _box(2, 20, 20, 5, x=100)[1]
    sel = {"kind": "face", "by": "nearest", "point": [0, 0, 5]}  # aimed at body1's top

    # no body → require_active fallback aims at body2 (the last one built), where
    # the point is 90mm away and several faces are exactly tied. That used to
    # texture a random face of the wrong body silently; the selector ambiguity
    # gate now refuses, so the feature red-chips and NOTHING is textured.
    part, errors, bodies = rebuild({"parameters": {}, "features": feats + [
        {"id": "tex", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0, "faces": sel}]})
    assert errors and "ambiguous face reference" in errors[0]["message"], errors
    by_id = {b["id"]: b for b in bodies}
    assert not by_id["body1"].get(plugin_geometry.BODY_KEY) and not by_id["body2"].get(plugin_geometry.BODY_KEY), \
        "a refused selector must not texture ANY body"

    # body=body1 → honored, texture lands on the intended body
    part, errors, bodies = rebuild({"parameters": {}, "features": feats + [
        {"id": "tex", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0,
         "body": "body1", "faces": sel}]})
    assert not errors, errors
    by_id = {b["id"]: b for b in bodies}
    assert by_id["body1"].get(plugin_geometry.BODY_KEY) and not by_id["body2"].get(plugin_geometry.BODY_KEY), \
        "with `body=body1`, the texture must land on body1, not the active body"
    resolved = plugin_geometry.resolve(by_id["body1"])
    assert resolved and resolved[0][1], "the bound-body selector must resolve to a face"
    print(PASS, "texture honors bound `body` over active-body fallback (multi-body)")


def test_faceted_profile_is_piecewise_planar():
    """The hard-surface claim, measured. A faceted profile puts ALL its curvature
    at the creases and none in between (median 2nd difference exactly 0); the
    round profile spreads curvature over the whole cell, which is what read as
    soft bumps. knurl's old field was tri*tri, a product of two linear ramps is
    a BILINEAR SADDLE, so every cell curved."""
    x = np.linspace(0.0, 6.0, 301)
    y = np.zeros_like(x)
    for kind in ("knurl", "waves", "ribs", "hex", "noise"):
        spec = {"scale": 2.0, "angle": 45.0, "sharpness": 0.3, "seed": 1, "octaves": 3}
        facet = np.asarray(texture.height_field(kind, dict(spec, profile="facet"), x, y), dtype=float)
        round_ = np.asarray(texture.height_field(kind, dict(spec, profile="round"), x, y), dtype=float)
        med_f = float(np.median(np.abs(np.diff(facet, 2))))
        med_r = float(np.median(np.abs(np.diff(round_, 2))))
        assert med_f < 1e-12, f"{kind} facet should be flat between creases, median |2nd| = {med_f}"
        assert med_r > 1e-9, f"{kind} round should be curved throughout, median |2nd| = {med_r}"
        assert np.abs(np.diff(facet, 2)).max() > 1e-6, f"{kind} facet has no creases at all"
    print(PASS, "faceted profiles are piecewise planar; round profiles are curved throughout")


def test_knurl_facet_is_min_of_grooves_not_bilinear_product():
    """Two crossed V-grooves cut a MIN, not a product. At the centre of a cell
    both grooves are at full height, so min() is 1 while the product is also 1,
    the two disagree off-axis, where the product's saddle sags."""
    s = 2.0
    # A 2D grid, not a line: along v=0 both grooves collapse to the same value
    # and min() == product trivially. The two only separate where BOTH grooves
    # are partway down, e.g. (0.25s, 0.25s): min=0.5 but product=0.25.
    g = np.linspace(0.05, 0.95, 11) * s
    U, V = np.meshgrid(g, g)
    u, v = U.ravel(), V.ravel()
    facet = texture_height._height_knurl(u, v, s, 0.0, 0.0, facet=True)
    product = texture_height._height_knurl(u, v, s, 0.0, 0.0, facet=False)
    _, v1 = texture_height._rotate(u, v, 0.0)
    _, v2 = texture_height._rotate(u, v, 90.0)
    expect = np.minimum(texture_height._tri_wave(v1, s), texture_height._tri_wave(v2, s))
    assert np.allclose(facet, expect), f"facet knurl should be min-of-grooves, got {facet}"
    assert not np.allclose(facet, product), "facet and round knurl must differ"
    # the product SAGS below the true groove surface everywhere they differ,
    # that sag is the bilinear saddle that made this read as soft bumps
    assert np.all(product <= facet + 1e-12), "the bilinear product should never exceed min-of-grooves"
    assert (facet - product).max() > 0.2, "the saddle sag should be substantial"
    print(PASS, "faceted knurl is min-of-two-grooves, not the bilinear product")


def test_terrace_quantises_into_flat_levels():
    h = np.linspace(0.0, 1.0, 500)
    for steps in (2, 5, 12):
        levels = np.unique(np.round(texture_height._terrace(h, steps), 9))
        assert len(levels) == steps, f"{steps} steps should give {steps} levels, got {len(levels)}"
    # the Sharp slider drives the count for the continuous kinds
    assert texture_height._steps_from(0.0) == 2
    assert texture_height._steps_from(1.0) == 12
    print(PASS, "terracing quantises noise/image into exactly N flat levels")


def test_trapezoid_land_widens_the_flat_top():
    x = np.linspace(0.0, 2.0, 401)
    pure_v = texture_height._trapezoid(x, 2.0, 0.0)
    landed = texture_height._trapezoid(x, 2.0, 0.6)
    at_top = lambda h: int(np.sum(h > 0.999))
    assert at_top(pure_v) <= 2, "land=0 is a pure V: only the apex reaches full height"
    assert at_top(landed) > 10, "land>0 must produce a real flat crest"
    assert landed.max() <= 1.0 + 1e-12 and landed.min() >= -1e-12
    print(PASS, "trapezoid land widens the crest without leaving [0,1]")


def test_hard_edge_keeps_boundary_pinned_but_full_depth_inside():
    """The crack-free invariant under the new inset=0 default. Boundary vertices
    MUST stay at exactly zero displacement (a neighbouring untextured face meets
    them, and any drift is a visible crack / broken export) while the first
    interior sample already carries full depth, that is the machined cut-off
    look, as opposed to the old 1mm fade."""
    n = 5
    pts_arr = np.array([(i, j, 0.0) for j in range(n) for i in range(n)], dtype=float)
    vid = lambda i, j: j * n + i
    tris = []
    for j in range(n - 1):
        for i in range(n - 1):
            a, b, c, d = vid(i, j), vid(i + 1, j), vid(i + 1, j + 1), vid(i, j + 1)
            tris += [(a, b, c), (a, c, d)]
    taper, _ = texture_mesh._boundary_taper(pts_arr, tris, inset_mm=0.0)
    for idx in (vid(0, 0), vid(n - 1, 0), vid(0, n - 1), vid(2, 0)):
        assert taper[idx] == 0.0, f"boundary vertex {idx} must be EXACTLY 0, got {taper[idx]}"
    assert taper[vid(1, 1)] == 1.0, "the first interior sample should be at full depth, not faded"
    print(PASS, "hard edge: boundary pinned at exactly zero, full depth one sample in")


def test_faceted_display_splits_creases_but_export_stays_indexed():
    """Hard shading needs unshared vertices (one vertex can carry one normal),
    but de-indexing the EXPORT mesh would leave a 3MF whose shared edges no
    longer share a vertex index, watertight, yet flagged non-manifold by some
    slicers. Display splits; export must not."""
    from tessellate import tessellate

    doc = {"parameters": {}, "features": [
        {"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
        {"id": "t", "type": "texture", "kind": "knurl",
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "depth": 0.4, "scale": 2.0, "angle": 45, "profile": "facet"}]}
    _p, errs, bodies = rebuild(doc)
    assert not errs, errs
    tex = plugin_geometry.resolve(bodies[0])

    norms = []
    d_pos, d_idx, _ = tessellate(bodies[0]["shape"], 0.05, mesh_passes=tex, normals_out=norms)
    e_pos, e_idx, _ = tessellate(bodies[0]["shape"], 0.05, mesh_passes=tex, normals_out=None)

    assert len(d_idx) == len(e_idx), "crease splitting must not change the TRIANGLE count"
    assert len(d_pos) > len(e_pos), "display should un-share vertices for flat shading"
    # export keeps vertices shared: far fewer than 3 per triangle
    assert len(e_pos) // 3 < len(e_idx), "export mesh must stay indexed for 3MF"
    print(PASS, f"display splits creases ({len(d_pos)//3} verts), export stays indexed ({len(e_pos)//3})")


def test_every_kind_meshes_cleanly_at_the_faceted_default():
    """No kind may crash, go non-manifold, or produce NaNs now that facet is the
    default for all of them."""
    from tessellate import tessellate

    for kind in ("knurl", "hex", "waves", "ribs", "voronoi", "noise"):
        doc = {"parameters": {}, "features": [
            {"id": "b", "type": "box", "length": 20, "width": 20, "height": 10},
            {"id": "t", "type": "texture", "kind": kind,
             "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
             "depth": 0.3, "scale": 2.0, "seed": 3}]}
        _p, errs, bodies = rebuild(doc)
        assert not errs, f"{kind}: {errs}"
        tex = plugin_geometry.resolve(bodies[0])
        assert tex, f"{kind}: texture did not resolve"
        diag = []
        pos, idx, _ = tessellate(bodies[0]["shape"], 0.05, mesh_passes=tex, diag=diag, normals_out=[])
        assert np.all(np.isfinite(np.asarray(pos, dtype=float))), f"{kind}: non-finite positions"
        assert len(idx) > 0, f"{kind}: no triangles"
        bad = [d for d in diag if "non-manifold" in str(d.get("reason", ""))]
        assert not bad, f"{kind}: {bad}"
    print(PASS, "every kind meshes cleanly, finite and manifold, at the faceted default")


def test_boundary_ring_is_dense_enough_to_carry_the_pattern():
    """The edge-band bug. _aligned_grid_triangulation used to keep the boundary
    ring VERBATIM from OCCT's base triangulation, on a real filleted part that
    was 20 vertices with an 18mm longest edge against a 2mm pattern period, so
    the strip along the rim had no vertices to undulate with and came out flat
    and smeared however fine the interior got.

    The ring is now subdivided to the sample spacing. The invariant that must
    hold alongside it: every ring vertex still lies EXACTLY on the real face
    (they are lerps along the existing boundary polyline), or the seam against
    the neighbouring face opens a crack."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopLoc import TopLoc_Location
    import OCP.gp as gp

    # a face with a long straight boundary edge, which is where it went wrong
    doc = {"parameters": {}, "features": [
        {"id": "b", "type": "box", "length": 40, "width": 40, "height": 10},
        {"id": "t", "type": "texture", "kind": "knurl",
         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
         "depth": 0.4, "scale": 2.0, "angle": 30, "profile": "facet"}]}
    _p, errs, bodies = rebuild(doc)
    assert not errs, errs
    shape = bodies[0]["shape"]
    BRepMesh_IncrementalMesh(shape.wrapped, 0.05, False, 0.5, True)
    spec, faces = plugin_geometry.resolve(bodies[0])[0]
    face = faces[0]
    scale = float(spec["scale"])
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
    geom = texture._displacement_geometry(
        face, tri, loc, loc.IsIdentity(), spec, scale, max(scale / 4, 0.05),
        texture._DEFAULT_DENSITY_CAP, False,
    )
    pts = geom["pts"]
    idx = np.asarray(geom["flat_indices"]).reshape(-1, 3)
    ec = texture_mesh._boundary_edges([tuple(t_) for t_ in idx])
    bnd = [k for k, n in ec.items() if n == 1]
    seg = [float(np.linalg.norm(pts[a] - pts[b])) for a, b in bnd]
    too_long = [x for x in seg if x > scale / 2.0]
    assert not too_long, (
        f"{len(too_long)} boundary edges exceed half a period (longest {max(seg):.2f}mm "
        f"vs period {scale}mm), the rim cannot carry the pattern"
    )
    # crack-free: the densified ring must stay ON the face, not cut corners
    ring = np.unique(np.asarray(bnd, dtype=np.int64).ravel())
    worst = max(face.distance_to(gp.gp_Pnt(*pts[i])) for i in ring)
    assert worst < 1e-9, f"ring vertex drifted {worst:.2e}mm off the face, that is a crack"
    print(PASS, f"boundary ring subdivided to {max(seg):.2f}mm (period {scale}), still exactly on the face")


def test_planar_chart_is_orthonormal_tangent_and_metric():
    """The projection frame a freeform face is textured in (see _planar_chart).

    Two properties the analytic-normal shading and the pattern layout both rely
    on. The per-vertex basis must be an orthonormal frame TANGENT to the surface,
    or the bumped normal picks up a component along the true normal and the
    pattern reads muddy. And the in-plane coordinates must be true millimetres,
    so a pattern set to a size is that size on the face."""
    from texture_mesh import _planar_chart

    # normals fanning through 90 degrees, a fillet corner in miniature
    th = np.linspace(0.0, np.pi / 2, 7)
    n = np.stack([np.cos(th), np.sin(th), np.zeros_like(th)], axis=1)
    pts = n * 10.0
    _u, _v, tu, tv = _planar_chart(pts, n)
    assert np.allclose(np.linalg.norm(tu, axis=1), 1.0, atol=1e-9), "t_u not unit length"
    assert np.allclose(np.linalg.norm(tv, axis=1), 1.0, atol=1e-9), "t_v not unit length"
    assert np.allclose(np.sum(tu * n, axis=1), 0.0, atol=1e-6), "t_u must be tangent (perp to n)"
    assert np.allclose(np.sum(tv * n, axis=1), 0.0, atol=1e-6), "t_v must be tangent (perp to n)"
    assert np.allclose(np.sum(tu * tv, axis=1), 0.0, atol=1e-6), "frame must be orthogonal"

    # metric: a flat patch reproduces its own spacing exactly, the projection is
    # an isometry there
    flat = np.array([[0, 0, 0], [3, 0, 0], [0, 5, 0], [3, 5, 0]], dtype=float)
    fn = np.tile([0.0, 0.0, 1.0], (4, 1))
    fu, fv, _, _ = _planar_chart(flat, fn)
    assert abs((fu.max() - fu.min()) - 3.0) < 1e-9 and abs((fv.max() - fv.min()) - 5.0) < 1e-9, (
        "planar coordinates are not true millimetres"
    )
    print(PASS, "planar chart: orthonormal tangent frame, metric in-plane coordinates")


def test_freeform_corner_texture_is_planar_and_finely_resolved():
    """A knurl on a big fillet corner, the case that reported as distorted.

    The corner blend is a freeform face the mm chart cannot measure exactly. Two
    things make it read cleanly there: it is sampled by planar projection along
    its own mean normal (metric-faithful, so the cells are one size and do not
    converge to the UV pole), and it is refined FINER than a charted face, so the
    planar pattern is not aliased into mush by a mesh that is not aligned to it.

    The control that must fail lives on both: drop the planar chart and the
    span diverges from the true metric extent; drop the finer refinement and the
    mean edge climbs back to the charted target and the pattern aliases."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopLoc import TopLoc_Location
    from texture_mesh import _surface_kind, _face_uv_to_mm, _planar_chart, _face_frame
    from texture_height import _u_period

    doc = {"parameters": {}, "features": [
        {"id": "b", "type": "box", "length": 40, "width": 40, "height": 40},
        {"id": "fx", "type": "fillet", "radius": 10, "edges": [
            {"kind": "edge", "by": "nearest", "point": [0, 20, 20]},
            {"kind": "edge", "by": "nearest", "point": [20, 0, 20]},
            {"kind": "edge", "by": "nearest", "point": [20, 20, 0]}]},
        {"id": "tex", "type": "texture", "kind": "knurl", "depth": 0.8, "scale": 3.0,
         "projection": "auto",  # this test is about the planar chart specifically
         "faces": {"by": "nearest", "point": [15, 15, 15]}}]}
    _p, errs, bodies = rebuild(doc)
    assert not errs, errs
    b = bodies[0]
    sh = b["shape"]

    # the freeform corner patch, near the +++ corner
    corner_fid, corner_face = None, None
    for fid, f in enumerate(sh.faces()):
        surf = BRepAdaptor_Surface(f.wrapped)
        if _surface_kind(surf) is not None:
            continue
        from OCP.GProp import GProp_GProps
        from OCP.BRepGProp import BRepGProp
        g = GProp_GProps(); BRepGProp.SurfaceProperties_s(f.wrapped, g); c = g.CentreOfMass()
        if c.X() > 8 and c.Y() > 8 and c.Z() > 8:
            corner_fid, corner_face = fid, f
    assert corner_fid is not None, "no freeform corner patch found, the fixture is wrong"

    resolved = plugin_geometry.resolve(b)
    assert resolved and resolved[0][1], "the texture should resolve onto the corner patch"
    pos, idx, fids = tessellate(sh, 0.1, mesh_passes=resolved, density_cap=texture._DEFAULT_DENSITY_CAP)
    pos = np.asarray(pos, dtype=float).reshape(-1, 3)
    idx = np.asarray(idx, dtype=int).reshape(-1, 3)
    fids = np.asarray(fids, dtype=int)
    tri = idx[fids == corner_fid]
    assert len(tri) > 0, "the corner patch has no textured triangles"
    e = np.concatenate([
        np.linalg.norm(pos[tri[:, 0]] - pos[tri[:, 1]], axis=1),
        np.linalg.norm(pos[tri[:, 1]] - pos[tri[:, 2]], axis=1),
        np.linalg.norm(pos[tri[:, 2]] - pos[tri[:, 0]], axis=1)])
    scale, target = 3.0, 3.0 / 4.0
    assert e.mean() <= target * 0.75, (
        f"freeform face not refined finer than a charted one: mean edge {e.mean():.3f}mm "
        f"> {target * 0.75:.3f}mm, the planar pattern will alias"
    )

    # planar chart is more metric-faithful than the single-Jacobian UV fallback:
    # its span tracks the face's true 3D extent, the reason the cells stop
    # stretching. Read the corner face's own triangulation for the comparison.
    BRepMesh_IncrementalMesh(sh.wrapped, 0.1, False, 0.5, True)
    loc = TopLoc_Location()
    t = BRep_Tool.Triangulation_s(corner_face.wrapped, loc)
    trsf = loc.Transformation()
    fp = []; fuv = []
    for i in range(1, t.NbNodes() + 1):
        p = t.Node(i)
        if not loc.IsIdentity():
            p = p.Transformed(trsf)
        fp.append((p.X(), p.Y(), p.Z())); up = t.UVNode(i); fuv.append((up.X(), up.Y()))
    fp = np.asarray(fp); fuv = np.asarray(fuv)
    surf = BRepAdaptor_Surface(corner_face.wrapped)
    true_diam = float(np.linalg.norm(fp[:, None, :] - fp[None, :, :], axis=2).max())
    uo, vo = _face_uv_to_mm(surf, fuv[:, 0], fuv[:, 1], _u_period({"kind": "knurl"}, scale))
    uv_diag = float(np.hypot(uo.max() - uo.min(), vo.max() - vo.min()))
    nrm, _, _ = _face_frame(surf, fuv, False)
    un, vn, _, _ = _planar_chart(fp, nrm)
    pl_diag = float(np.hypot(un.max() - un.min(), vn.max() - vn.min()))
    assert abs(pl_diag - true_diam) < abs(uv_diag - true_diam), (
        f"planar chart ({pl_diag:.2f}) is no closer to the true extent ({true_diam:.2f}) "
        f"than the single-Jacobian UV ({uv_diag:.2f}); the chart is not doing its job"
    )
    print(PASS, f"freeform corner: planar, metric ({pl_diag:.1f} vs true {true_diam:.1f}mm) and "
                f"finely resolved (mean edge {e.mean():.2f}mm)")


def test_grime_bleeds_onto_neighbours_and_zero_grime_does_not():
    """Grime reaches the faces NEXT TO the textured one, and nothing else.

    The control is the whole point: at grime 0 the neighbours are the smooth
    faces they always were, so this cannot pass by texturing the whole body. At
    grime > 0 the resolver hands displace the neighbours too, and their mesh
    gains triangles it did not have, the bleed. It must never touch the face's
    OWN triangle count (grime is not a second pattern on the textured face) and
    must leave the neighbours watertight at the shared edge (the bleed noise is
    pinned to zero at every boundary, like any textured face)."""
    def tri_count_by_face(grime):
        feats = [
            {"id": "b", "type": "box", "length": 40, "width": 40, "height": 20},
            {"id": "t", "type": "texture", "kind": "knurl", "depth": 0.7, "scale": 3.0,
             "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}, "grime": grime}]
        _p, errs, bodies = rebuild({"parameters": {}, "features": feats})
        assert not errs, errs
        b = bodies[0]
        resolved = plugin_geometry.resolve(b)
        pos, idx, fids = tessellate(b["shape"], 0.1, mesh_passes=resolved,
                                    density_cap=texture._DEFAULT_DENSITY_CAP)
        fids = np.asarray(fids, dtype=int)
        return {int(f): int((fids == f).sum()) for f in np.unique(fids)}, len(idx) // 3

    off, _ = tri_count_by_face(0.0)
    on, _ = tri_count_by_face(0.6)

    # the top face (the only heavily meshed one at grime 0) is untouched by grime
    top = max(off, key=off.get)
    assert on[top] == off[top], (
        f"grime changed the textured face itself: {off[top]} -> {on[top]} triangles"
    )
    # a side face that was a bare rectangle now carries the bleed mesh
    bled = [f for f in off if f != top and on.get(f, 0) > off[f] * 3]
    assert bled, (
        "no neighbour gained the bleed mesh; grime did not reach an adjacent face "
        f"(off={off}, on={on})"
    )
    # control: with grime off those same faces are their bare selves
    for f in bled:
        assert off[f] <= 2, f"a side face had {off[f]} triangles at grime 0, the control is not clean"
    print(PASS, f"grime bleeds onto {len(bled)} neighbour face(s); at grime 0 they stay bare")


def test_grime_zero_is_absent_from_the_spec():
    """A texture with no grime hashes and builds exactly as it always did.

    grime rides in the spec ONLY when non-zero (like colorSlot), so a document
    written before grime existed, or with the slider at zero, keeps its old
    mesh-cache identity and its byte-for-byte geometry. This is what lets the
    feature ship without a CODE_VERSION bump."""
    from register import _handle_texture  # noqa: F401  (ensures the plugin is importable)

    spec0 = texture.validate_texture_spec(
        {"id": "t", "kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0})
    assert "grime" not in spec0, "grime 0 must not appear in the spec"
    specg = texture.validate_texture_spec(
        {"id": "t", "kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0, "grime": 0.5})
    assert specg.get("grime") == 0.5, specg
    # clamped into 0..1 and validated as a number
    assert texture.validate_texture_spec(
        {"id": "t", "kind": "knurl", "depth": 0.4, "scale": 2.0, "grime": 9})["grime"] == 1.0
    try:
        texture.validate_texture_spec(
            {"id": "t", "kind": "knurl", "depth": 0.4, "scale": 2.0, "grime": -1})
        raise AssertionError("negative grime should be rejected")
    except ValueError:
        pass
    print(PASS, "grime is absent at zero, clamped to 1, and rejects a negative")


def test_smooth_low_passes_the_height_field():
    """The `smooth` control blurs the height field BEFORE it displaces. Two
    claims, each with its own control: smooth absent (or zero) is byte-identical
    to no control at all, and smooth=1 is a genuine low-pass, less amplitude and
    less high-frequency energy, so the relief reads softer."""
    x = np.linspace(0.0, 12.0, 600)
    y = np.zeros_like(x)
    base = {"kind": "ribs", "scale": 2.0, "angle": 0.0, "sharpness": 0.0, "profile": "facet"}

    ident = np.asarray(texture.height_field("ribs", dict(base), x, y), dtype=float)
    absent = np.asarray(texture_height.height_field_smoothed("ribs", dict(base), x, y), dtype=float)
    zero = np.asarray(texture_height.height_field_smoothed("ribs", dict(base, smooth=0.0), x, y), dtype=float)
    assert np.array_equal(absent, ident), "smooth absent must equal height_field exactly"
    assert np.array_equal(zero, ident), "smooth=0 must equal height_field exactly"

    soft = np.asarray(texture_height.height_field_smoothed("ribs", dict(base, smooth=1.0), x, y), dtype=float)
    tv = lambda h: float(np.abs(np.diff(h)).sum())
    assert soft.std() < ident.std() * 0.9, f"smooth=1 did not reduce amplitude: {soft.std():.4f} vs {ident.std():.4f}"
    assert tv(soft) < tv(ident) * 0.9, f"smooth=1 did not reduce total variation: {tv(soft):.3f} vs {tv(ident):.3f}"
    # still a valid [0,1] field, and a blur is DC-neutral so the mean holds
    assert soft.min() >= -1e-9 and soft.max() <= 1 + 1e-9, f"smoothed field left [0,1]: {soft.min()}..{soft.max()}"
    assert abs(soft.mean() - ident.mean()) < 0.05, "a blur should preserve the mean height"
    print(PASS, "smooth low-passes the height field; smooth=0 is byte-identical")


def test_smooth_softens_the_displaced_relief():
    """End to end through displace_face: smooth=1 pulls the displaced relief in
    (a softer surface) against smooth=0 on the same texture, and the smoothed mesh
    is still finite and manifold. smooth=0 is the control, it must reproduce the
    sharp relief exactly, so a no-op smooth could not pass this."""
    def top_relief(smooth):
        feats = [
            {"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
            {"id": "t", "type": "texture", "kind": "ribs", "depth": 0.5, "scale": 2.0,
             "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]},
             **({"smooth": smooth} if smooth else {})}]
        _p, errs, bodies = rebuild({"parameters": {}, "features": feats})
        assert not errs, errs
        b = bodies[0]
        resolved = plugin_geometry.resolve(b)
        diag = []
        pos, idx, fids = tessellate(b["shape"], 0.1, mesh_passes=resolved,
                                    density_cap=texture._DEFAULT_DENSITY_CAP, diag=diag)
        P = np.asarray(pos, dtype=float).reshape(-1, 3)
        assert np.all(np.isfinite(P)), "smoothed texture produced non-finite positions"
        bad = [d for d in diag if "non-manifold" in str(d.get("reason", ""))]
        assert not bad, f"smoothed texture went non-manifold: {bad}"
        # isolate the textured face: the one that gained the most triangles
        fids = np.asarray(fids, dtype=int)
        I = np.asarray(idx, dtype=int).reshape(-1, 3)
        counts = {int(f): int((fids == f).sum()) for f in np.unique(fids)}
        tf = max(counts, key=counts.get)
        z = P[np.unique(I[fids == tf].ravel()), 2]
        return float(z.max() - z.min())

    sharp = top_relief(0.0)
    soft = top_relief(1.0)
    assert soft < sharp * 0.9, f"smooth=1 did not soften the relief: peak-to-peak {soft:.3f}mm vs {sharp:.3f}mm"
    print(PASS, f"smooth softens the displaced relief ({sharp:.3f} -> {soft:.3f}mm peak-to-peak)")


def test_smooth_zero_is_absent_from_the_spec():
    """A texture with no soften hashes and builds exactly as it always did.

    smooth rides in the spec ONLY when non-zero (like grime and colorSlot), so a
    document written before the control existed, or with the slider at zero, keeps
    its old mesh-cache identity and byte-for-byte geometry. smooth>0 is the case
    that DOES move geometry, which is what CODE_VERSION 10 records."""
    spec0 = texture.validate_texture_spec(
        {"id": "t", "kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0})
    assert "smooth" not in spec0, "smooth 0 must not appear in the spec"
    specs = texture.validate_texture_spec(
        {"id": "t", "kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0, "smooth": 0.5})
    assert specs.get("smooth") == 0.5, specs
    # clamped into 0..1 and validated as a number
    assert texture.validate_texture_spec(
        {"id": "t", "kind": "knurl", "depth": 0.4, "scale": 2.0, "smooth": 9})["smooth"] == 1.0
    try:
        texture.validate_texture_spec(
            {"id": "t", "kind": "knurl", "depth": 0.4, "scale": 2.0, "smooth": -1})
        raise AssertionError("negative smooth should be rejected")
    except ValueError:
        pass
    print(PASS, "smooth is absent at zero, clamped to 1, and rejects a negative")


def _sphere_cap(theta_max_deg, n_phi=26, n_psi=60, R=10.0):
    """Points, radial normals and an orthonormal surface tangent frame over a cap
    of a sphere around +Z, out to `theta_max_deg` from the pole. Pure numpy, so
    the projection charts can be exercised without OCCT."""
    phi = np.linspace(0.02, math.radians(theta_max_deg), n_phi)
    psi = np.linspace(0.0, 2 * np.pi, n_psi, endpoint=False)
    PH, PS = np.meshgrid(phi, psi, indexing="ij")
    ph, ps = PH.ravel(), PS.ravel()
    sp, cp, ss, cs = np.sin(ph), np.cos(ph), np.sin(ps), np.cos(ps)
    P = R * np.stack([sp * cs, sp * ss, cp], axis=1)
    n = P / R
    e_phi = np.stack([cp * cs, cp * ss, -sp], axis=1)   # unit, tangent
    e_psi = np.stack([-ss, cs, np.zeros_like(ss)], axis=1)
    return P, n, e_phi, e_psi, ph


def test_triplanar_keeps_the_pattern_uniform_where_planar_foreshortens():
    """The stretch triplanar exists to remove, measured on a spherical cap.

    A single planar projection maps the surface orthographically, so where the
    face tilts away from the projection axis the pattern is foreshortened and its
    local frequency drops. Triplanar samples in world space, so the frequency
    holds across the curve. Measure the pattern's frequency as the RMS surface
    gradient of the field, in a pole cap (facing the axis) versus an edge ring
    (tilted ~60 degrees away), and compare how much the two differ.

    The control is the planar chart on the SAME geometry: it must show the drop
    that triplanar does not, so a projection that did nothing could not pass."""
    from texture_mesh import _tp_weights, _tp_exponent

    P, n, e_phi, e_psi, ph = _sphere_cap(80.0, n_phi=34, n_psi=72)
    spec = {"kind": "knurl", "scale": 3.0, "angle": 0.0, "profile": "round", "sharpness": 0.5}
    center = np.zeros(3)
    # planar chart's global axes, from the mean normal (~+Z here), the same
    # construction _planar_chart uses
    axis = n.mean(axis=0); axis = axis / np.linalg.norm(axis)
    seed = np.eye(3)[int(np.argmin(np.abs(axis)))]
    t = seed - axis * float(seed @ axis); t /= np.linalg.norm(t)
    b = np.cross(axis, t)
    mean = P.mean(axis=0)

    def planar_h(Q):
        return texture.height_field("knurl", spec, (Q - mean) @ t, (Q - mean) @ b)

    k = _tp_exponent({"projection": "triplanar", "seamBlend": 0.5})

    def tp_h(Q):
        w = _tp_weights(Q / np.linalg.norm(Q, axis=1, keepdims=True), k)
        return texture.triplanar_field("knurl", spec, Q, w)

    eps = 0.04

    def surface_grad_rms(h_of, mask):
        gu = (h_of(P[mask] + eps * e_phi[mask]) - h_of(P[mask] - eps * e_phi[mask])) / (2 * eps)
        gv = (h_of(P[mask] + eps * e_psi[mask]) - h_of(P[mask] - eps * e_psi[mask])) / (2 * eps)
        return float(np.sqrt(np.mean(gu ** 2 + gv ** 2)))

    pole = ph < math.radians(20)
    edge = ph > math.radians(62)

    planar_ratio = surface_grad_rms(planar_h, edge) / surface_grad_rms(planar_h, pole)
    tp_ratio = surface_grad_rms(tp_h, edge) / surface_grad_rms(tp_h, pole)

    # triplanar holds the frequency across the cap (ratio near 1); the planar
    # chart loses it toward the tilted edge. The planar chart must show a clear
    # drop, and triplanar must stay markedly closer to uniform.
    assert 1.0 - planar_ratio > 0.1, f"planar did not foreshorten as expected (ratio {planar_ratio:.3f})"
    assert abs(tp_ratio - 1.0) < abs(planar_ratio - 1.0) * 0.6, (
        f"triplanar not more uniform than planar: tp ratio {tp_ratio:.3f}, "
        f"planar ratio {planar_ratio:.3f}")
    print(PASS, f"triplanar holds pattern frequency on a curved face "
                f"(edge/pole {tp_ratio:.2f}) where planar foreshortens ({planar_ratio:.2f})")


def test_triplanar_is_the_freeform_default_and_auto_restores_planar():
    """Triplanar is the new default for a freeform face, and it actually reaches
    the mesh: the displaced corner patch differs from `projection: "auto"` (the
    old planar chart). A flat face is the control, projection is inert there, so
    the top of the box is byte-identical whichever mode is asked for. Both build
    clean, finite and manifold."""
    def build(projection):
        feats = [
            {"id": "b", "type": "box", "length": 40, "width": 40, "height": 40},
            {"id": "fx", "type": "fillet", "radius": 12, "edges": [
                {"kind": "edge", "by": "nearest", "point": [0, 20, 20]},
                {"kind": "edge", "by": "nearest", "point": [20, 0, 20]},
                {"kind": "edge", "by": "nearest", "point": [20, 20, 0]}]},
            # one texture on the freeform corner, one on the flat top (the control)
            {"id": "tc", "type": "texture", "kind": "knurl", "depth": 0.6, "scale": 3.0,
             **({"projection": projection} if projection else {}),
             "faces": {"by": "nearest", "point": [15, 15, 15]}},
            {"id": "tt", "type": "texture", "kind": "knurl", "depth": 0.6, "scale": 3.0,
             **({"projection": projection} if projection else {}),
             "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}]
        _p, errs, bodies = rebuild({"parameters": {}, "features": feats})
        assert not errs, (projection, errs)
        b = bodies[0]
        resolved = plugin_geometry.resolve(b)
        diag = []
        pos, idx, fids = tessellate(b["shape"], 0.1, mesh_passes=resolved,
                                    density_cap=texture._DEFAULT_DENSITY_CAP, diag=diag)
        P = np.asarray(pos, dtype=float).reshape(-1, 3)
        assert np.all(np.isfinite(P)), f"{projection}: non-finite"
        assert not [d for d in diag if "non-manifold" in str(d.get("reason", ""))], f"{projection}: non-manifold"
        fids = np.asarray(fids, dtype=int)
        I = np.asarray(idx, dtype=int).reshape(-1, 3)
        return P, I, fids

    P_def, I_def, F_def = build(None)       # default (no projection field)
    P_auto, I_auto, F_auto = build("auto")  # explicit planar
    P_tri, I_tri, F_tri = build("triplanar")

    # compare the displaced corner region (x,y,z all > 9) between modes
    def corner_pts(P):
        m = (P[:, 0] > 9) & (P[:, 1] > 9) & (P[:, 2] > 9)
        q = P[m]
        return q[np.lexsort((q[:, 2], q[:, 1], q[:, 0]))]
    cd = corner_pts(P_tri); ca = corner_pts(P_auto)
    # default == triplanar (same vertex count and positions), and both differ
    # from auto in the corner
    assert corner_pts(P_def).shape == cd.shape, "default corner mesh size differs from triplanar"
    assert np.allclose(corner_pts(P_def), cd, atol=1e-9), "default is not triplanar"
    changed = (ca.shape != cd.shape) or (not np.allclose(ca, cd, atol=1e-6))
    assert changed, "triplanar corner is identical to the planar chart, projection had no effect"

    # the flat top: identical across auto vs triplanar (projection inert on a
    # plane). The embossed top rides just above z=40; take the whole band.
    def top_pts(P):
        q = P[P[:, 2] > 39.0]
        return q[np.lexsort((q[:, 1], q[:, 0]))]
    ta, tt = top_pts(P_auto), top_pts(P_tri)
    assert ta.shape == tt.shape and np.allclose(ta, tt, atol=1e-9), \
        "a flat face changed with projection; it must use its exact chart regardless"
    print(PASS, "triplanar is the freeform default (auto restores planar); flat faces are unaffected")


def test_projection_spec_omits_defaults_and_rejects_bad_values():
    """projection and its seam controls hash-neutrally: absent at the default so
    an untouched or older document is unchanged, present only when they bite."""
    base = {"id": "t", "kind": "knurl", "faces": {"by": "all"}, "depth": 0.4, "scale": 2.0}
    d = texture.validate_texture_spec(dict(base))
    assert "projection" not in d and "seamBlend" not in d and "seamBand" not in d, d
    assert texture.validate_texture_spec(dict(base, projection="triplanar")).get("projection") is None
    assert texture.validate_texture_spec(dict(base, projection="auto"))["projection"] == "auto"
    assert texture.validate_texture_spec(dict(base, projection="box"))["projection"] == "box"
    # seam controls ride only with their own mode, and only off the default
    assert "seamBlend" not in texture.validate_texture_spec(dict(base, seamBlend=0.5))
    assert texture.validate_texture_spec(dict(base, seamBlend=0.8))["seamBlend"] == 0.8
    assert "seamBlend" not in texture.validate_texture_spec(dict(base, projection="box", seamBlend=0.8))
    assert texture.validate_texture_spec(dict(base, projection="box", seamBand=0.2))["seamBand"] == 0.2
    try:
        texture.validate_texture_spec(dict(base, projection="cylindrical"))
        raise AssertionError("unknown projection should raise")
    except ValueError:
        pass
    print(PASS, "projection/seam controls omit their defaults and reject a bad mode")


_NEW_KINDS = ["stripes", "grid", "dots", "brick", "basket", "carbon", "isogrid", "grip", "leather"]


def test_new_kinds_stay_in_range_and_respond_to_their_controls():
    """Every added kind is a valid [0,1] field under both profiles, the oriented
    ones actually rotate with angle, and leather follows its seed like the other
    random kinds."""
    rng = np.random.default_rng(1)
    U = rng.uniform(-8, 8, 3000)
    V = rng.uniform(-8, 8, 3000)
    for kind in _NEW_KINDS:
        for profile in ("facet", "round"):
            spec = {"kind": kind, "scale": 2.5, "angle": 20.0, "sharpness": 0.4,
                    "seed": 3, "octaves": 3, "profile": profile}
            h = np.asarray(texture.height_field(kind, spec, U, V), dtype=float)
            assert np.all(np.isfinite(h)), f"{kind}/{profile}: non-finite"
            assert h.min() >= -1e-9 and h.max() <= 1 + 1e-9, f"{kind}/{profile}: {h.min()}..{h.max()}"

    # the oriented kinds move when rotated (a control that did nothing would tie)
    for kind in ("stripes", "grid", "dots", "brick", "basket", "carbon", "isogrid", "grip"):
        s0 = {"kind": kind, "scale": 2.5, "angle": 0.0, "sharpness": 0.4, "profile": "facet"}
        s30 = dict(s0, angle=30.0)
        a = np.asarray(texture.height_field(kind, s0, U, V), float)
        b = np.asarray(texture.height_field(kind, s30, U, V), float)
        assert np.abs(a - b).max() > 1e-3, f"{kind}: angle did not rotate the pattern"

    # leather is seed-driven
    sa = {"kind": "leather", "scale": 3.0, "seed": 1, "octaves": 3, "profile": "round"}
    la = np.asarray(texture.height_field("leather", sa, U, V), float)
    lb = np.asarray(texture.height_field("leather", dict(sa, seed=2), U, V), float)
    assert np.abs(la - lb).max() > 1e-3, "leather ignored its seed"
    print(PASS, f"the {len(_NEW_KINDS)} added kinds stay in [0,1] and honour angle/seed")


def test_new_kinds_mesh_cleanly_on_a_real_face():
    """No added kind may crash, go non-manifold, or produce NaNs when displaced
    onto a real face (the faceted default)."""
    for kind in _NEW_KINDS:
        doc = {"parameters": {}, "features": [
            {"id": "b", "type": "box", "length": 20, "width": 20, "height": 10},
            {"id": "t", "type": "texture", "kind": kind, "depth": 0.3, "scale": 2.5,
             "seed": 3, "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}]}
        _p, errs, bodies = rebuild(doc)
        assert not errs, f"{kind}: {errs}"
        tex = plugin_geometry.resolve(bodies[0])
        assert tex, f"{kind}: did not resolve"
        diag = []
        pos, idx, _ = tessellate(bodies[0]["shape"], 0.05, mesh_passes=tex, diag=diag, normals_out=[])
        assert np.all(np.isfinite(np.asarray(pos, dtype=float))), f"{kind}: non-finite positions"
        assert len(idx) > 0, f"{kind}: no triangles"
        assert not [d for d in diag if "non-manifold" in str(d.get("reason", ""))], f"{kind}: non-manifold"
    print(PASS, "every added kind meshes cleanly, finite and manifold, on a real face")


def test_validate_accepts_the_new_kinds():
    for kind in _NEW_KINDS:
        spec = texture.validate_texture_spec({"kind": kind, "depth": 0.3, "scale": 2.0})
        assert spec["kind"] == kind
    print(PASS, "validate_texture_spec accepts every added kind")


def main():
    print("Surface-texture tests")
    test_validate_texture_spec_rejects_bad_input()
    test_whole_body_knurl_increases_triangles_and_bounds_displacement()
    test_selected_face_only_leaves_other_faces_unchanged()
    test_boundary_taper_to_zero_at_edge()
    test_manifold_check_flags_bad_edge_count()
    test_manifold_diagnostic_surfaces_from_displace_face()
    test_cache_key_changes_with_texture_params()
    test_height_field_kinds_in_zero_one_and_angle_rotates()
    test_height_field_image_bilinear()
    test_texture_selector_survives_downstream_fillet()
    test_texture_targets_bound_body_not_active_in_multibody()
    test_missing_image_is_feature_error_not_crash()
    test_faceted_profile_is_piecewise_planar()
    test_knurl_facet_is_min_of_grooves_not_bilinear_product()
    test_terrace_quantises_into_flat_levels()
    test_trapezoid_land_widens_the_flat_top()
    test_hard_edge_keeps_boundary_pinned_but_full_depth_inside()
    test_faceted_display_splits_creases_but_export_stays_indexed()
    test_every_kind_meshes_cleanly_at_the_faceted_default()
    test_boundary_ring_is_dense_enough_to_carry_the_pattern()
    test_planar_chart_is_orthonormal_tangent_and_metric()
    test_freeform_corner_texture_is_planar_and_finely_resolved()
    test_grime_bleeds_onto_neighbours_and_zero_grime_does_not()
    test_grime_zero_is_absent_from_the_spec()
    test_smooth_low_passes_the_height_field()
    test_smooth_softens_the_displaced_relief()
    test_smooth_zero_is_absent_from_the_spec()
    test_triplanar_keeps_the_pattern_uniform_where_planar_foreshortens()
    test_triplanar_is_the_freeform_default_and_auto_restores_planar()
    test_projection_spec_omits_defaults_and_rejects_bad_values()
    test_new_kinds_stay_in_range_and_respond_to_their_controls()
    test_new_kinds_mesh_cleanly_on_a_real_face()
    test_validate_accepts_the_new_kinds()
    print("ALL PASS")


if __name__ == "__main__":
    main()
