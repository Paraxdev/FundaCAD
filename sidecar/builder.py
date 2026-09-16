"""document -> build123d.

The feature tree is replayed in order, resuming from cached per-feature state
where the prefix is unchanged (rebuild_cache.py). The model is an ordered list of
bodies; most features act on the last one, the "active" body.

build123d quirks (0.11.1, compatible back to 0.10.x):
  - extrude(sketch, amount=...)            free function, algebra mode
  - fillet(edges, radius=...)              radius kwarg
  - chamfer(edges, length=...)             length kwarg (NOT distance)
  - revolve(sketch, axis=..., revolution_arc=...)   degrees, default 360
    (a revolve with a `pitch` climbs instead, and is swept by
    BRepOffsetAPI_MakePipeShell, not by `revolve`, see _screw_revolve)
  - mirror(obj, about=Plane)               about defaults to Plane.XZ
  - loft(sections)                         iterable of sketches/faces
  - split(obj, bisect_by=Plane, keep=Keep.TOP|BOTTOM|BOTH)   cut by a plane
  - Mesher().read(path) -> [Shape]         STL/3MF/OBJ -> watertight solid(s)
  - import_step(path) / import_brep(path)  native B-rep read
  - export_brep(shape, BytesIO)            serialize a body for embedding
  - a + b / a - b / a & b                  union / cut / intersect (algebra mode)
  - Plane.XY * sketch  /  Pos(x,y,z) * shape   placement via * in algebra mode
  - 0.11 makes `.wrapped` a property that ASSERTS on an empty shape (0.10 left
    the attribute simply absent), never touch `.wrapped` directly on a shape
    that might be empty; go through `_wrapped_or_none(shape)` instead, which
    tolerates both AttributeError (0.10) and AssertionError (0.11).
"""

import copy
import os
import sys
import time
import traceback
from collections import ChainMap
from dataclasses import dataclass
from types import SimpleNamespace

import appenv
import body_ids
import font_guard  # noqa: F401  MUST precede build123d, see font_guard.py

from build123d import (
    Box,
    Cylinder,
    Cone,
    Sphere,
    Torus,
    Pos,
    Rot,
    Vector,
    Compound,
    GeomType,
    extrude,
    fillet,
    chamfer,
    mirror,
    loft,
    sweep,
    Transition,
    thicken,
    scale,
)

import face_plane
import geom_select
from errors import BAD_REQUEST, REFERENCE_NOT_FOUND
from geom_select import (
    resolve_edges,
    resolve_faces,
    _face_surface,
    _face_normal,
    _edge_mid,
    _edge_dir,
    _edge_curve,
)
import plugin_geometry
from conic_blend import ConicNotApplicable, PROFILE_EPS, clamp_profile

# Re-exported: tests, server.py and tessellate.py reach these through `builder.`.
import progress
from progress import progress_tick  # noqa: F401

# Mutable hooks and limits (on_feature_tick, MAX_IMPORT_*) are not re-exported:
# rebinding a copy here changes nothing. Patch them where they live.
from mesh_import import (  # noqa: F401
    IMPORT_RSS_PER_FILE_BYTE,
    _canonical_ok,
    _refuse_if_memory_is_short,
    _canonicalize,
    _canonicalize_roots,
    _glb_dominant_color,
    _import_size_cap,
    _peek_triangle_count,
    _read_glb,
    _sew_mesh_file,
    import_geometry,
)
from shape_util import (  # noqa: F401
    MAX_BREP_BYTES,
    _BREP_MAGIC,
    _as_compound,
    _brep_b64_to_shape,
    _drop_debris,
    _explode_solids,
    _list_shapes,
    _loose_children,
    _maybe_unify,
    _refacet_clean,
    _shape_to_blob,
    _shape_to_brep_b64,
    _unify_body,
    _wrap_topods,
    _wrapped_or_none,
)
from plane_spec import (  # noqa: F401
    AXES,
    KEEP,
    PLANES,
    _plane_of,
    _sketch_plane_ref,
)
from sketch_build import (  # noqa: F401
    _POLY_MAX_SEGS,
    _POLY_MIN_SEGS,
    _POLY_MM_PER_SEG,
    _build_sketch,
    _entity_edge,
    _entity_edges,
    _expand_pattern,
    _face_from_wire,
    _faces_from_edges,
    _rect_corners,
    _region_cells,
    _region_face_at,
    _region_target,
    _rotate_entity,
    _subdivide_faces,
    _text_faces,
    _translate_entity,
    list_fonts,
    tessellate_text,
)
from blends import (  # noqa: F401
    SIZE_PROBE_BODY_FRACTION,
    chord_radius,
    native_fillet,
    native_two_distance_chamfer,
    section_fn,
    SIZE_PROBE_FRACTION,
    SMOOTH_EDGE_DEG,
    _blend_edges,
    _blend_failure,
    _blend_failure_message,
    _canonical_blend_key,
    _conic_fillet,
    _edge_dihedral_deg,
    _edge_identity,
    _group_sels_by_body,
    _refuse_folded_blend,
    _refuse_smooth_edges,
    _rematch_edge,
    _report_edge_failures,
    _sequential_blend,
    _size_probe,
    _size_would_help,
)
from booleans import (  # noqa: F401
    _bbox_overlap,
    _bbox_pair_overlap,
    _boolean_into_bodies,
    _do_boolean,
    _do_split,
    _noop_eps,
    _retarget_delete_faces,
    _serial_bool,
    _shape_extent,
    _skip_feature,
    _try_vol,
    _vertex_components,
    bbox_of,
)
from defeature import (  # noqa: F401
    _defeature,
    _expand_blend_chain,
    _face_fp,
    _face_width,
    _fp_world,
    _move_fp,
    _remove_features,
    _shape_face_fps,
    _tool_cut,
    _tool_fill,
    _tool_fill_all,
    _wound_boundary,
)
from rebuild_cache import (  # noqa: F401
    _CACHE,
    _blob_key,
    _body_fingerprint,
    _chain_keys_scoped,
    _disk_store,
    _env_sig,
    _feature_scope,
    _feature_sig,
    _feature_sigs,
    _param_closure,
    _persist_tick,
    _restore_from_disk,
    _save_checkpoint,
)
from solid_ops import (  # noqa: F401
    OFFSETTABLE_CURVED,
    _clamp_cylinder,
    _clamp_planar,
    _distance_to_target,
    _draft,
    _guard_offsetable,
    _imprint,
    _offset_face,
    _offset_faces,
    _pattern_circular,
    _pattern_linear,
    _pattern_rect,
    _press_pull,
    _shell,
    _simplify_mesh,
    _solid_volume,
    _sweep_press_pull,
    _thicken_press_pull,
)
from projection import (  # noqa: F401
    _assign_silhouette,
    _curve_close,
    _curve_close_either,
    _curve_dist,
    _curve_oriented,
    _curve_rep,
    _curve_reversed,
    _project_edge_to_plane,
    _project_pt,
    _project_silhouette,
    _pt_dist,
    _r6,
)
from handler_util import (  # noqa: F401
    _combine,
    _make_val,
    _require_positive,
    _require_sketch,
)
from revolve_feature import (  # noqa: F401
    _axial_scale,
    _handle_revolve,
    _revolve_axis,
    _screw_revolve,
    _turn_clearance,
)
from import_feature import (  # noqa: F401
    _BINTOOLS_MAGIC,
    _assembly_root_index,
    _bind_assembly,
    _blob_to_shape,
    _blob_top_children,
    _handle_import,
    _import_shape,
)
from joints import (  # noqa: F401
    _handle_joint,
    _joint_body_shape,
    _joint_frame,
)
from projection_refresh import (  # noqa: F401
    _fresh_projection,
    _project_source,
    _recompute_projections,
    _require_body,
    _resolve_sketch_curve,
)


@dataclass
class _RebuildCtx:
    """Bundle of the per-rebuild closures/containers a feature handler needs.
    Built ONCE per rebuild() call from the exact same locals the old inline
    if/elif chain closed over (new_body/active/require_active/find_body still
    close over `bodies` and the body ids, bundling them here is just a
    named handle onto that existing state, not new state)."""

    val: object            # resolve a parameter name to its value (or pass a literal through)
    datums: dict            # datumPlane feature id -> PlaneSpec
    sketches: dict          # sketch feature id -> {"sketch":, "faces":, "wire":, ...}
    bodies: list            # ordered [{id, name, shape}], mutated in place by handlers
    diagnostics: object     # optional list; low-confidence selector-v2 resolutions append here
    hidden_bodies: frozenset  # bodies hidden by the document's LIVE visibility map
    new_body: object
    active: object
    require_active: object
    find_body: object
    features: object = None     # the document's feature list (timeline-prefix context for projection sources)
    projections: object = None  # optional list; projection refresh entries append here (like diagnostics)
    # sketch feature id -> the PlaneSpec the build actually used, for sketches
    # that follow a face. Only the ones that MOVED: a sketch still sitting on
    # its cached plane says nothing, and the frontend reads the cache anyway.
    sketch_planes: dict = None
    # datum axis/point feature id -> resolved placement, only for datums that follow geometry
    datum_marks: dict = None

    def stash(self, body, spec):
        """Put a tessellation-time spec on a body, for a PLUGIN's handler.

        A method on the ctx rather than something the plugin imports, so that a
        registered handler needs nothing from this package except the object it
        was handed. See plugin_geometry.stash for why it rebinds the list rather
        than appending to it.
        """
        plugin_geometry.stash(body, spec)


# --- feature handlers ---------------------------------------------------------
# One per feature type. They raise; the rebuild() loop records the error.


def _handle_sketch(f, ctx):
    # Reported back, or reopening the sketch at its stale cache would undo the follow.
    followed = _face_anchor_plane(f, ctx, "Sketch")
    if followed is not None and ctx.sketch_planes is not None:
        ctx.sketch_planes[f["id"]] = followed
    ctx.sketches[f["id"]] = _build_sketch(f, ctx.val, ctx.datums, plane=followed)
    # Associative projection refresh (opt-in, like diagnostics): re-resolve
    # projected entities against the timeline-prefix state we're sitting on
    # right now (ctx.bodies holds exactly the bodies built BEFORE this sketch).
    if ctx.projections is not None:
        _recompute_projections(f, ctx)


def _face_anchor_plane(f, ctx, label):
    """The plane of the face a sketch or datum was made from, re-resolved now, or None
    when the feature names no face. The frozen `plane` is the fallback cache.

    Resolution is global across bodies (see _handle_delete_face). A face that stops
    resolving is not an error: a sketch is a root, and raising would turn everything
    downstream into no-ops. It falls back to the cache with an amber diagnostic.
    """
    sel = f.get("face")
    cached = f.get("plane")
    cached = cached if isinstance(cached, dict) else None
    if not sel or cached is None:
        return None  # nothing to follow, or nothing to judge candidates against
    # getattr: _collect_datums passes a ctx with no bodies, and wants the cache.
    shapes = [b["shape"] for b in (getattr(ctx, "bodies", None) or [])
              if b.get("shape") is not None]
    if not shapes:
        return None
    part = _as_compound(shapes) if len(shapes) > 1 else shapes[0]
    fid = f.get("id")
    at = f.get("at")

    # Held back: the planar resolver calls a cylinder anchor gone before the cylinder arm runs.
    scratch = []
    face = geom_select.resolve_face_on_plane(part, sel, cached["normal"], label,
                                             scratch, fid)
    if face is not None:
        plane = face_plane.plane_from_point_normal(
            _vec3(face.center()), _vec3(_face_normal(face)))
        # The x axis the sketch was DRAWN in, not one re-derived from the new
        # normal: the entities are (u, v) in this basis. See face_plane.with_x_dir.
        plane = face_plane.with_x_dir(plane, cached.get("xdir"))
        return face_plane.agree_with(plane, cached)

    # A cylinder's datum is the tangent plane where it was touched, from the exact surface.
    if at:
        found = _nearest_cylinder_face(part, sel)
        if found is not None:
            try:
                ax = found._geom_adaptor().Cylinder().Axis()
                loc, dr = ax.Location(), ax.Direction()
                plane = face_plane.tangent_plane_on_cylinder(
                    (loc.X(), loc.Y(), loc.Z()), (dr.X(), dr.Y(), dr.Z()),
                    float(found.radius), tuple(at), None)
            except Exception:
                plane = None
            if plane is not None:
                return face_plane.agree_with(plane, cached)

    diag = getattr(ctx, "diagnostics", None)
    if diag is not None:
        diag.extend(scratch)
    return None


def _nearest_cylinder_face(part, sel):
    """The cylindrical face nearest the selector's stored point, or None.

    Plain nearest is right HERE and wrong for a plane, which is why this is a
    separate few lines rather than a flag on the planar resolver. A tangent datum
    is defined BY its touch point, so a cylinder that moved out from under that
    point is genuinely no longer the one that was picked, and picking up whatever
    is nearest instead is the honest answer, not a silent substitution."""
    try:
        pt = Vector(*sel["point"]) if isinstance(sel, dict) and "point" in sel else None
    except Exception:
        pt = None
    best = None
    for face in part.faces():
        if _face_surface(face) != "cylinder":
            continue
        try:
            d = face.distance_to(pt) if pt is not None else 0.0
        except Exception:
            d = 0.0
        if best is None or d < best[0]:
            best = (d, face)
    return best[1] if best else None


def _vec3(v):
    return (v.X, v.Y, v.Z)


def _handle_datum_plane(f, ctx):
    # Registered for sketches and splits to reference; validated here so a bad one flags itself.
    followed = _face_anchor_plane(f, ctx, "Plane")
    base = _plane_of(followed or f["plane"], ctx.datums)
    off = f.get("offset") or 0
    origin = base.origin + base.z_dir * off
    ctx.datums[f["id"]] = {
        "origin": [origin.X, origin.Y, origin.Z],
        "xdir": [base.x_dir.X, base.x_dir.Y, base.x_dir.Z],
        "normal": [base.z_dir.X, base.z_dir.Y, base.z_dir.Z],
    }


def _handle_datum_point(f, ctx):
    # Nothing to build; the handler exists so the type is known rather than "missing plugin".
    f["point"]


def _edge_line(sel, ctx, fid=None):
    """The (origin, dir) tuples of the STRAIGHT model edge a datum or revolve is
    aimed at, re-resolved against the bodies as they stand now, or None when it
    resolves to nothing or to a curve. Resolution is GLOBAL across bodies for the
    reason recorded on _revolve_axis: a body id can come to name a different
    piece, and a body-scoped match would silently re-aim
    at some distant edge on the wrong piece."""
    for b in getattr(ctx, "bodies", None) or []:
        shape = b.get("shape")
        if shape is None:
            continue
        try:
            edges = resolve_edges(shape, sel, getattr(ctx, "diagnostics", None), fid)
        except Exception:
            continue
        for e in edges or []:
            if e is not None and _edge_curve(e) == "line":
                a, d = _edge_mid(e), _edge_dir(e)
                return (a.X, a.Y, a.Z), (d.X, d.Y, d.Z)
    return None


def _handle_datum_axis(f, ctx):
    # An axis anchored to an edge re-resolves it each rebuild; origin/dir are the fallback cache.
    f["origin"], f["dir"]
    sel = f.get("axisEdge")
    if sel and ctx.datum_marks is not None:
        line = _edge_line(sel, ctx, f.get("id"))
        if line is not None:
            (ox, oy, oz), (dx, dy, dz) = line
            ctx.datum_marks[f["id"]] = {
                "kind": "axis", "origin": [ox, oy, oz], "dir": [dx, dy, dz],
            }


def _handle_extrude(f, ctx):
    entry = _require_sketch(ctx, f.get("sketch"), "extrude")
    sk = entry["sketch"]
    if sk is None:
        raise ValueError("sketch has no closed profile to extrude")
    # A zero-distance extrude sweeps nothing; OCCT reports it as
    # Standard_ConstructionError. Negative IS meaningful (extrude the other way).
    if ctx.val(f["distance"]) == 0:
        raise ValueError("Extrude: distance must not be 0")
    # `symmetric` goes `distance` each way, so the sign no longer matters.
    both = bool(f.get("symmetric"))
    # region points (one per selected area) pick + combine specific
    # profiles; a ring (annulus) keeps its hole, several areas union.
    pts = f.get("regions")
    if not pts and f.get("region"):
        pts = [f["region"]]
    target = _region_target(pts, entry, ctx)
    if target is None:
        target = sk  # nothing selected: the whole sketch
    # `taper` degrees: positive narrows toward the far end. 0 keeps the plain path.
    taper = ctx.val(f["taper"]) if f.get("taper") is not None else 0.0
    if taper and not (-89 < taper < 89):
        # At or past vertical a wall folds through itself; OCCT hands back a
        # self-intersecting solid. Name it rather than let the kernel raise a
        # bare Standard_ConstructionError against the wrong feature.
        raise ValueError(f"Extrude: taper must be between -89 and 89 degrees (got {taper:g})")
    solid = (
        extrude(target, amount=ctx.val(f["distance"]), both=both, taper=taper)
        if taper
        else extrude(target, amount=ctx.val(f["distance"]), both=both)
    )
    # `hiddenBodies` is captured at creation; a legacy extrude without it reads the live map.
    hid = (
        frozenset(f["hiddenBodies"])
        if "hiddenBodies" in f
        else ctx.hidden_bodies
    )
    _combine(f, ctx, solid, hidden=hid)


def _handle_fillet(f, ctx):
    r = ctx.val(f["radius"])
    # `profile`: -1 chamfer, 0 circular (the plain path), +1 sharp.
    p = clamp_profile(ctx.val(f["profile"])) if f.get("profile") is not None else 0.0
    g2 = f.get("continuity") == "G2"
    chord = f.get("sizeType") == "chord"
    # OCCT rounds on along every tangent-continuous neighbour; only the section
    # blend can stop at the picked edges.
    only_picked = f.get("tangentEdges") is False

    def radii(shape, es, size=r):
        return [chord_radius(shape, e, size) if chord else size for e in es]

    section = section_fn("fillet", r, continuity="G2" if g2 else "G1",
                         sizes_of=radii if chord else None)

    def plain():
        _blend_edges(f, ctx, "Fillet",
                     lambda s, es: native_fillet(s, es, radii(s, es)),
                     lambda s, e, size: native_fillet(s, [e], radii(s, [e], size)), r,
                     section=section, section_only=g2 or only_picked)

    if g2 or only_picked or abs(p) < PROFILE_EPS:
        plain()
        return
    try:
        _blend_edges(f, ctx, "Fillet",
                     lambda s, es: _conic_fillet(s, es, r, p),
                     lambda s, e, size: _conic_fillet(s, [e], size, p), r)
    except ConicNotApplicable:
        # The reweight gave up (often where three rounds meet), not the rounding: fall back
        # to circular with a warning. _blend_edges assigns nothing until all succeed.
        plain()
        _note_profile_fallback(ctx, f)


def _note_profile_fallback(ctx, f):
    """Amber advisory (not a red failure) that a variable-profile fillet rounded
    with the plain circular section because the profile could not be carried
    here. Shares featureNotes' one-reason-per-chip channel with selector
    diagnostics; no `at` and no repairable `code`, so it lights the chip and its
    tooltip without offering a re-pick that would make no sense."""
    if ctx.diagnostics is None:
        return
    ctx.diagnostics.append({
        "feature_id": f.get("id"),
        "kind": "edge",
        "resolved": 1,
        "confidence": 1.0,
        "lossy": False,
        "reason": "the variable profile can't wrap this junction, so the fillet "
                  "used its plain rounded section here",
    })


def _handle_chamfer(f, ctx):
    d = ctx.val(f["distance"])
    d2 = ctx.val(f["distance2"]) if f.get("chamferType") == "twoDistance" and f.get("distance2") is not None else None

    def native(s, es, size=d):
        if d2 is None:
            return chamfer(es, length=size)
        return native_two_distance_chamfer(s, es, size, d2 * size / d)

    _blend_edges(f, ctx, "Chamfer",
                 native,
                 lambda s, e, size: native(s, [e], size), d,
                 section=section_fn("chamfer", d, d2),
                 section_only=f.get("tangentEdges") is False)


def _handle_press_pull(f, ctx):
    # target the body that OWNS the picked face (sent by the tool),
    # not just the active body, so press/pull on a multi-body model
    # modifies the right body.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Press/Pull")
    if act is None:
        raise ValueError("Press/Pull: the target body no longer exists")
    # Re-resolved against the evolving shape: each push renumbers topology.
    sels = f["face"] if isinstance(f["face"], list) else [f["face"]]
    # `upTo`: extrude each face UP TO a target surface instead of by a
    # fixed distance. Capture the target plane once (point + normal) so
    # every source face extrudes to the same surface.
    up = f.get("upTo")
    tgt_pt = tgt_n = None
    if up:
        # Point picks resolve GLOBALLY: the target only contributes
        # a PLANE, so "extrude until it meets that other part" is
        # legitimate, the user may aim at a face of ANY body.
        tf = None
        pt = (
            up.get("point")
            if isinstance(up, dict) and up.get("by") == "nearest"
            else None
        )
        if pt is not None:
            p = Vector(*pt)
            best = None
            for b in ctx.bodies:
                if b.get("shape") is None:
                    continue
                for fc in _as_compound(b["shape"]).faces():
                    dd_ = fc.distance_to(p)
                    if best is None or dd_ < best[0]:
                        best = (dd_, fc)
            if best is not None:
                tf = [best[1]]
        if tf is None:
            tf = resolve_faces(act["shape"], up, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not tf:
            raise ValueError("Press/Pull: the 'up to' target surface wasn't found")
        tgt_pt, tgt_n = tf[0].center(), tf[0].normal_at()
    dist = ctx.val(f["distance"])
    # Fixed distances only: a tapered up-to push would miss its target surface.
    taper = ctx.val(f["taper"]) if f.get("taper") is not None else 0.0
    if taper and not (-89 < taper < 89):
        raise ValueError(f"Press/Pull: taper must be between -89 and 89 degrees (got {taper:g})")
    # `mode` other than auto extrudes the face straight out, curved or not, and
    # hands the prism to the same boolean an extrude uses, so it can join or cut
    # any body it runs into, or stand as a new one.
    mode = f.get("mode") or "auto"
    for sel in sels:
        if mode != "auto" and f.get("body"):
            act = ctx.find_body(f["body"]) or act
        found = resolve_faces(act["shape"], sel, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not found:
            raise ValueError("no face found to press/pull")
        src = found[0]
        d = _distance_to_target(src, tgt_pt, tgt_n) if up else dist
        if mode != "auto":
            if abs(d) < 1e-9:
                continue
            prism = _face_prism(src, d, 0.0 if up else taper)
            _combine({"id": f.get("id"), "operation": mode, "targets": f.get("targets")}, ctx, prism)
            continue
        act["shape"] = _press_pull(act["shape"], src, d, clamp=False, taper=(0.0 if up else taper))


def _face_prism(face, d, taper=0.0):
    """The solid a face sweeps out moving `d` along its normal: a tapered extrude
    for a flat face, a straight prism along the normal at its centre otherwise."""
    if face.geom_type == GeomType.PLANE:
        return extrude(face, d, taper=taper) if taper else extrude(face, d)
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
    from OCP.gp import gp_Vec

    n = face.normal_at(face.center())
    mk = BRepPrimAPI_MakePrism(face.wrapped, gp_Vec(n.X * d, n.Y * d, n.Z * d))
    mk.Build()
    out = _wrap_topods(mk.Shape()) if mk.IsDone() else None
    if out is None or not BRepCheck_Analyzer(mk.Shape()).IsValid():
        raise ValueError("Press/Pull: this face does not extrude into a valid solid")
    return out


def _handle_delete_face(f, ctx):
    # Nearest picks resolve across all bodies, since a body id can come to name another
    # piece; a win on a different body re-targets there with a diagnostic.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Delete Face")
    sels = f["face"] if isinstance(f["face"], list) else [f["face"]]
    act, faces = _retarget_delete_faces(
        act, ctx.bodies, sels, ctx.diagnostics, f.get("id")
    )
    if act is None:
        raise ValueError("Delete Face: the target body no longer exists")
    if not faces:
        raise ValueError("no face found to delete")
    act["shape"] = _defeature(act["shape"], faces)


def _handle_clean_up(f, ctx):
    # Refacet first, then unify: fusing raw sliver-ridden solids collapses to garbage.
    # Best effort; an uncertain body is left unchanged.
    targets = (
        [ctx.find_body(f["body"])] if f.get("body") else list(ctx.bodies)
    )
    for tb in targets:
        if tb is not None and tb.get("shape") is not None:
            tb["shape"] = _unify_body(
                _refacet_clean(
                    tb["shape"], tol=ctx.val(f.get("tolerance", 0.12))
                )
            )
        elif f.get("body"):
            # named body no longer exists (upstream removal/split
            # renumbered it), a legitimate no-op, not a hard error
            _skip_feature(ctx.diagnostics, f, "cleanUp", "target body already consumed or missing")


def _handle_mirror(f, ctx):
    act = ctx.require_active("Mirror")
    act["shape"] = act["shape"] + mirror(act["shape"], about=_plane_of(f["plane"], ctx.datums))


def _handle_loft(f, ctx):
    # Regions as faces keep a ring's hole; the legacy `sketches` path lofts whole profiles.
    profs = f.get("profiles")
    if profs:
        sections = []
        for pr in profs:
            entry = ctx.sketches.get(pr["sketch"])
            if entry is None or not entry.get("faces"):
                raise ValueError("a loft profile's sketch has no closed area")
            cells = _region_cells(entry, ctx)
            rf = _region_face_at(cells, Vector(*pr["region"]))
            if rf is None:
                raise ValueError("no profile found under a selected loft area")
            sections.append(rf)
    else:
        sections = [_require_sketch(ctx, s, "loft")["sketch"] for s in f.get("sketches", [])]
        sections = [s for s in sections if s is not None]
    if len(sections) < 2:
        raise ValueError("loft needs at least two profiles")
    try:
        solid = loft(sections)
    except Exception as ex:
        # OCCT reports "blend these two profiles" failures as a bare
        # StdFail_NotDone. The usual causes are profiles that are identical and
        # coincident (nothing to sweep between) or wildly mismatched.
        raise ValueError(
            "Loft failed to blend these profiles, they may be coincident, "
            f"identical, or too dissimilar to connect. [{type(ex).__name__}]"
        )
    _combine(f, ctx, solid)


def _handle_sweep(f, ctx):
    prof = _require_sketch(ctx, f.get("profile"), "sweep")["sketch"]
    if prof is None:
        raise ValueError("sweep profile has no closed section")
    path = _require_sketch(ctx, f.get("path"), "sweep").get("wire")
    if path is None:
        raise ValueError("sweep path sketch has no curve to follow")
    # RIGHT, not TRANSFORMED: on a sharp corner TRANSFORMED silently sweeps only the first leg.
    solid = sweep(sections=prof, path=path, transition=Transition.RIGHT)
    _combine(f, ctx, solid)


# Primitives go through `_combine` so `operation` and `targets` apply to them too.
def _handle_box(f, ctx):
    l, w, h = ctx.val(f["length"]), ctx.val(f["width"]), ctx.val(f["height"])
    _require_positive("Box", length=l, width=w, height=h)
    _combine(f, ctx, Box(l, w, h), name="Box")


def _handle_cylinder(f, ctx):
    r, h = ctx.val(f["radius"]), ctx.val(f["height"])
    _require_positive("Cylinder", radius=r, height=h)
    _combine(f, ctx, Cylinder(r, h), name="Cylinder")


def _handle_sphere(f, ctx):
    r = ctx.val(f["radius"])
    _require_positive("Sphere", radius=r)
    _combine(f, ctx, Sphere(r), name="Sphere")


def _handle_cone(f, ctx):
    # A cone tapers `bottomRadius` to `topRadius` over `height`. topRadius 0 is a
    # true point-tipped cone, a positive one is a frustum; both are what the
    # taper-extrude reaches in more steps, so the primitive is the shortcut.
    rb, rt, h = ctx.val(f["bottomRadius"]), ctx.val(f["topRadius"]), ctx.val(f["height"])
    _require_positive("Cone", height=h)
    if rb < 0 or rt < 0:
        raise ValueError("Cone: radii must not be negative")
    if rb == rt:
        # Equal radii is a cylinder, not a cone; OCCT builds a zero-slant frustum
        # that meshes as debris. Name it rather than ship the sliver.
        raise ValueError("Cone: the two radii must differ (equal radii is a cylinder)")
    if rb <= 0 and rt <= 0:
        raise ValueError("Cone: at least one radius must be greater than 0")
    _combine(f, ctx, Cone(rb, rt, h), name="Cone")


def _handle_torus(f, ctx):
    # A tube wider than the ring self-intersects, which OCCT reports unhelpfully.
    big, small = ctx.val(f["majorRadius"]), ctx.val(f["minorRadius"])
    _require_positive("Torus", majorRadius=big, minorRadius=small)
    if small >= big:
        raise ValueError("Torus: the tube radius must be smaller than the ring radius")
    _combine(f, ctx, Torus(big, small), name="Torus")


def _handle_shell(f, ctx):
    # Shells the body each opening face belongs to; no faces hollows the active body closed.
    t = ctx.val(f["thickness"])
    # A zero wall is not a shell; OCCT reports it as a bare RuntimeError. A
    # NEGATIVE thickness is legitimate (it shells outward) and is left alone.
    if t == 0:
        raise ValueError("Shell: thickness must not be 0")
    if not f.get("faces"):
        act = ctx.require_active("Shell")
        act["shape"] = _shell(act["shape"], t, [])
        return
    staged = []
    for body, sels in _group_sels_by_body(f["faces"], ctx, "Shell"):
        openings = resolve_faces(body["shape"], sels, diag=ctx.diagnostics, feature_id=f.get("id"))
        staged.append((body, _shell(body["shape"], t, openings)))
    for body, shape in staged:
        body["shape"] = shape


def _handle_offset_face(f, ctx):
    # The body that owns the faces, not the active body.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Offset face")
    if act is None:
        raise ValueError("Offset face: the target body no longer exists")
    faces = resolve_faces(act["shape"], f["faces"], diag=ctx.diagnostics, feature_id=f.get("id"))
    if not faces:
        raise ValueError("no face found to offset")
    _guard_offsetable(act["shape"], faces, "Offset face")
    d = ctx.val(f["distance"])
    # Offsetting by zero moves nothing, but used to report success, the same
    # silent no-op class as revolve angle:0 and pattern count:0.
    if d == 0:
        raise ValueError("Offset face: distance must not be 0")
    # clamp per face by its own kind: a cylinder can't collapse past its radius,
    # a planar face can't be pushed through the body
    pairs = [
        (fc, _clamp_cylinder(fc, d) if fc.geom_type == GeomType.CYLINDER else _clamp_planar(act["shape"], fc, d))
        for fc in faces
    ]
    try:
        act["shape"] = _offset_faces(act["shape"], pairs)
        return
    except Exception:
        pass
    # One BRepOffset pass refuses every face if it fails, so retry face by face,
    # re-resolving against the evolving shape.
    shape = act["shape"]
    for sel in (f["faces"] if isinstance(f["faces"], list) else [f["faces"]]):
        for fc in resolve_faces(shape, sel, diag=ctx.diagnostics, feature_id=f.get("id")):
            shape = _press_pull(shape, fc, d)
    act["shape"] = shape


def _handle_thicken(f, ctx):
    # Thicken: give surface geometry a wall. The input is either the faces of a
    # solid or a whole SURFACE body (a non-watertight mesh import, which is
    # read-only reference geometry until thickened).
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Thicken")
    if act is None:
        raise ValueError("Thicken: the target body no longer exists")
    sel = f.get("faces")
    faces = (
        resolve_faces(act["shape"], sel, diag=ctx.diagnostics, feature_id=f.get("id"))
        if sel
        else list(_as_compound(act["shape"]).faces())
    )
    if not faces:
        raise ValueError("no face found to thicken")
    _guard_offsetable(act["shape"], faces, "Thicken")
    t = ctx.val(f["thickness"])
    if abs(t) < 1e-9:
        raise ValueError("Thicken: the thickness is zero")
    solid = thicken(faces, amount=t, both=bool(f.get("symmetric")))
    # Default "new": a thickened surface body is its own body. "join" merges it
    # into the solids it touches (thickening a face of an existing part).
    _combine(f, ctx, solid)


def _handle_draft(f, ctx):
    # Taper each body that owns a selected face. Staged like fillet/chamfer so a
    # failure on one body can't leave another already drafted.
    angle = ctx.val(f["angle"])
    axis = f.get("axis", "Z")
    # A 90-degree taper folds the face flat onto itself; OCCT reports it as
    # Standard_ConstructionError. Anything at or beyond vertical is degenerate.
    if not (-90 < angle < 90):
        raise ValueError(
            f"Draft: angle must be between -90 and 90 degrees (got {angle:g})"
        )
    staged = []
    for body, sels in _group_sels_by_body(f["faces"], ctx, "Draft"):
        faces = resolve_faces(body["shape"], sels, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not faces:
            raise ValueError(f"no face found to draft on {body['name']}")
        staged.append((body, _draft(body["shape"], faces, angle, axis)))
    for body, shape in staged:
        body["shape"] = shape


def _handle_pattern_rect(f, ctx):
    act = ctx.require_active("Pattern")
    cx, cy = ctx.val(f["countX"]), ctx.val(f["countY"])
    # A count of 0 used to return the original body with no error at all, so the
    # pattern silently did nothing and the timeline showed a healthy feature.
    _require_positive("Pattern", countX=cx, countY=cy)
    act["shape"] = _pattern_rect(
        act["shape"], cx, cy, ctx.val(f["spacingX"]), ctx.val(f["spacingY"])
    )


def _pattern_targets(f, ctx, label):
    """The bodies a pattern acts on: the listed ones, or the active body.

    Mirrors _handle_move. A stale id is a no-op with a diagnostic, not a hard
    error, an upstream split or removal renumbers bodies, and a pattern that
    refuses to build at all because one of its three targets went away takes the
    other two down with it."""
    ids = f.get("bodies")
    if not ids:
        return [ctx.require_active(label)]
    out = []
    for bid in ids:
        tgt = ctx.find_body(bid)
        if tgt is None:
            _skip_feature(ctx.diagnostics, f, f["type"], "target body already consumed or missing")
            continue
        out.append(tgt)
    return out


def _handle_pattern_linear(f, ctx):
    n = ctx.val(f["count"])
    _require_positive("Pattern", count=n)
    spacing = ctx.val(f.get("spacing", 0))
    axis = f.get("axis", "X")
    for tgt in _pattern_targets(f, ctx, "Pattern"):
        tgt["shape"] = _pattern_linear(tgt["shape"], n, spacing, axis)


def _handle_pattern_circular(f, ctx):
    n = ctx.val(f["count"])
    _require_positive("Pattern", count=n)
    angle = ctx.val(f.get("angle", 360))
    axis = f.get("axis", "Z")
    for tgt in _pattern_targets(f, ctx, "Pattern"):
        tgt["shape"] = _pattern_circular(tgt["shape"], n, angle, axis)


def _handle_simplify_mesh(f, ctx):
    act = ctx.require_active("Simplify Mesh")
    act["shape"] = _simplify_mesh(act["shape"], ctx.val(f.get("tolerance", 1)))


def _handle_scale(f, ctx):
    """Resize bodies by `factor`, or per axis with `sx`/`sy`/`sz`, holding `about` still.
    Without `about`, build123d scales about each body's own location."""
    from OCP.BRepTools import BRepTools

    ids = f.get("bodies")
    targets = [ctx.find_body(b) for b in ids] if ids else [ctx.require_active("Scale")]
    factor = ctx.val(f.get("factor", 1))
    axes = tuple(
        ctx.val(f[k]) if f.get(k) is not None else factor for k in ("sx", "sy", "sz")
    )
    # A factor of 0 collapses the solid, to a point uniformly, to a flat sheet
    # on one axis; OCCT reports either as Standard_ConstructionError. Negative
    # factors DO work (a mirror through the point) and are left alone.
    for name, v in zip(("factor", "sx", "sy", "sz"), (factor,) + axes):
        if v == 0:
            raise ValueError(
                f"Scale: {name} must not be 0, it would collapse the body flat"
            )
    about = f.get("about")
    by = factor if axes == (factor, factor, factor) else axes
    for tgt in targets:
        if tgt is None:
            # stale id (an upstream body removal renumbered it), a legitimate
            # no-op, the same way move treats one, not a hard error
            _skip_feature(ctx.diagnostics, f, "scale", "target body already consumed or missing")
            continue
        kw = {"about": Vector(*about)} if about else {}
        out = scale(tgt["shape"], by=by, **kw)
        # GTransform keeps the old triangulation attached to the new geometry, and
        # everything downstream reads the mesh, so drop it on every path.
        if out.wrapped is not None:
            BRepTools.Clean_s(out.wrapped)
        tgt["shape"] = out


def _handle_move(f, ctx):
    rx, ry, rz = ctx.val(f.get("rx", 0)), ctx.val(f.get("ry", 0)), ctx.val(f.get("rz", 0))
    dx, dy, dz = ctx.val(f.get("dx", 0)), ctx.val(f.get("dy", 0)), ctx.val(f.get("dz", 0))
    ids = f.get("bodies")
    targets = [ctx.find_body(b) for b in ids] if ids else [ctx.require_active("Move")]
    for tgt in targets:
        if tgt is None:
            # stale id (upstream body removal/split renumbered it),
            # a legitimate no-op, not a hard error
            _skip_feature(ctx.diagnostics, f, "move", "target body already consumed or missing")
            continue
        sh = tgt["shape"]
        # A disjoint body is a build123d ShapeList (no single `.wrapped`);
        # Rot/Pos (Location.__mul__) only accept ONE Shape, so normalize to
        # a Compound first, else "other must be a list of Locations".
        if sh is not None and _wrapped_or_none(sh) is None:
            sh = Compound(list(sh))
        if rx or ry or rz:
            sh = Rot(rx, ry, rz) * sh
        if dx or dy or dz:
            sh = Pos(dx, dy, dz) * sh
        tgt["shape"] = sh


def _handle_duplicate(f, ctx):
    """Copy one or more bodies and place the copies with an optional transform.

    Like move, but the originals stay put and each copy becomes a new body.
    A ZERO transform still yields a genuinely independent body: the shape is
    deep-copied first (build123d 0.11.1 has no Shape.copy, copy.deepcopy clones
    the underlying OCCT topology), so a later feature that edits the original,
    or the copy, cannot reach through a shared reference into the other."""
    rx, ry, rz = ctx.val(f.get("rx", 0)), ctx.val(f.get("ry", 0)), ctx.val(f.get("rz", 0))
    dx, dy, dz = ctx.val(f.get("dx", 0)), ctx.val(f.get("dy", 0)), ctx.val(f.get("dz", 0))
    ids = f.get("bodies")
    targets = [ctx.find_body(b) for b in ids] if ids else [ctx.require_active("Duplicate")]
    for tgt in targets:
        if tgt is None:
            # stale id (upstream body removal/split renumbered it),
            # a legitimate no-op, not a hard error
            _skip_feature(ctx.diagnostics, f, "duplicate", "target body already consumed or missing")
            continue
        sh = copy.deepcopy(tgt["shape"])
        # A disjoint body is a build123d ShapeList (no single `.wrapped`);
        # Rot/Pos (Location.__mul__) only accept ONE Shape, so normalize to
        # a Compound first, else "other must be a list of Locations".
        if sh is not None and _wrapped_or_none(sh) is None:
            sh = Compound(list(sh))
        if rx or ry or rz:
            sh = Rot(rx, ry, rz) * sh
        if dx or dy or dz:
            sh = Pos(dx, dy, dz) * sh
        ctx.new_body(sh, f"{tgt['name']} copy")


def _sketch_face_selector(f, ctx):
    """The face selector of the sketch a Divide feature consumes, or None. A Divide
    inherits its target face from the sketch it is drawn on, so the sketch's own
    `face` reference is what says which body's face to split."""
    sid = f.get("sketch")
    for sf in (ctx.features or []):
        if sf.get("id") == sid:
            return sf.get("face")
    return None


def _imprint_target(f, ctx):
    """The body a Divide splits: an explicit `body` if the feature records one,
    else the body that owns the sketch's anchor face, else the active body.

    Resolving the owner from the sketch's face selector (rather than trusting a
    stored id) keeps the Divide following the same face its sketch follows, so an
    upstream edit that renumbers bodies can't silently re-aim it at the wrong
    piece, the reason recorded on _face_anchor_plane."""
    if f.get("body"):
        return ctx.find_body(f["body"])
    sel = _sketch_face_selector(f, ctx)
    if sel is not None:
        for b in ctx.bodies:
            if b.get("shape") is None:
                continue
            try:
                found = resolve_faces(b["shape"], sel, diag=None, feature_id=f.get("id"))
            except Exception:
                found = None
            if found:
                return b
    return ctx.require_active("Divide")


def _handle_imprint(f, ctx):
    # Curves that divide nothing leave the face whole: an advisory, not a failure.
    entry = _require_sketch(ctx, f.get("sketch"), "divide")
    edges = entry.get("edges") or []
    if not edges:
        _skip_feature(ctx.diagnostics, f, "imprint",
                      "this sketch has no curves to divide a face with")
        return
    act = _imprint_target(f, ctx)
    if act is None or act.get("shape") is None:
        raise ValueError("Divide: the face to split is no longer in the model")
    before = len(_as_compound(act["shape"]).faces())
    act["shape"] = _imprint(act["shape"], edges)
    after = len(_as_compound(act["shape"]).faces())
    if after <= before:
        _skip_feature(ctx.diagnostics, f, "imprint",
                      "these curves don't divide the face, extend them across it "
                      "to its edges")


def _handle_split(f, ctx):
    _do_split(f, ctx.bodies, ctx.find_body, ctx.active, ctx.new_body, ctx.datums)


def _handle_boolean(f, ctx):
    _do_boolean(f, ctx.bodies, ctx.find_body, diag=ctx.diagnostics)


def _handle_remove_body(f, ctx):
    # delete bodies by id (mainstream MCAD "Remove"); drop them from the list so
    # they're not tessellated/exported.
    ids = set(f.get("bodies") or [])
    missing = sorted(ids - {b["id"] for b in ctx.bodies})
    if missing:
        raise ValueError(
            f"Remove: no such body {', '.join(missing)}, it may have been "
            "renumbered or consumed by an earlier feature"
        )
    ctx.bodies[:] = [b for b in ctx.bodies if b["id"] not in ids]


# The core's feature types. Plugins register theirs through plugin_geometry.
_FEATURE_HANDLERS = {
    "sketch": _handle_sketch,
    "datumPlane": _handle_datum_plane,
    "datumPoint": _handle_datum_point,
    "datumAxis": _handle_datum_axis,
    "extrude": _handle_extrude,
    "fillet": _handle_fillet,
    "chamfer": _handle_chamfer,
    "press-pull": _handle_press_pull,
    "deleteFace": _handle_delete_face,
    "cleanUp": _handle_clean_up,
    "mirror": _handle_mirror,
    "revolve": _handle_revolve,
    "loft": _handle_loft,
    "sweep": _handle_sweep,
    "import": _handle_import,
    "box": _handle_box,
    "cylinder": _handle_cylinder,
    "cone": _handle_cone,
    "sphere": _handle_sphere,
    "torus": _handle_torus,
    "shell": _handle_shell,
    "offsetFace": _handle_offset_face,
    "thicken": _handle_thicken,
    "draft": _handle_draft,
    "patternRect": _handle_pattern_rect,
    "patternLinear": _handle_pattern_linear,
    "patternCircular": _handle_pattern_circular,
    "simplifyMesh": _handle_simplify_mesh,
    "scale": _handle_scale,
    "move": _handle_move,
    "duplicate": _handle_duplicate,
    "joint": _handle_joint,
    "split": _handle_split,
    "imprint": _handle_imprint,
    "boolean": _handle_boolean,
    "removeBody": _handle_remove_body,
}


class _Inactive(Exception):
    """Leaves the handler unrun without touching the error arms below it."""


def _is_inactive(f, val):
    """True when the feature's `activeWhen` resolves to 0, so the build leaves it
    out exactly as if it were suppressed. Absent means always built.

    NaN is refused rather than read as off: a broken expression must never
    quietly remove geometry, it has to turn the row red."""
    cond = f.get("activeWhen")
    if cond is None:
        return False
    v = val(cond)
    if not isinstance(v, (int, float)) or v != v:
        raise ValueError(f"activeWhen must resolve to a number (got {v!r})")
    return v == 0


def _references_any(node, ids):
    """The first of `ids` that appears as a string value anywhere inside a
    feature, which is how a sketch, datum or body reference is spelled."""
    if isinstance(node, str):
        return node if node in ids else None
    if isinstance(node, dict):
        items = (v for k, v in node.items() if k != "id")
    elif isinstance(node, list):
        items = iter(node)
    else:
        return None
    for v in items:
        hit = _references_any(v, ids)
        if hit:
            return hit
    return None


def _switched_off_owner(message, recorded, inactive):
    """The switched off feature that made a body the message names, if any."""
    import re
    for bid in re.findall(r"\bbody\d+\b", message):
        for key, got in recorded.items():
            if got == bid:
                fid = re.sub(r"(:\d+#?|/[^/]*)$", "", key)
                if fid in inactive:
                    return fid
    return None


def rebuild(document, diagnostics=None, resume=None, snapshots_out=None, persist=None,
            projections=None, datums_out=None, sketch_planes_out=None,
            datum_marks_out=None, body_ids_out=None):
    """Return (part, errors, bodies).

    part    : the merged shape of all bodies, or None.
    errors  : [{feature_id, message}]; a failing feature is a no-op and the build continues.
    bodies  : [{id, name, shape}], one per live body.

    Optional outputs, each filled when passed: `diagnostics` (low-confidence selector
    matches), `datums_out` and `sketch_planes_out` (where face-following datums and
    sketches landed, only moved sketches), `datum_marks_out`, `body_ids_out` (the
    document's id map after this build), and `projections` (refresh entries, none in
    the steady state, which is what ends the frontend's refresh loop).

    `resume=(start, snapshot)` restores the state after feature start-1; `snapshots_out`
    collects one snapshot per feature. Snapshots share OCCT shapes and are restored by
    mutating the containers in place, so the closures below stay bound to them.
    """
    params = document.get("parameters", {})
    # Bodies the user has hidden, excluded from extrude booleans (never edit a
    # hidden body). Ids are deterministic, so they line up with the frontend's visibility map for this same document.
    hidden_bodies = frozenset(
        bid for bid, vis in (document.get("bodyVisibility") or {}).items() if not vis
    )
    ids = body_ids.BodyIds(document.get("bodyIds"))

    val = _make_val(params)

    sketches = {}
    datums = {}  # datumPlane feature id -> PlaneSpec (resolved lazily by _plane_of)
    sketch_planes = {}  # sketch feature id -> the face-followed PlaneSpec it used
    datum_marks = {}  # datum axis/point feature id -> resolved {kind, origin, dir} (followed only)
    bodies = []  # ordered [{id, name, shape}]
    errors = []

    def new_body(shape, name=None, node_ref=None, face_colors=None, part_color=None,
                 inherit=None):
        bid = ids.assign(ids.key(node_ref), inherit)
        entry = {
            "id": bid,
            "name": name or f"Body{body_ids.number(bid)}",
            "shape": shape,
        }
        # Which assembly-tree node this body came from, as "<featureId>/<index>".
        # Set only for manifest-bound imports, and omitted (not None) otherwise so
        # every other body dict is byte-identical to what it was before.
        if node_ref:
            entry["node_ref"] = node_ref
        # Still packed (face_colors.py); only the renderer unpacks them.
        if face_colors:
            entry["face_colors"] = face_colors
        # The colour the file styled on this body's solid (step_assembly.py).
        if part_color:
            entry["part_color"] = part_color
        bodies.append(entry)
        return bodies[-1]

    def active():
        return bodies[-1] if bodies else None

    def require_active(label):
        """The active body, or a clear error, for features that modify an
        existing body (fillet, shell, pattern, …) rather than create one."""
        if not bodies:
            raise ValueError(f"{label} needs an existing body")
        return bodies[-1]

    def find_body(bid):
        for b in bodies:
            if b["id"] == bid:
                return b
        return None

    def _snapshot():
        """Capture the build state after a feature. Body dicts are copied (so later
        in-place mutation `b["shape"]=…` can't corrupt the snapshot) but SHARE the
        OCCT shape refs, no geometry is copied. sketches/errors/diagnostics are
        APPEND-ONLY write-once registries within a run, so a snapshot stores a
        REFERENCE to the run's registry plus a high-water mark; _restore copies the
        prefix below the mark once. Copying whole registries per snapshot was O(N²)
        over a rebuild."""
        return {
            "bodies": [dict(b) for b in bodies],
            "sketches_ref": sketches, "n_sketches": len(sketches),
            "datums": {k: dict(v) for k, v in datums.items()},
            # A disk resume replays sketches with no bodies to resolve a face against.
            "sketch_planes": {k: dict(v) for k, v in sketch_planes.items()},
            "datum_marks": {k: dict(v) for k, v in datum_marks.items()},
            "ids_ref": ids.events, "n_ids": ids.mark(),
            # errors travel with the snapshot: an incremental resume PAST a failed
            # feature must still re-report its error (else the banner would clear
            # while the feature is still broken)
            "errors_ref": errors, "n_errors": len(errors),
            # "Re-pick face" is offered only when the ambiguity diagnostic comes back too.
            "diags_ref": diagnostics, "n_diags": len(diagnostics or ()),
        }

    def _restore(snap):
        """Restore a snapshot by mutating the state containers IN PLACE (never
        rebinding) so the closures above keep working."""
        bodies[:] = [dict(b) for b in snap["bodies"]]
        sk_src = snap["sketches_ref"]
        if sk_src is not sketches:
            sketches.clear()
            for k in list(sk_src.keys())[: snap["n_sketches"]]:
                sketches[k] = sk_src[k]
        else:
            for k in list(sketches.keys())[snap["n_sketches"]:]:
                del sketches[k]
        datums.clear(); datums.update({k: dict(v) for k, v in snap["datums"].items()})
        # .get: a checkpoint written before sketches followed faces has no such
        # key, and degrades to the old behaviour rather than raising.
        sketch_planes.clear()
        sketch_planes.update({k: dict(v) for k, v in (snap.get("sketch_planes") or {}).items()})
        # .get for the same reason as sketch_planes: a disk checkpoint (whose
        # _save_checkpoint predates this) reconstructs a snapshot without the
        # key, and degrades to the baked fallback rather than raising.
        datum_marks.clear()
        datum_marks.update({k: dict(v) for k, v in (snap.get("datum_marks") or {}).items()})
        err_src = snap["errors_ref"]
        if err_src is not errors:
            errors[:] = [dict(e) for e in err_src[: snap["n_errors"]]]
        else:
            del errors[snap["n_errors"]:]
        dg_src = snap.get("diags_ref")
        if diagnostics is not None and dg_src is not None:
            if dg_src is not diagnostics:
                diagnostics[:] = [dict(d) for d in dg_src[: snap["n_diags"]]]
            else:
                del diagnostics[snap["n_diags"]:]

    features = document.get("features", [])
    start = 0
    if resume is not None:
        start, snap = resume
        _restore(snap)
        if not ids.restore(snap["ids_ref"][: snap["n_ids"]]):
            raise ValueError("resumed a cached prefix the document numbers differently")
        if snap.get("replay_sketches") and start > 0:
            # Disk checkpoints do not store sketches; replaying is cheap and reads no bodies.
            for f2 in features[:start]:
                if f2.get("type") == "sketch":
                    try:
                        sketches[f2["id"]] = _build_sketch(
                            f2, val, datums, plane=sketch_planes.get(f2["id"]))
                    except Exception:
                        pass  # its failure is already in the restored errors

    # One context, built once per rebuild, handed to every feature handler below
    # (see _RebuildCtx), bundles the exact closures/containers the old inline
    # if/elif chain closed over.
    ctx = _RebuildCtx(
        val=val, datums=datums, sketches=sketches, bodies=bodies,
        diagnostics=diagnostics, hidden_bodies=hidden_bodies,
        new_body=new_body, active=active, require_active=require_active,
        find_body=find_body, features=features, projections=projections,
        sketch_planes=sketch_planes, datum_marks=datum_marks,
    )

    inactive = set()
    for cf in features:
        try:
            if _is_inactive(cf, val):
                inactive.add(cf.get("id"))
        except ValueError:
            pass  # reported against the feature when the loop reaches it

    for i in range(start, len(features)):
        f = features[i]
        t_feat = time.monotonic()
        # Capture shapes and owners before the feature to attribute its new faces.
        # Skipped for features that touch no bodies; it was 12.7% of a cold rebuild.
        ids.start_feature(f.get("id"))
        prov = (f.get("type") not in ("sketch", "datumPlane", "datumPoint", "datumAxis")
                and f.get("id") not in inactive)
        if prov:
            pre_shape = {id(b): b.get("shape") for b in bodies}
            pre_owners_by_id = {id(b): (b.get("_owners") or {}) for b in bodies}
            pre_owners_all = ChainMap(*reversed(list(pre_owners_by_id.values())))
        try:
            t = f["type"]
            if _is_inactive(f, val):
                raise _Inactive
            handler = _FEATURE_HANDLERS.get(t) or plugin_geometry.handler_for(t)
            if handler is None:
                raise ValueError(plugin_geometry.unregistered(t))
            handler(f, ctx)

        except _Inactive:
            pass
        except ValueError as ex:  # name the feature so the timeline can flag it red
            # A failed feature is a no-op and the build continues. ValueErrors are written
            # for users; a GeomError also carries a machine `code` (errors.py).
            errors.append({"feature_id": f.get("id"), "message": str(ex),
                           "code": getattr(ex, "code", None)})
        except KeyError as ex:
            # Handlers index `f` directly; name the field only when it really is absent.
            key = ex.args[0] if ex.args else None
            label = f.get("name") or f.get("type") or "feature"
            if isinstance(key, str) and key not in f:
                errors.append({
                    "feature_id": f.get("id"),
                    "message": f'{label} is missing the field "{key}"',
                    "code": BAD_REQUEST,
                })
            else:
                print(f"feature {f.get('id')} ({label}) failed:", file=sys.stderr)
                traceback.print_exc()
                errors.append({"feature_id": f.get("id"),
                               "message": f"{label} failed (KeyError)"})

        except Exception as ex:
            # An internal failure: name the feature and exception type, log the traceback.
            label = f.get("name") or f.get("type") or "feature"
            print(f"feature {f.get('id')} ({label}) failed:", file=sys.stderr)
            traceback.print_exc()
            errors.append(
                {
                    "feature_id": f.get("id"),
                    "message": f"{label} failed ({type(ex).__name__})",
                }
            )
        else:
            if prov:
                _update_owners(f, val, bodies, pre_shape, pre_owners_by_id, pre_owners_all)
        if snapshots_out is not None:  # cache point: state after this feature
            snapshots_out.append((i, _snapshot()))
        if persist is not None:
            _persist_tick(
                persist, i, time.monotonic() - t_feat, bodies, datums, errors, ids.events,
                diagnostics, sketch_planes,
            )
        progress.feature_tick(i)  # this feature is done; the watchdog may relax

    if inactive and errors:
        by_id = {cf.get("id"): cf for cf in features}
        index_of = {cf.get("id"): k for k, cf in enumerate(features)}
        for e in errors:
            if "switched off" in e["message"]:
                continue
            fid = e.get("feature_id")
            off = _references_any(by_id.get(fid), inactive)
            if off:
                e["message"] += f" ({off} is switched off by its activeWhen)"
                continue
            # Without `bodyIds` bodies are named by position, so a switched off feature upstream
            # shifts every body id after it. The reference that broke is a body
            # id, not a feature id, and nothing else would point at the cause.
            if ids.recorded is not None:
                owner = _switched_off_owner(e["message"], ids.resulting_map(), inactive)
                if owner:
                    e["message"] += f" ({owner} is switched off by its activeWhen)"
                continue
            upstream = [cf.get("id") for cf in features[:index_of.get(fid, 0)]
                        if cf.get("id") in inactive]
            if upstream and "body" in e["message"].lower():
                e["message"] += (f" ({upstream[-1]} is switched off by its activeWhen and "
                                 "makes no bodies, so the body ids after it shift)")

    # A disjoint join (e.g. two bodies that don't touch) yields a ShapeList, which
    # has no single `.wrapped` TopoDS shape. Normalize each body to one Compound so
    # every consumer (tessellate/bbox/edges/export) gets a uniform Shape.
    out_bodies = []
    for b in bodies:
        progress_tick()  # per body: the final pass over a 3,000-body document
        sh = b["shape"]
        if sh is not None and _wrapped_or_none(sh) is None:
            sh = Compound(list(sh))
        if sh is not None and not b.get("_intact"):
            # final pass only, mid-timeline drops would shift downstream
            # geometric selectors and delete chips a later join re-absorbs
            sh = _drop_debris(sh)
        entry = {"id": b["id"], "name": b["name"], "shape": sh,
                 "owners": b.get("_owners") or {},
                 plugin_geometry.BODY_KEY: b.get(plugin_geometry.BODY_KEY)}
        # An explicit key set: anything new on the body dict must be listed here.
        if b.get("node_ref"):
            entry["node_ref"] = b["node_ref"]
        if b.get("face_colors"):
            entry["face_colors"] = b["face_colors"]
        if b.get("part_color"):
            entry["part_color"] = b["part_color"]
        out_bodies.append(entry)

    shapes = [b["shape"] for b in out_bodies if b["shape"] is not None]
    if not shapes:
        part = None
    elif len(shapes) == 1:
        part = shapes[0]
    else:
        part = Compound(shapes)

    if body_ids_out is not None:
        body_ids_out.update(ids.resulting_map())
    if datums_out is not None:
        datums_out.update(datums)
    if sketch_planes_out is not None:
        sketch_planes_out.update(sketch_planes)
    if datum_marks_out is not None:
        datum_marks_out.update(datum_marks)

    return part, errors, out_bodies


# --- incremental rebuild cache (worker memory, empty again after a respawn) ---
_RAM_SNAP_WINDOW = int(appenv.get("RAM_SNAP_WINDOW", "300"))


def reset_cache():
    """Forget this worker's prefix cache; disk checkpoints are untouched. Use this
    rather than assigning `_CACHE`, whose shape has changed before."""
    global _CACHE
    _CACHE = {"snaps": [], "keys": []}


def _ids_resumable(document, snap):
    return body_ids.BodyIds(document.get("bodyIds")).restore(snap["ids_ref"][: snap["n_ids"]])


def rebuild_cached(document, diagnostics=None, projections=None, datums_out=None,
                   sketch_planes_out=None, datum_marks_out=None, body_ids_out=None):
    """Incremental rebuild: reuse cached per-feature state for the unchanged document
    PREFIX and re-run only from the first changed feature. Resume sources, deepest
    wins: (1) in-RAM per-feature snapshots from the previous build in this worker,
    (2) durable disk checkpoints (geomstore) that survive worker restarts, crashes
    and timeouts. Falls back to a full rebuild when params/visibility change or both
    caches miss. Same return as rebuild(); geometrically identical to a full rebuild
    (verified by the incremental-vs-full smoke test + the differential harness)."""
    global _CACHE
    features = document.get("features", [])
    new_sigs = _feature_sigs(features)
    store = _disk_store()
    keys = _chain_keys_scoped(document, new_sigs)

    # Never resume past the first sketch with projected entities when collecting
    # projections: an unapplied update is not derivable from the document. The RAM
    # tier may, when the previous build here emitted nothing (a quiet proof).
    proj_cap = None
    if projections is not None:
        for pi, pf in enumerate(features):
            if pf.get("type") == "sketch" and any(
                isinstance(e, dict) and e.get("type") == "projected"
                for e in pf.get("entities") or []
            ):
                proj_cap = pi
                break

    resume = None
    from_disk = False
    disk_mod = {}
    # Resume at the longest common prefix of the parameter-scoped chain keys, so a
    # parameter edit only rebuilds from the first feature that reads it.
    if _CACHE.get("keys") and _CACHE["snaps"]:
        old_keys = _CACHE["keys"]
        k = 0
        while k < len(keys) and k < len(old_keys) and keys[k] == old_keys[k]:
            k += 1
        if proj_cap is not None and not (_CACHE.get("proj_quiet") and k > proj_cap):
            k = min(k, proj_cap)
        # snaps below the RAM retention window are None, fall through to disk
        if k > 0 and k - 1 < len(_CACHE["snaps"]) and _CACHE["snaps"][k - 1] is not None:
            if _ids_resumable(document, _CACHE["snaps"][k - 1]):
                resume = (k, _CACHE["snaps"][k - 1])  # restore state after feature k-1
    if resume is None and store is not None:
        progress_tick()
        hit = _restore_from_disk(store, keys if proj_cap is None else keys[:proj_cap])
        progress_tick()
        if hit is not None and _ids_resumable(document, hit[1]):
            start_i, snap, disk_mod = hit
            resume = (start_i, snap)
            from_disk = True

    persist = None
    if store is not None and features:
        persist = {"store": store, "keys": keys, "mod": dict(disk_mod),
                   "acc_ms": 0.0, "budget_ms": 1000.0}
        if resume is not None and not from_disk:
            # RAM resume: last-modifier keys for prefix bodies are unknown; stamp
            # them at the resume point. Same blob bytes under a fresh key, a
            # small dedup loss, never a correctness one.
            k0 = resume[0] - 1
            for b in resume[1]["bodies"]:
                if b.get("shape") is not None and k0 >= 0:
                    persist["mod"][b["id"]] = (b["shape"], _blob_key(keys[k0], b["id"]))

    t_build = time.monotonic()
    snaps_out = []
    if features:
        _rp = resume[0] if resume else 0
        print(
            f"[rebuild-cached] features={len(features)} resume_from={_rp} "
            f"src={'full' if resume is None else ('disk' if from_disk else 'RAM')}",
            flush=True,
        )
    part, errors, bodies = rebuild(
        document, diagnostics=diagnostics, resume=resume,
        snapshots_out=snaps_out, persist=persist, projections=projections,
        datums_out=datums_out, sketch_planes_out=sketch_planes_out,
        datum_marks_out=datum_marks_out, body_ids_out=body_ids_out,
    )
    elapsed = time.monotonic() - t_build

    # Builds with errors are cached too: snapshots carry the errors, and OCCT failures are deterministic.
    start = resume[0] if resume else 0
    if from_disk:
        merged = [None] * start  # no per-feature RAM snaps for the disk prefix
    else:
        merged = list(_CACHE["snaps"][:start])  # reused prefix
    merged.extend(snap for (_i, snap) in snaps_out)  # freshly built tail
    for j in range(0, max(0, len(merged) - _RAM_SNAP_WINDOW)):
        merged[j] = None  # bound RAM; disk checkpoints cover the deep prefix
    _CACHE = {"snaps": merged, "keys": keys,
              # quiet-proof for the next build's resume-cap decision (see above);
              # missing key (worker restart, Compute All reset) reads falsy =
              # conservative
              "proj_quiet": projections is not None and not projections}

    # Tip checkpoint for the next process, skipped for cheap builds.
    if (persist is not None and merged and merged[-1] is not None
            and (elapsed >= 0.5 or persist["acc_ms"] >= 500.0)):
        tip = merged[-1]
        _save_checkpoint(
            persist, len(features) - 1, tip["bodies"], tip["datums"],
            tip["errors_ref"][: tip["n_errors"]], tip["ids_ref"][: tip["n_ids"]],
            (tip.get("diags_ref") or [])[: tip["n_diags"]],
            tip.get("sketch_planes") or {},
        )
    if persist is not None:
        # annotate returned bodies with their content key so the server can key
        # per-body DISK MESH ARTIFACTS by it (load path skips the Python
        # triangle-readback loop entirely)
        for b in bodies:
            mk = persist["mod"].get(b["id"])
            if mk is not None:
                b["meshKey"] = mk[1]
    return part, errors, bodies


# --- face provenance --------------------------------------------------------
# `_owners` maps a quantized (area, centre) face fingerprint to the feature that
# last made it. A move transforms the keys so provenance survives it.

def _update_owners(f, val, bodies, pre_shape, pre_owners_by_id, pre_owners_all):
    """Attribute each face of every CHANGED body to a feature. Unchanged bodies (same
    shape object) keep their owners untouched, bounding the cost to what moved."""
    fid = f.get("id")
    is_move = f.get("type") == "move"
    move_ids, trsf = None, None
    if is_move and bodies:
        ids = f.get("bodies")
        move_ids = set(ids) if ids else {bodies[-1]["id"]}
        rx, ry, rz = val(f.get("rx", 0)), val(f.get("ry", 0)), val(f.get("rz", 0))
        dx, dy, dz = val(f.get("dx", 0)), val(f.get("dy", 0)), val(f.get("dz", 0))
        trsf = (Pos(dx, dy, dz) * Rot(rx, ry, rz)).wrapped.Transformation()
    for b in bodies:
        progress_tick()  # per body: face attribution walks every face
        sh = b.get("shape")
        if sh is None:
            b["_owners"] = {}
            continue
        bid = id(b)
        if bid in pre_shape and sh is pre_shape[bid]:
            continue  # unchanged this feature, keep prior owners
        prior = pre_owners_by_id.get(bid, {})
        if trsf is not None and b.get("id") in move_ids and prior:
            prior = {_move_fp(k, trsf): v for k, v in prior.items()}  # follow the move
        owners = {}
        for fp in _shape_face_fps(sh):
            owners[fp] = prior.get(fp) or pre_owners_all.get(fp) or fid
        b["_owners"] = owners


def _collect_datums(document):
    """The datumPlane registry for a document WITHOUT running a rebuild, datum
    planes are pure plane algebra over specs stored in the doc (no body
    geometry), so replaying just them mirrors what rebuild() registers. A datum
    that fails to resolve is skipped (its sketch already flags red at rebuild)."""
    datums = {}
    ctx = SimpleNamespace(datums=datums)
    for f in document.get("features", []):
        if f.get("type") == "datumPlane":
            try:
                _handle_datum_plane(f, ctx)
            except Exception:
                pass
    return datums


def project_geometry(document, plane_spec, sources):
    """Project sources onto a plane against the prefix document the frontend sends.
    Strict: anything unresolved or low-confidence is a per-source error.

    Returns {"results": [{source_index, ok, curves: [{fp?, curve}], error?}]}, `fp`
    only for body-edge sources."""
    _part, _errors, bodies = rebuild_cached(document)
    datums = _collect_datums(document)
    plane = _plane_of(plane_spec, datums)
    results = []
    for i, src in enumerate(sources):
        try:
            curves = _project_source(src, plane, document, bodies, datums)
            results.append({"source_index": i, "ok": True, "curves": curves})
        except Exception as ex:
            results.append({
                "source_index": i, "ok": False, "curves": [],
                "error": str(ex) or type(ex).__name__,
            })
    return {"results": results}


