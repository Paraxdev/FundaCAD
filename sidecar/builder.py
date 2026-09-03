"""document -> build123d. The heart of the sidecar.

Re-runs the whole feature tree from scratch on every rebuild (no incremental
regeneration, no persistent state). build123d's algebra mode IS the parametric
engine.

The model is **multi-body**: the rebuild keeps an ordered list of named bodies
with an "active" body (the last one created/edited). Most features operate on the
active body — so a document with no body-splitting ops behaves exactly like the
old single-body code. Import adds a body; Split can produce two; a union fuses
bodies together. The merged shape (a Compound of all bodies) is what gets
tessellated, measured and exported, so every downstream consumer stays uniform.

API notes (verified against build123d 0.11.1, dual-compatible back to 0.10.x):
  - extrude(sketch, amount=...)            free function, algebra mode
  - fillet(edges, radius=...)              radius kwarg
  - chamfer(edges, length=...)             length kwarg (NOT distance)
  - revolve(sketch, axis=..., revolution_arc=...)   degrees, default 360
    (a revolve with a `pitch` climbs instead, and is swept by
    BRepOffsetAPI_MakePipeShell, not by `revolve` — see _screw_revolve)
  - mirror(obj, about=Plane)               about defaults to Plane.XZ
  - loft(sections)                         iterable of sketches/faces
  - split(obj, bisect_by=Plane, keep=Keep.TOP|BOTTOM|BOTH)   cut by a plane
  - Mesher().read(path) -> [Shape]         STL/3MF/OBJ -> watertight solid(s)
  - import_step(path) / import_brep(path)  native B-rep read
  - export_brep(shape, BytesIO)            serialize a body for embedding
  - a + b / a - b / a & b                  union / cut / intersect (algebra mode)
  - Plane.XY * sketch  /  Pos(x,y,z) * shape   placement via * in algebra mode
  - 0.11 makes `.wrapped` a property that ASSERTS on an empty shape (0.10 left
    the attribute simply absent) — never touch `.wrapped` directly on a shape
    that might be empty; go through `_wrapped_or_none(shape)` instead, which
    tolerates both AttributeError (0.10) and AssertionError (0.11).
"""

import os
import sys
import time
import traceback
from collections import ChainMap
from dataclasses import dataclass
from types import SimpleNamespace

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from build123d import (
    Box,
    Cylinder,
    Sphere,
    Pos,
    Rot,
    Plane,
    Axis,
    Vector,
    Edge,
    Wire,
    Solid,
    Compound,
    GeomType,
    extrude,
    fillet,
    chamfer,
    mirror,
    revolve,
    loft,
    sweep,
    thicken,
    scale,
)

import face_plane
import geom_select
from geom_select import (
    resolve_edges,
    resolve_faces,
    _face_surface,
    _face_normal,
    edge_fingerprint,
    _edge_mid,
    _edge_dir,
    _edge_curve,
    _edge_dedup_key,
)
import texture
from conic_blend import PROFILE_EPS, clamp_profile

# Split out of this file when it passed seven thousand lines. Re-exported rather
# than referenced through the module, because `builder._unify_body` and friends
# are reached for by name from the tests, from server.py and from tessellate.py,
# and a split is only safe if it is invisible to every one of them.
import progress
from progress import progress_tick  # noqa: F401

# `on_feature_tick` is deliberately NOT re-exported: it is a mutable hook, and a
# re-exported copy would go stale the moment anyone rebound it. Set it through
# progress.py — `builder.on_feature_tick = cb` would bind a fresh attribute
# nothing reads. The MAX_IMPORT_* caps are left out of the re-export below for
# the same reason: a test that squeezes a limit has to squeeze it where the code
# reading it lives.
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
    SIZE_PROBE_FRACTION,
    SMOOTH_EDGE_DEG,
    _blend_edges,
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
    _global_sig,
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


@dataclass
class _RebuildCtx:
    """Bundle of the per-rebuild closures/containers a feature handler needs.
    Built ONCE per rebuild() call from the exact same locals the old inline
    if/elif chain closed over (new_body/active/require_active/find_body still
    close over `bodies` and the id `counter` — bundling them here is just a
    named handle onto that existing state, not new state)."""

    val: object            # resolve a parameter name to its value (or pass a literal through)
    datums: dict            # datumPlane feature id -> PlaneSpec
    sketches: dict          # sketch feature id -> {"sketch":, "faces":, "wire":, ...}
    bodies: list            # ordered [{id, name, shape}] — mutated in place by handlers
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


# --- feature handlers ---------------------------------------------------------
# One function per feature type, dispatched from the rebuild() loop below. Each
# handler is the exact body of the old inline if/elif branch (same logic, same
# comments, same error messages) — the loop still owns the try/except/errors.append
# and the no-op-continue semantics; handlers just raise like the old branches did.


def _handle_sketch(f, ctx):
    # A sketch picked on a body face follows that face. Resolved HERE rather than
    # inside _build_sketch because only the handler has a ctx to resolve against,
    # and the answer is reported so the overlay and the sketch editor draw where
    # the build put it: reopening a sketch at the stale cache would re-bake that
    # cache on the next commit and quietly undo the follow.
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
    """The plane of the face a sketch or datum was made from, re-resolved against
    the bodies as they stand now, or None when the feature references no face.

    This is what makes a sketch or datum placed on a face follow that face rather
    than record where the face used to be. Grow the box under a sketch from 10 to
    20 and the sketch stayed at 10: a join then added nothing, which raises, but a
    CUT carved a sealed cavity inside the part with no error at all. Measured on
    that document: 40x40x20 came out at 30994.7 mm3 in TWO shells, and the build
    was green.

    The frozen `plane` stays as a CACHE. The frontend draws from it, an older
    build opening the file still places the sketch correctly, and it is what the
    resolution falls back to. Once `face` is present it is this that decides.

    Resolution is GLOBAL across bodies, for the reason recorded on
    _handle_delete_face: body ids are positional, so an upstream split or boolean
    renumbers them and a body-scoped match would silently re-aim the anchor at
    some distant face on the wrong piece.

    A face that stops resolving is NOT an error. A sketch is a root: raise here
    and it never registers, every extrude and revolve downstream quietly becomes
    a no-op, and one drifted reference takes the whole document with it. So doubt
    falls back to the cached plane, the geometry is exactly what it is today and
    never worse, and the feature gets an amber chip saying which of the three
    things went wrong and, where a pick can repair it, a Re-pick button.
    """
    sel = f.get("face")
    cached = f.get("plane")
    cached = cached if isinstance(cached, dict) else None
    if not sel or cached is None:
        return None  # nothing to follow, or nothing to judge candidates against
    # getattr rather than ctx.bodies: _collect_datums replays datum features
    # against a ctx carrying nothing but the registry, because it exists to
    # answer "where are this document's planes" without building any geometry.
    # There is no body to resolve against there, so the anchor falls back to its
    # cache, which is exactly what that caller wants.
    shapes = [b["shape"] for b in (getattr(ctx, "bodies", None) or [])
              if b.get("shape") is not None]
    if not shapes:
        return None
    part = _as_compound(shapes) if len(shapes) > 1 else shapes[0]
    fid = f.get("id")
    at = f.get("at")

    # Held back rather than pushed. The planar resolver reports "the face is
    # gone" for a datum anchored to a CYLINDER, which is the wrong question
    # asked of the right document, so its answer is only committed once the
    # cylinder arm below has also declined.
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

    # A cylinder has no plane of its own, so a datum made from one is the tangent
    # plane where it was touched, read off the analytic surface (exact) rather
    # than fitted from the triangles the frontend had to work from. Reached only
    # when the planar arm found nothing, since a planar anchor never wants this.
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
    # No geometry — register the (optionally offset) plane so sketches
    # / splits can reference it by id. Validate it resolves here so a
    # bad datum flags at its own feature. `offset` shifts the source
    # plane along its normal; we store the resolved offset plane.
    followed = _face_anchor_plane(f, ctx, "Plane")
    base = _plane_of(followed or f["plane"], ctx.datums)
    off = f.get("offset") or 0
    origin = base.origin + base.z_dir * off
    ctx.datums[f["id"]] = {
        "origin": [origin.X, origin.Y, origin.Z],
        "xdir": [base.x_dir.X, base.x_dir.Y, base.x_dir.Z],
        "normal": [base.z_dir.X, base.z_dir.Y, base.z_dir.Z],
    }


def _handle_extrude(f, ctx):
    # A missing sketch is almost always an UPSTREAM failure, not a broken
    # reference: the sketch feature raised (bad profile, non-planar wires) and so
    # never registered. Indexing ctx.sketches raw turned that into `KeyError:
    # 'f1'`, which the generic handler surfaced as "extrude failed (KeyError)" —
    # burying the real cause behind an internal error and making the user chase
    # the wrong feature. Name the sketch instead and say it didn't build.
    entry = _require_sketch(ctx, f.get("sketch"), "extrude")
    sk = entry["sketch"]
    if sk is None:
        raise ValueError("sketch has no closed profile to extrude")
    # A zero-distance extrude sweeps nothing; OCCT reports it as
    # Standard_ConstructionError. Negative IS meaningful (extrude the other way).
    if ctx.val(f["distance"]) == 0:
        raise ValueError("Extrude: distance must not be 0")
    # region points (one per selected area) pick + combine specific
    # profiles; a ring (annulus) keeps its hole, several areas union.
    pts = f.get("regions")
    if not pts and f.get("region"):
        pts = [f["region"]]
    target = _region_target(pts, entry, ctx)
    if target is None:
        target = sk  # nothing selected: the whole sketch
    solid = extrude(target, amount=ctx.val(f["distance"]))
    # Captured-visibility semantics: an extrude that carries
    # `hiddenBodies` uses THAT set (participants decided at feature
    # creation, MCAD-style — later eye toggles are pure display).
    # A legacy feature without the field keeps the old behavior:
    # gated by the document's live visibility map.
    hid = (
        frozenset(f["hiddenBodies"])
        if "hiddenBodies" in f
        else ctx.hidden_bodies
    )
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, hid)


def _handle_fillet(f, ctx):
    r = ctx.val(f["radius"])
    # `profile` slides the section between a chamfer (-1) and a sharp corner
    # (+1), with 0 the circular fillet every existing document already means.
    # Absent or 0 keeps the plain build123d path, so nothing that worked before
    # now routes through the reweighting machinery.
    p = clamp_profile(ctx.val(f["profile"])) if f.get("profile") is not None else 0.0
    if abs(p) < PROFILE_EPS:
        _blend_edges(f, ctx, "Fillet",
                     lambda s, es: fillet(es, radius=r),
                     lambda s, e, size: fillet([e], radius=size), r)
        return
    _blend_edges(f, ctx, "Fillet",
                 lambda s, es: _conic_fillet(s, es, r, p),
                 lambda s, e, size: _conic_fillet(s, [e], size, p), r)


def _handle_chamfer(f, ctx):
    d = ctx.val(f["distance"])
    _blend_edges(f, ctx, "Chamfer",
                 lambda s, es: chamfer(es, length=d),
                 lambda s, e, size: chamfer([e], length=size), d)


def _handle_press_pull(f, ctx):
    # target the body that OWNS the picked face (sent by the tool),
    # not just the active body — so press/pull on a multi-body model
    # modifies the right body.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Press/Pull")
    if act is None:
        raise ValueError("Press/Pull: the target body no longer exists")
    # one or many faces, each pushed by the same distance along its own
    # normal. Re-resolve every selector against the EVOLVING shape — each
    # push renumbers topology, and the selectors are geometric, so this
    # stays correct (the tool emits one by:"nearest" selector per face).
    sels = f["face"] if isinstance(f["face"], list) else [f["face"]]
    # `upTo`: extrude each face UP TO a target surface instead of by a
    # fixed distance. Capture the target plane once (point + normal) so
    # every source face extrudes to the same surface.
    up = f.get("upTo")
    tgt_pt = tgt_n = None
    if up:
        # Point picks resolve GLOBALLY: the target only contributes
        # a PLANE, so "extrude until it meets that other part" is
        # legitimate — the user may aim at a face of ANY body.
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
    for sel in sels:
        found = resolve_faces(act["shape"], sel, diag=ctx.diagnostics, feature_id=f.get("id"))
        if not found:
            raise ValueError("no face found to press/pull")
        src = found[0]
        d = _distance_to_target(src, tgt_pt, tgt_n) if up else dist
        # up-to distances are exact by construction — the inward
        # clamp would silently stop short of the chosen target
        act["shape"] = _press_pull(act["shape"], src, d, clamp=(not up))


def _handle_delete_face(f, ctx):
    # Remove the picked face(s) and heal the solid (defeaturing) — deletes
    # an imported chamfer/fillet or a protrusion, where there's no feature
    # to remove. Parametric: the face selector re-resolves each rebuild.
    # Body ids are POSITIONAL — an upstream split/boolean renumbers them,
    # silently re-aiming a saved deleteFace at the wrong piece (its nearest
    # match is then some distant face; the delete fails or worse). So
    # nearest-point picks resolve GLOBALLY: the face nearest the recorded
    # point wins across ALL bodies, and a win on a different body than the
    # named one re-targets there with a lossy diagnostic.
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
    # Repair boolean rot on a body, exposed as a PARAMETRIC feature
    # because downstream booleans re-manufacture it: first collapse
    # per-solid facet debris (slivers + near-coplanar staircases,
    # the same pass that runs at mesh import), then
    # unify the body's glued/overlapping solids (_unify_body — joins
    # of ragged bodies GLUE solids together instead of merging
    # them). Order matters: fusing the raw sliver-ridden solids
    # collapses to garbage (which the unify gates refuse), while the
    # refacet-cleaned solids fuse cleanly — measured on the DDR
    # document. Both best-effort: a body that can't confidently be
    # cleaned stays unchanged.
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
            # renumbered it) — a legitimate no-op, not a hard error
            _skip_feature(ctx.diagnostics, f, "cleanUp", "target body already consumed or missing")


def _handle_mirror(f, ctx):
    act = ctx.require_active("Mirror")
    act["shape"] = act["shape"] + mirror(act["shape"], about=_plane_of(f["plane"], ctx.datums))


def _handle_revolve(f, ctx):
    entry = _require_sketch(ctx, f.get("sketch"), "revolve")
    # The selected areas, the same way extrude reads them (_region_cells says how
    # they are cut). Absent means the whole sketch, which is what every revolve
    # saved before the tool started recording its selection means — and what it
    # did with a selection, which is the bug.
    sk = _region_target(f.get("regions"), entry, ctx)
    if sk is None:
        sk = entry["sketch"]
    if sk is None:
        raise ValueError("sketch has no closed profile to revolve")
    angle = ctx.val(f.get("angle", 360))
    # A zero-degree revolve swept nothing yet still produced a body, so the
    # timeline showed a healthy feature that had done nothing at all.
    if angle == 0:
        raise ValueError("Revolve: angle must not be 0 — nothing would be swept")
    pitch = ctx.val(f.get("pitch", 0) or 0)
    axis = _revolve_axis(f, ctx)
    if pitch:
        _boolean_into_bodies(
            ctx.bodies, _screw_revolve(sk, axis, angle, pitch),
            f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)
        return
    # Past a full turn a flat revolve only re-sweeps ground it has already
    # covered. OCCT wraps such an arc back onto the same solid by itself
    # (measured: 360, 720 and 1080 all give the identical shape), so clamping
    # here changes no result — it states the intent where the value is read,
    # instead of leaving a document that says 1080 and a body that means 360.
    # Winding on is only meaningful once there is a pitch to separate one turn
    # from the next, and the branch above owns that case.
    if angle > 360:
        angle = 360
    elif angle < -360:
        angle = -360
    try:
        solid = revolve(sk, axis=axis, revolution_arc=angle)
    except Exception as ex:
        # OCCT reports a profile that straddles the axis as a bare
        # `StdFail_NotDone` ("BRep_API: command not done"), which tells the user
        # nothing. Name the overwhelmingly likely cause instead; a profile may
        # TOUCH the axis, but it may not cross it.
        raise ValueError(
            "Revolve failed — the profile probably crosses the axis of "
            f"revolution ({f.get('axis', 'Z')}). Move it fully to one side "
            f"(it may touch the axis, but not cross it). [{type(ex).__name__}]"
        )
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _turn_clearance(tall):
    """How much room one turn of a screw revolve must leave the next.

    Absolute at small sizes so a 0.2 mm thread is not scaled away, proportional
    above 10 mm so a coarse thread gets a clearance in the same ratio."""
    return max(1e-3, 1e-4 * tall)


def _axial_scale(shape, factor, direction, hold):
    """Scale `shape` by `factor` along `direction` only, holding the plane whose
    axial coordinate (measured along `direction` from the world origin) is
    `hold`. Every dimension across the axis is left exactly as drawn.

    A true non-uniform scale, so a profile keeps its vertex count: no offset, no
    slivers, nothing for the sweep to choke on."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform
    from OCP.gp import gp_GTrsf, gp_Mat, gp_XYZ

    d = Vector(*direction).normalized()
    k = factor - 1.0
    # I + k * d d^T — the identity across the axis, `factor` along it.
    m = gp_Mat(*[1.0 * (i == j) + k * d.to_tuple()[i] * d.to_tuple()[j]
                 for i in range(3) for j in range(3)])
    g = gp_GTrsf()
    g.SetVectorialPart(m)
    g.SetTranslationPart(gp_XYZ(*tuple(d * (-k * hold))))
    return _wrap_topods(BRepBuilderAPI_GTransform(shape.wrapped, g, True).Shape())


def _screw_revolve(profile, axis, angle, pitch):
    """A revolve that climbs the axis while it turns: one turn rises `pitch`.

    This is the whole of thread cutting. Draw the thread's cross section in a
    plane through the axis, give it the thread's pitch, wind the angle past 360
    for as many turns as the thread is long, and Join it to the shank or Cut it
    out of the bore. Nothing else about the feature changes, which is the point:
    a thread is a revolve that does not close on itself.

    Built as a pipe sweep along a helix, with the binormal PINNED to the axis
    direction. That pin is what makes it a revolve rather than a pipe: with a
    fixed binormal, OCCT builds each section's frame from the tangent and that
    direction, so the section's plane always contains the axis. It stays a
    meridian section all the way round, exactly as a revolve's does, instead of
    tipping to stay square to the helix (which is what Frenet framing does, and
    which would thin the profile by the cosine of the helix angle).

    The motion from the profile's own position to any point of the sweep is then
    a pure screw: rotate about the axis, rise along it. So the spine's RADIUS is
    free and cancels out (verified: a spine at r=0.3 and one at the profile's own
    radius give the same volume and the same bounding box to 1e-6). Its start
    DIRECTION does not cancel: the profile is carried from wherever the spine
    starts, so a spine that starts a quarter turn away lifts the whole result by
    a quarter of the pitch. The spine is therefore built on the meridian the
    profile is already on, which leaves the first section exactly where it was
    drawn.

    The volume is a Pappus identity and is what the tests measure: the axial
    travel shears the section within its own plane, which adds nothing, so a
    section of area A whose centroid sits at radius r sweeps A * r * angle
    (radians) no matter what the pitch is.
    """
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell
    from OCP.gp import gp_Dir

    D = Vector(*axis.direction).normalized()
    O = Vector(*axis.position)

    faces = list(profile.faces()) if hasattr(profile, "faces") else [profile]
    if not faces:
        raise ValueError("Revolve: no closed profile to sweep")

    # Consecutive turns run into each other when the section is taller along the
    # axis than one turn's climb. OCCT builds that happily and hands back a
    # self-intersecting solid that measures as if nothing were wrong, so the
    # first sign of it would be a boolean failing much later, somewhere else.
    # One turn has no neighbour to hit, hence the angle test.
    if abs(angle) > 360:
        local = Plane(origin=tuple(O), z_dir=tuple(D)).to_local_coords(
            Compound(faces) if len(faces) > 1 else faces[0])
        bb = local.bounding_box()
        tall = bb.max.Z - bb.min.Z
        clear = _turn_clearance(tall)
        if tall > abs(pitch) + clear:
            raise ValueError(
                f"Revolve: the profile is {tall:.4g} mm tall along the axis but "
                f"climbs only {abs(pitch):.4g} mm each turn, so every turn would "
                "run into the one before. Raise the pitch, or draw a shorter "
                "profile, or stay within one turn."
            )
        # A profile as tall as the climb is the thread everyone actually draws:
        # crest lands on root, no flat between the turns. It is also the one
        # shape a B-rep kernel cannot use. A V section meeting the next V section
        # touches along a LINE, so the solid is non-manifold — BRepCheck calls it
        # valid and every boolean against it then quietly does nothing (measured:
        # cutting a block that should lose 610.4 mm3 lost 0.410).
        #
        # Welding the turns is the intuitive repair and it does not work: the
        # overlap between two crests is a lens whose width vanishes with its
        # height, so no amount of it gives OCCT a real intersection to find
        # (per-turn sweeps fused at 1e-3..5e-2 of overlap all came back with
        # NEGATIVE volume). Clearance does work, and by a lot: stop the crest a
        # hair short of the next root and the sweep stays one clean five-faced
        # solid that cuts to within 0.06% of the hand-computed answer.
        #
        # 1e-3 mm is ten times the measured floor (below 1e-4 mm the booleans go
        # back to doing nothing) and a thousandth of a printed layer, so the
        # thread it makes is the thread that was drawn.
        if tall > abs(pitch) - clear:
            faces = [_axial_scale(f, (abs(pitch) - clear) / tall,
                                  D, O.dot(D) + (bb.min.Z + bb.max.Z) / 2)
                     for f in faces]

    turns = angle / 360.0
    rise = turns * pitch

    out = None
    for face in faces:
        progress_tick()
        rel = face.center() - O
        axial = rel.dot(D)
        radial = rel - D * axial
        r = radial.length
        if r < 1e-6:
            raise ValueError(
                "Revolve: a climbing revolve needs a profile that sits off to "
                "one side of the axis. This one is centred on it, so there is "
                "no direction for it to start from."
            )
        # `lefthand` and the flipped normal between them cover all four sign
        # pairs: the sweep turns the way the angle says, and rises the way the
        # pitch says, independently. Both are checked in the orientation tests.
        helix = Edge.make_helix(
            pitch=abs(pitch), height=abs(rise), radius=r,
            center=(0, 0, 0), normal=(0, 0, 1), lefthand=(pitch < 0))
        frame = Plane(origin=tuple(O + D * axial), x_dir=tuple(radial.normalized()),
                      z_dir=tuple(D if rise >= 0 else -D))
        path = frame * helix
        spine = path if isinstance(path, Wire) else Wire(path.edges())

        def swept(wire, _spine=spine):
            mps = BRepOffsetAPI_MakePipeShell(_spine.wrapped)
            mps.SetMode(gp_Dir(*tuple(D)))
            mps.Add(wire.wrapped, False, False)
            mps.Build()
            if not mps.IsDone():
                raise ValueError(
                    "Revolve: the climbing sweep failed. A profile that is very "
                    "close to the axis, or a pitch far larger than the profile, "
                    "can make a surface that crosses itself."
                )
            mps.MakeSolid()
            return Solid(mps.Shape())

        solid = swept(face.outer_wire())
        for hole in face.inner_wires():
            solid = solid - swept(hole)
        out = solid if out is None else out + solid
    return _as_compound(out)


def _revolve_axis(f, ctx):
    """The axis to spin about: one of the three world axes, an arbitrary line, or
    the line of the EDGE the revolve was aimed at, re-resolved against the bodies
    as they stand now.

    Re-resolving is what makes a picked edge a reference rather than a note about
    where an edge used to be. Resolution is GLOBAL across bodies for the reason
    recorded on _face_anchor_plane: body ids are positional, so an upstream split
    or boolean renumbers them and a body-scoped match would silently re-aim the
    revolve at some distant edge on the wrong piece.

    An edge that stops resolving is not an error. The axis falls back to the
    cached line — where the user last saw it — because the alternative is a
    failed feature and a body that disappears with it. So is an edge that is no
    longer straight: an axis is a line, and a curve cannot be one.
    """
    axis = f.get("axis", "Z")
    sel = f.get("axisEdge")
    if sel:
        found = None
        for b in getattr(ctx, "bodies", None) or []:
            shape = b.get("shape")
            if shape is None:
                continue
            try:
                edges = resolve_edges(shape, sel, getattr(ctx, "diagnostics", None), f.get("id"))
            except Exception:
                continue
            for e in edges or []:
                if e is not None and _edge_curve(e) == "line":
                    found = e
                    break
            if found is not None:
                break
        if found is not None:
            a, d = _edge_mid(found), _edge_dir(found)
            return Axis((a.X, a.Y, a.Z), (d.X, d.Y, d.Z))
    if isinstance(axis, dict):
        o, d = axis.get("origin") or [0, 0, 0], axis.get("dir") or [0, 0, 1]
        try:
            return Axis(tuple(float(v) for v in o), tuple(float(v) for v in d))
        except Exception:
            return AXES["Z"]
    return AXES.get(axis, AXES["Z"])


def _handle_loft(f, ctx):
    # Fusion flow: loft through the SELECTED profile regions (each on its own
    # sketch, in the order given). Resolving the region anchor to a Face — the
    # same region picking extrude uses — keeps a ring's HOLE, and build123d's
    # loft blends faces-with-holes into a tube natively. The legacy `sketches`
    # path lofts whole un-consumed sketch profiles (ribbon fallback).
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
            "Loft failed to blend these profiles — they may be coincident, "
            f"identical, or too dissimilar to connect. [{type(ex).__name__}]"
        )
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _handle_sweep(f, ctx):
    prof = _require_sketch(ctx, f.get("profile"), "sweep")["sketch"]
    if prof is None:
        raise ValueError("sweep profile has no closed section")
    path = _require_sketch(ctx, f.get("path"), "sweep").get("wire")
    if path is None:
        raise ValueError("sweep path sketch has no curve to follow")
    solid = sweep(sections=prof, path=path)
    # Same New/Join/Cut boolean path as extrude/revolve/loft: booleans against
    # every visible overlapping body, with the loud no-op guards. (Sweep used to
    # inline `act["shape"] + solid` / `- solid` against only the active body —
    # unguarded, and a Cut with no active body silently created a new body.)
    _boolean_into_bodies(ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies)


def _blob_top_children(shape):
    """The blob's top-level children, in stored order. Deliberately NOT
    `.solids()`: the manifest binds row i to child i, and a leaf product with no
    solid (the ones dropped silently today) has to keep its slot."""
    from OCP.TopoDS import TopoDS_Iterator

    out = []
    it = TopoDS_Iterator(shape.wrapped)
    while it.More():
        out.append(it.Value())
        it.Next()
    return out


def _bind_assembly(f, ctx, shape, nodes, parts):
    """Name the blob's children from the assembly manifest. Returns False, having
    recorded WHY, if the manifest and the geometry disagree — the caller then
    falls back to the historical unnamed explode. A wrong tree is worse than no
    tree: every body would still build, just labelled as the wrong part."""
    children = _blob_top_children(shape)
    if len(children) != len(parts):
        _skip_feature(
            ctx.diagnostics, f, "import",
            f"assembly manifest lists {len(parts)} parts but the stored geometry "
            f"has {len(children)} top-level shapes — falling back to unnamed bodies",
        )
        return False

    wrapped = []
    for i, (child, part) in enumerate(zip(children, parts)):
        # One tick per leaf. A single import feature rebuilding a large assembly
        # was the longest SILENT phase left in the product: measured 90 s
        # emitting one tick, against a 60 s stall budget. Wave 1.1 ticked export,
        # the interference sweep and checkpoint writes and missed this one.
        progress_tick()
        w = _wrap_topods(child)
        node_index = part.get("node") if isinstance(part, dict) else None
        if w is None or not isinstance(node_index, int) or not 0 <= node_index < len(nodes):
            _skip_feature(
                ctx.diagnostics, f, "import",
                f"assembly manifest entry {i} does not refer to a known part "
                f"— falling back to unnamed bodies",
            )
            return False
        # Face count is the checksum that turns an ordinal reference into a
        # CHECKED one. Without it a reordered or re-generated blob would bind
        # silently, and the only symptom would be parts wearing each other's names.
        expected_faces = part.get("faces")
        if expected_faces is not None and len(w.faces()) != expected_faces:
            _skip_feature(
                ctx.diagnostics, f, "import",
                f"assembly part {i} expected {expected_faces} faces but the stored "
                f"geometry has {len(w.faces())} — falling back to unnamed bodies",
            )
            return False
        wrapped.append((w, node_index))

    # A product owning several solids numbers them; one owning a single solid
    # keeps its bare name. Same convention the anonymous path already used.
    owned = {}
    for _w, node_index in wrapped:
        owned[node_index] = owned.get(node_index, 0) + 1

    base = f.get("name") or "Imported"
    feature_id = f.get("id")
    seen = {}
    for w, node_index in wrapped:
        label = (nodes[node_index] or {}).get("name") or base
        if owned[node_index] > 1:
            seen[node_index] = seen.get(node_index, 0) + 1
            label = f"{label} {seen[node_index]}"
        ctx.new_body(w, label, node_ref=f"{feature_id}/{node_index}")
    return True


_BINTOOLS_MAGIC = b"Open CASCADE Topology V"


def _blob_to_shape(data):
    """A stored binary BREP blob back to a build123d Shape.

    The magic check is NOT redundant with the blob store's hash verification.
    That hash proves the bytes are the ones the container declared — it does not
    prove they are benign, because whoever crafted a hostile `.sindri` chose both
    the bytes and the declared hash. So the same reasoning as
    `_brep_b64_to_shape` applies: refuse to aim a parser fuzz at OCCT.

    There is deliberately NO size cap here, unlike the 64 MiB `MAX_BREP_BYTES` on
    the legacy embedded path. That cap is exactly what makes a large assembly
    unopenable, and it is the thing this whole change exists to remove. The bound
    that replaces it is upstream: the container reader refuses an archive that
    declares more than 8 GiB before inflating a byte."""
    import geomstore

    if not data[: len(_BINTOOLS_MAGIC) + 2].lstrip(b"\n\r ").startswith(_BINTOOLS_MAGIC):
        raise ValueError("stored geometry is not a valid binary BREP (bad header)")
    # _wrap_topods, not Shape.cast: BinTools hands back a raw TopoDS, and for an
    # assembly that is a COMPOUND, which Shape.cast() turns into None (see its
    # docstring). Same trap the XCAF reader hit.
    shape = _wrap_topods(geomstore.deserialize_shape(data))
    if shape is None:
        raise ValueError("stored geometry decoded to an empty shape")
    return shape


def _import_shape(f):
    """The geometry for an import feature.

    Prefers the content hash (`geom`) and falls back to the legacy embedded
    base64 (`brep`). Both fields are present during the transition, so a blob
    that has gone missing — a wiped app-data directory, a document copied
    without its container — still rebuilds from the embedded copy rather than
    failing. Once `brep` is gone that fallback disappears and the missing-blob
    error below becomes the live path."""
    import blobstore

    digest = f.get("geom")
    b64 = f.get("brep")
    if digest:
        data = blobstore.default_store().get_bytes(digest)
        if data is not None:
            return _blob_to_shape(data)
        if not b64:
            raise ValueError(
                "the geometry for this imported body is missing from local storage. "
                "Open the .sindri file it was saved in, or re-import the original file."
            )
        # Fall through to the embedded copy, loudly: a miss here means either a
        # wiped store or a document that travelled without its container, and
        # both are worth seeing in the log rather than silently absorbing.
        print(f"[blobstore] blob {digest} missing; falling back to the embedded BREP",
              file=sys.stderr, flush=True)
    if not b64:
        raise ValueError("this imported body has no geometry attached")
    return _brep_b64_to_shape(b64)


def _assembly_root_index(nodes):
    """Index of the assembly's root product (the node with no parent), or None.
    First one wins: a well-formed tree has exactly one."""
    if not nodes:
        return None
    for i, n in enumerate(nodes):
        if isinstance(n, dict) and n.get("parent") is None:
            return i
    return None


def _handle_import(f, ctx):
    base = f.get("name") or "Imported"
    shape = _import_shape(f)
    nodes, parts = f.get("nodes"), f.get("parts")
    # explode:false keeps a multi-solid payload as ONE body. For imported
    # assemblies with hundreds of import features this divides body count
    # (browser tree entries, per-body payloads, draw calls) by the average
    # solids-per-import. Default (absent/true) keeps the historical
    # one-body-per-solid behavior. It is checked FIRST because it is an explicit
    # instruction to collapse, which a manifest cannot override.
    if f.get("explode") is False:
        # ...but collapsing the GEOMETRY must not throw away the TREE. This used
        # to return here with a body named "Imported" and no node_ref at all, so
        # the whole assembly hierarchy — product names, structure, colours —
        # was discarded by the one flag a user would reach for on exactly the
        # documents where that hierarchy matters most.
        #
        # One body can only honestly claim one node, so it claims the ROOT: the
        # body carries the assembly's own name and sits under it in the Browser,
        # instead of appearing as an anonymous loose body.
        root = _assembly_root_index(nodes)
        if root is not None:
            label = (nodes[root] or {}).get("name") or base
            body = ctx.new_body(shape, label, node_ref=f"{f.get('id')}/{root}")
        else:
            body = ctx.new_body(shape, base)
        # Exempt from _drop_debris. That pass deletes any solid under 0.1% of
        # the biggest one that does not touch it, on the theory that it is
        # residue from the booleans that carved the body. An explicitly
        # collapsed import is the opposite case: every solid in it is a part
        # the user's file declared, and small ones that float clear of the
        # largest are the NORM in an assembly, not debris.
        #
        # Measured on asm_nested: main body 3200 mm3, and four legitimate parts
        # at 3.0 mm3 each — 0.094%, just under the threshold — were silently
        # deleted, taking 4 of 7 parts and 24 of 42 faces with them. It never
        # showed up before because the exploded path gives each body ONE solid,
        # and the pass returns early below two.
        body["_intact"] = True
        return
    # Assembly manifest, when the import recorded one. Absent for every import
    # made before this existed and for every non-assembly file, which is what
    # keeps those documents rebuilding exactly as they did.
    if nodes and parts and _bind_assembly(f, ctx, shape, nodes, parts):
        return
    parts = _explode_solids(shape)
    if len(parts) == 1:
        ctx.new_body(parts[0], base)
    else:
        for part_no, p in enumerate(parts, 1):
            ctx.new_body(p, f"{base} {part_no}")


def _require_positive(op, **dims):
    """Reject a non-positive dimension BY NAME, before OCCT ever sees it.

    OCCT answers a zero-height box with `Standard_DomainError` and a zero-factor
    scale with `Standard_ConstructionError`. Those class names reach the user as
    the WHOLE explanation and say nothing about what to change — measured across
    seven operations in docs/EDGE-CASES.md. Every one of them is a predictable
    degenerate input, so name the field and the value the user actually typed.
    """
    for name, v in dims.items():
        if v is None:
            continue
        if not (v > 0):
            raise ValueError(f"{op}: {name} must be greater than 0 (got {v:g})")


def _require_sketch(ctx, sid, op):
    """Fetch a sketch entry, or explain WHICH upstream sketch failed.

    A missing sketch is almost always an UPSTREAM failure, not a broken
    reference: the sketch feature raised (bad profile, zero-radius circle,
    non-planar wires) and so never registered. Indexing `ctx.sketches` raw turned
    that into `KeyError: 'f1'`, which the generic handler surfaced as
    "<op> failed (KeyError)" — burying the real cause behind an internal error
    and pointing the user at the wrong feature.

    Extracted after finding the same fault in FOUR handlers (extrude, revolve,
    loft, sweep); each had its own raw lookup. Route every sketch fetch here.
    """
    entry = ctx.sketches.get(sid)
    if entry is None:
        raise ValueError(
            f"the sketch this {op} depends on ({sid}) did not build — "
            "fix that sketch first"
        )
    return entry


def _handle_box(f, ctx):
    l, w, h = ctx.val(f["length"]), ctx.val(f["width"]), ctx.val(f["height"])
    _require_positive("Box", length=l, width=w, height=h)
    ctx.new_body(Box(l, w, h), "Box")


def _handle_cylinder(f, ctx):
    r, h = ctx.val(f["radius"]), ctx.val(f["height"])
    _require_positive("Cylinder", radius=r, height=h)
    ctx.new_body(Cylinder(r, h), "Cylinder")


def _handle_sphere(f, ctx):
    r = ctx.val(f["radius"])
    _require_positive("Sphere", radius=r)
    ctx.new_body(Sphere(r), "Sphere")


def _handle_shell(f, ctx):
    # Hollow each body that owns a selected opening face — the selectors carry
    # their own body (see _group_sels_by_body), so a multi-body model shells the
    # body clicked, not bodies[-1]. No faces at all = hollow the active body
    # closed, which is the ribbon's "shell with no opening" path.
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
    # Offset Face: move the selected faces along their own normals, keeping the
    # body closed (the neighbouring faces stretch to follow). Targets the body
    # that OWNS the picked faces, like press-pull — NOT require_active, which
    # only ever sees bodies[-1] and would edit the wrong body on a multi-body model.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Offset face")
    if act is None:
        raise ValueError("Offset face: the target body no longer exists")
    faces = resolve_faces(act["shape"], f["faces"], diag=ctx.diagnostics, feature_id=f.get("id"))
    if not faces:
        raise ValueError("no face found to offset")
    _guard_offsetable(act["shape"], faces, "Offset face")
    d = ctx.val(f["distance"])
    # Offsetting by zero moves nothing, but used to report success — the same
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
    # One BRepOffset pass over the whole body is the good answer when it runs:
    # adjacent offsets close against each other. When it does not run it refuses
    # every face at once, including ones that move fine on their own, so retry
    # face by face through the press/pull primitive.
    #
    # Re-resolved against the EVOLVING shape rather than reusing `faces` — each
    # move renumbers the topology, and a Face object from the shape before it is
    # a reference into a solid that no longer exists.
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
    _boolean_into_bodies(
        ctx.bodies, solid, f.get("operation", "new"), ctx.new_body, ctx.hidden_bodies
    )


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


def _handle_texture(f, ctx):
    # Two-phase, like every other selector feature but lazier: validate NOW
    # (so a bad kind/param/image path shows red on the timeline immediately)
    # against the CURRENT shape via a THROWAWAY resolve, but never touch
    # act["shape"] — the spec is stored raw and re-resolved once, lazily,
    # against the FINAL shape at tessellation/export time (texture.py's
    # resolve_body_textures), so it survives downstream topology changes the
    # same way every other lossy-tolerant selector already does.
    act = ctx.find_body(f["body"]) if f.get("body") else ctx.require_active("Texture")
    if act is None:
        raise ValueError("Texture: the target body no longer exists")
    sel = f.get("faces") or {"by": "all"}
    found = texture._resolve_texture_faces(act["shape"], sel)
    if not found:
        raise ValueError("no face found for texture")
    spec = texture.validate_texture_spec(f)
    # REBIND, never mutate in place: body dicts are shallow-copied by
    # _snapshot() (dict(b)), so appending to an EXISTING list would corrupt
    # any earlier snapshot's view of "_textures" through the shared reference.
    act["_textures"] = (act.get("_textures") or []) + [spec]


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
    error — an upstream split or removal renumbers bodies, and a pattern that
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
    """Resize bodies, uniformly or per axis, about a chosen point.

    `factor` is the whole of the old feature and still the default for every
    axis, so a document written before this reads the same. `sx`/`sy`/`sz`
    override it one axis at a time — that is what a gizmo handle dragged along
    one arrow means, and build123d carries it through to a GTransform.

    `about` is the point the resize holds still. Absent, build123d scales about
    each object's OWN LOCATION — the world origin for a body as built, and
    wherever a `move` put it afterwards — which is exactly what this feature did
    before, so a document without one stays where it was. The gizmo always sends
    a point, because "grow this from that corner" is the request people have and
    "grow this about wherever the body's location happens to sit" is not one
    anybody could aim.
    """
    from OCP.BRepTools import BRepTools

    ids = f.get("bodies")
    targets = [ctx.find_body(b) for b in ids] if ids else [ctx.require_active("Scale")]
    factor = ctx.val(f.get("factor", 1))
    axes = tuple(
        ctx.val(f[k]) if f.get(k) is not None else factor for k in ("sx", "sy", "sz")
    )
    # A factor of 0 collapses the solid — to a point uniformly, to a flat sheet
    # on one axis; OCCT reports either as Standard_ConstructionError. Negative
    # factors DO work (a mirror through the point) and are left alone.
    for name, v in zip(("factor", "sx", "sy", "sz"), (factor,) + axes):
        if v == 0:
            raise ValueError(
                f"Scale: {name} must not be 0 — it would collapse the body flat"
            )
    about = f.get("about")
    by = factor if axes == (factor, factor, factor) else axes
    for tgt in targets:
        if tgt is None:
            # stale id (an upstream body removal renumbered it) — a legitimate
            # no-op, the same way move treats one, not a hard error
            _skip_feature(ctx.diagnostics, f, "scale", "target body already consumed or missing")
            continue
        kw = {"about": Vector(*about)} if about else {}
        out = scale(tgt["shape"], by=by, **kw)
        # Drop whatever triangulation the faces are carrying.
        #
        # A body that has been drawn once comes back out of the per-body cache
        # still holding the tessellator's mesh, and a non-uniform scale goes
        # through BRepBuilderAPI_GTransform, which returns correct GEOMETRY with
        # that mesh still attached and no longer describing it. Everything
        # downstream reads the mesh. Measured on a 20mm cube stretched 2x in x
        # about a corner: the kernel had it at -10..30 and the reply carried
        # -20..20, so the part on screen was not the part in the document, and
        # nothing anywhere raised.
        #
        # Cleaning costs a re-mesh the tessellator was going to do anyway, and
        # it is done on every path rather than only the non-uniform one so the
        # rule is simply "a scaled body leaves here with no mesh on it".
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
            # stale id (upstream body removal/split renumbered it) —
            # a legitimate no-op, not a hard error
            _skip_feature(ctx.diagnostics, f, "move", "target body already consumed or missing")
            continue
        sh = tgt["shape"]
        # A disjoint body is a build123d ShapeList (no single `.wrapped`);
        # Rot/Pos (Location.__mul__) only accept ONE Shape, so normalize to
        # a Compound first — else "other must be a list of Locations".
        if sh is not None and _wrapped_or_none(sh) is None:
            sh = Compound(list(sh))
        if rx or ry or rz:
            sh = Rot(rx, ry, rz) * sh
        if dx or dy or dz:
            sh = Pos(dx, dy, dz) * sh
        tgt["shape"] = sh


def _handle_split(f, ctx):
    _do_split(f, ctx.bodies, ctx.find_body, ctx.active, ctx.new_body, ctx.datums)


def _handle_boolean(f, ctx):
    _do_boolean(f, ctx.bodies, ctx.find_body, diag=ctx.diagnostics)


def _handle_remove_body(f, ctx):
    # delete bodies by id (mainstream MCAD "Remove"); drop them from the list so
    # they're not tessellated/exported.
    ids = set(f.get("bodies") or [])
    # An id that matches nothing used to be ignored in silence, so a Remove whose
    # target had been renumbered by an upstream edit reported success having
    # deleted nothing — the timeline showed a healthy feature over a stale
    # reference. Name the ids instead.
    missing = sorted(ids - {b["id"] for b in ctx.bodies})
    if missing:
        raise ValueError(
            f"Remove: no such body {', '.join(missing)} — it may have been "
            "renumbered or consumed by an earlier feature"
        )
    ctx.bodies[:] = [b for b in ctx.bodies if b["id"] not in ids]


# type string -> handler. Unknown types are NOT in this dict — the rebuild loop
# below raises the exact same "unknown feature type" ValueError the old trailing
# `else` branch did.
_FEATURE_HANDLERS = {
    "sketch": _handle_sketch,
    "datumPlane": _handle_datum_plane,
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
    "sphere": _handle_sphere,
    "shell": _handle_shell,
    "offsetFace": _handle_offset_face,
    "thicken": _handle_thicken,
    "draft": _handle_draft,
    "texture": _handle_texture,
    "patternRect": _handle_pattern_rect,
    "patternLinear": _handle_pattern_linear,
    "patternCircular": _handle_pattern_circular,
    "simplifyMesh": _handle_simplify_mesh,
    "scale": _handle_scale,
    "move": _handle_move,
    "split": _handle_split,
    "boolean": _handle_boolean,
    "removeBody": _handle_remove_body,
}


def _make_val(params):
    """A value resolver over one document's parameter table: a parameter name
    resolves to its value; a numeric literal passes through.

    Any other string is a hard error: the frontend evaluates expressions and
    ships plain numbers, so an unresolved string here would otherwise leak
    into OCCT as garbage (crash or silent junk geometry). In rebuild() the
    raise is caught by the per-feature error handler -> red chip, build
    continues; project_geometry surfaces it as a per-source error entry."""

    def val(x):
        if isinstance(x, str):
            if x in params:
                return params[x]
            raise ValueError(
                f'unresolved parameter or expression "{x}" — expected a number '
                f"(expressions are evaluated by the app before building)"
            )
        return x

    return val


def rebuild(document, diagnostics=None, resume=None, snapshots_out=None, persist=None,
            projections=None, datums_out=None, sketch_planes_out=None):
    """Return (part, errors, bodies).

    part    : the merged build123d solid/compound of all bodies, or None.
    errors  : list of {feature_id, message}; a failing feature is recorded as a
              NO-OP and the build CONTINUES (MCAD-style — the timeline flags
              the feature red but everything after it still runs; one
              permanently-failing feature must not kill the rest of the
              document).
    bodies  : ordered list of {id, name, shape} — one per live body (for per-body
              tessellation and the browser tree).

    diagnostics : optional list; when given, low-confidence selector-v2 (`by:"match"`)
              resolutions append a ResolveDiag dict to it. Resolution is best-effort
              and never fails the build on a shaky match, so callers that don't pass a
              list are completely unaffected.

    datums_out : optional dict; filled with the RESOLVED plane of every datum
              feature, keyed by feature id. The frontend caches each datum's
              plane on the feature and draws its quad from that cache, so a datum
              that follows a face has to report where the face actually put it or
              the drawn plane and the plane sketches land on drift apart.

    sketch_planes_out : optional dict; filled with the plane the build actually
              used for every sketch that FOLLOWS a face, keyed by feature id.
              Same reason as datums_out one paragraph up: the frontend places a
              sketch from the cache frozen at pick time, and a sketch that has
              followed its face is no longer there. Only moved sketches appear,
              so an absent id means "the cache is still right".

    projections : optional list; when given, each sketch handler re-resolves its
              projected entities against the prefix state and appends refresh
              entries (see _recompute_projections). Steady state appends NOTHING —
              that convergence contract is what terminates the frontend's
              associative refresh loop.

    Incremental-rebuild hooks (both default off → identical to a plain full rebuild):
      resume        : (start_index, snapshot) — restore the build state captured
                      after feature[start_index-1] and run only features[start_index:].
      snapshots_out : if a list is given, append (feature_index, snapshot) after each
                      successfully-built feature, so a caller can cache per-feature
                      state and resume from the longest unchanged prefix next time.
    A snapshot copies the body dicts (sharing OCCT shape refs — no geometry copy) plus
    the sketches/datums/id-counter, and is restored by mutating those containers IN
    PLACE so the new_body/active/find_body closures stay bound to them.
    """
    params = document.get("parameters", {})
    # Bodies the user has hidden — excluded from extrude booleans (never edit a
    # hidden body). Ids are positional (regenerated each rebuild) but deterministic,
    # so they line up with the frontend's visibility map for this same document.
    hidden_bodies = frozenset(
        bid for bid, vis in (document.get("bodyVisibility") or {}).items() if not vis
    )

    val = _make_val(params)

    sketches = {}
    datums = {}  # datumPlane feature id -> PlaneSpec (resolved lazily by _plane_of)
    sketch_planes = {}  # sketch feature id -> the face-followed PlaneSpec it used
    bodies = []  # ordered [{id, name, shape}]
    counter = {"n": 0}
    errors = []

    def new_body(shape, name=None, node_ref=None):
        counter["n"] += 1
        entry = {
            "id": f"body{counter['n']}",
            "name": name or f"Body{counter['n']}",
            "shape": shape,
        }
        # Which assembly-tree node this body came from, as "<featureId>/<index>".
        # Set only for manifest-bound imports, and omitted (not None) otherwise so
        # every other body dict is byte-identical to what it was before.
        if node_ref:
            entry["node_ref"] = node_ref
        bodies.append(entry)
        return bodies[-1]

    def active():
        return bodies[-1] if bodies else None

    def require_active(label):
        """The active body, or a clear error — for features that modify an
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
        OCCT shape refs — no geometry is copied. sketches/errors/diagnostics are
        APPEND-ONLY write-once registries within a run, so a snapshot stores a
        REFERENCE to the run's registry plus a high-water mark; _restore copies the
        prefix below the mark once. Copying whole registries per snapshot was O(N²)
        over a rebuild."""
        return {
            "bodies": [dict(b) for b in bodies],
            "sketches_ref": sketches, "n_sketches": len(sketches),
            "datums": {k: dict(v) for k, v in datums.items()},
            # The plane each face-anchored sketch actually resolved to. It rides
            # with the snapshot for the same reason `datums` does, and for one
            # more: the disk-resume path REPLAYS the prefix's sketches, and a
            # replay has no bodies to resolve a face against. Without this a
            # resumed build would rebuild those sketches on their stale cached
            # plane while a full build put them on the face — the same document
            # giving two different solids depending on the cache.
            "sketch_planes": {k: dict(v) for k, v in sketch_planes.items()},
            "n": counter["n"],
            # errors travel with the snapshot: an incremental resume PAST a failed
            # feature must still re-report its error (else the banner would clear
            # while the feature is still broken)
            "errors_ref": errors, "n_errors": len(errors),
            # diagnostics travel for the SAME reason, and it is not cosmetic: the
            # frontend offers "Re-pick face" only when the build carries an
            # `ambiguous nearest pick` diagnostic, so a resume that replayed the
            # error without it left the user a dead-end toast on every reopened
            # document. `diagnostics` is None for callers that don't collect them
            # (exports, interference) — those still resume, so guard it.
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
        counter["n"] = snap["n"]
        err_src = snap["errors_ref"]
        if err_src is not errors:
            errors[:] = [dict(e) for e in err_src[: snap["n_errors"]]]
        else:
            del errors[snap["n_errors"]:]
        # same two branches as errors: a snapshot from a PREVIOUS run (RAM cache)
        # or from disk holds a foreign list, so copy its prefix in; a same-run
        # snapshot already shares the list, so just truncate to the mark. A
        # snapshot taken before diagnostics were collected has none to restore.
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
        if snap.get("replay_sketches") and start > 0:
            # disk checkpoints persist bodies/datums/errors but NOT the sketch
            # registry (build123d rehydration is unproven; sketches are cheap:
            # 0.19 s total on the 125-feature doc). Replay them instead — sound
            # because _build_sketch reads only params + the datums registry
            # (write-once, id-keyed, fully restored), never body geometry.
            for f2 in features[:start]:
                if f2.get("type") == "sketch":
                    try:
                        sketches[f2["id"]] = _build_sketch(
                            f2, val, datums, plane=sketch_planes.get(f2["id"]))
                    except Exception:
                        pass  # its failure is already in the restored errors

    # One context, built once per rebuild, handed to every feature handler below
    # (see _RebuildCtx) — bundles the exact closures/containers the old inline
    # if/elif chain closed over.
    ctx = _RebuildCtx(
        val=val, datums=datums, sketches=sketches, bodies=bodies,
        diagnostics=diagnostics, hidden_bodies=hidden_bodies,
        new_body=new_body, active=active, require_active=require_active,
        find_body=find_body, features=features, projections=projections,
        sketch_planes=sketch_planes,
    )

    for i in range(start, len(features)):
        f = features[i]
        t_feat = time.monotonic()
        # provenance: capture each body's shape identity + owner map before the
        # feature, so afterwards we can attribute newly-created faces to it.
        # sketch/datumPlane never touch bodies — skip capture AND attribution
        # for them (the eager owners merge alone was O(total faces) per feature,
        # 12.7% of a cold rebuild). The merged view is a lazy ChainMap over the
        # per-body dicts; reversed so duplicate fingerprints resolve like the
        # old last-body-wins dict.update() merge.
        prov = f.get("type") not in ("sketch", "datumPlane")
        if prov:
            pre_shape = {id(b): b.get("shape") for b in bodies}
            pre_owners_by_id = {id(b): (b.get("_owners") or {}) for b in bodies}
            pre_owners_all = ChainMap(*reversed(list(pre_owners_by_id.values())))
        try:
            t = f["type"]
            handler = _FEATURE_HANDLERS.get(t)
            if handler is None:
                raise ValueError(f"unknown feature type: {t}")
            handler(f, ctx)

        except ValueError as ex:  # name the feature so the timeline can flag it red
            # MCAD-style: a failed feature is a recorded NO-OP and the build
            # CONTINUES — the body state stays as it was and every feature after
            # it still runs. (It used to `break` here: one permanently-failing
            # feature — e.g. a deleteFace OCCT can't heal — silently killed the
            # whole downstream timeline, so nothing the user added after it ever
            # executed.) Owner attribution is skipped for the failed feature.
            # ValueErrors are hand-authored for users ("no edge found to
            # fillet", …) — surface them verbatim.
            errors.append({"feature_id": f.get("id"), "message": str(ex)})
        except Exception as ex:
            # Anything NOT a hand-authored ValueError is an unexpected internal
            # failure (OCCT crash, KeyError, …) — the raw message is meaningless
            # to a user, so surface the feature + exception type instead and log
            # the full traceback to stderr for debugging.
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
                persist, i, time.monotonic() - t_feat, bodies, datums, errors, counter,
                diagnostics, sketch_planes,
            )
        progress.feature_tick(i)  # this feature is done; the watchdog may relax

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
            # final pass only — mid-timeline drops would shift downstream
            # geometric selectors and delete chips a later join re-absorbs
            sh = _drop_debris(sh)
        entry = {"id": b["id"], "name": b["name"], "shape": sh,
                 "owners": b.get("_owners") or {},
                 "_textures": b.get("_textures")}
        # Rebuilt from an explicit key set, so anything new on the body dict has
        # to be listed here or it is silently dropped between rebuild and the
        # wire — which is how `_textures` was lost once already. Added only when
        # set, so a body from a non-assembly import stays byte-identical.
        if b.get("node_ref"):
            entry["node_ref"] = b["node_ref"]
        out_bodies.append(entry)

    shapes = [b["shape"] for b in out_bodies if b["shape"] is not None]
    if not shapes:
        part = None
    elif len(shapes) == 1:
        part = shapes[0]
    else:
        part = Compound(shapes)

    if datums_out is not None:
        datums_out.update(datums)
    if sketch_planes_out is not None:
        sketch_planes_out.update(sketch_planes)

    return part, errors, out_bodies


# --- incremental rebuild cache (persistent-worker-local) --------------------
# The sidecar runs one long-lived worker process, so a per-feature snapshot cache
# lives in its module memory and survives between rebuilds. On a worker respawn
# (25 s timeout / kernel crash → the pool recreates the worker) this module reloads
# and the cache is empty, so recovery is a clean full rebuild. Only rebuild_cached()
# touches it; plain rebuild() (used by export/interference) is unaffected.
_RAM_SNAP_WINDOW = int(os.environ.get("SINDRI_RAM_SNAP_WINDOW", "300"))


def rebuild_cached(document, diagnostics=None, projections=None, datums_out=None,
                   sketch_planes_out=None):
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
    gsig = _global_sig(document)
    store = _disk_store()
    keys = _chain_keys_scoped(document, new_sigs) if store is not None else []

    # RESUME CAP (projection soundness): when the caller collects projection
    # refresh entries, never resume PAST the first sketch carrying projected
    # entities. Emission is transient — an update from a previous build that the
    # frontend never applied (preview active, redo, doc reopened mid-refresh) is
    # not re-derivable from document state, so a deep resume would skip the
    # sketch handler and let a stale cached curve stick silently. Applies to
    # BOTH resume tiers. Callers without a projections list (aux ops, exports)
    # keep full-depth resume.
    #
    # QUIET-PROOF exception (RAM tier only — the steady-state perf escape):
    # when the PREVIOUS build in this worker ran a projection pass that emitted
    # NOTHING, it proved fresh == cached for every projected sketch it built —
    # and an unapplied pending diff is impossible after a quiet pass (pending
    # diffs re-emit on every build until applied). If the sigs through the
    # projected sketch are also unchanged (k > proj_cap covers indices
    # 0..proj_cap, including the sketch itself, so its inputs AND cached curves
    # are the proven ones), a deep resume is sound. Any emitting or
    # accumulator-less build clears the proof; disk tier and worker restarts
    # stay conservative (no proof survives them).
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
    if _CACHE["global_sig"] == gsig and _CACHE["snaps"]:
        old_sigs = _CACHE["feature_sigs"]
        k = 0
        while k < len(new_sigs) and k < len(old_sigs) and new_sigs[k] == old_sigs[k]:
            k += 1
        if proj_cap is not None and not (_CACHE.get("proj_quiet") and k > proj_cap):
            k = min(k, proj_cap)
        # snaps below the RAM retention window are None — fall through to disk
        if k > 0 and k - 1 < len(_CACHE["snaps"]) and _CACHE["snaps"][k - 1] is not None:
            resume = (k, _CACHE["snaps"][k - 1])  # restore state after feature k-1
    if resume is None and store is not None:
        # Checkpoint restore reads every prefix body from disk — on a large
        # document that is a long phase, and these two calls only bracket it.
        # Bracketing is NOT what keeps it alive: the gap the stall watchdog sees
        # is the one INSIDE, which is why _restore_from_disk ticks per body.
        progress_tick()
        hit = _restore_from_disk(store, keys if proj_cap is None else keys[:proj_cap])
        progress_tick()
        if hit is not None:
            start_i, snap, disk_mod = hit
            resume = (start_i, snap)
            from_disk = True

    persist = None
    if store is not None and features:
        persist = {"store": store, "keys": keys, "mod": dict(disk_mod),
                   "acc_ms": 0.0, "budget_ms": 1000.0}
        if resume is not None and not from_disk:
            # RAM resume: last-modifier keys for prefix bodies are unknown; stamp
            # them at the resume point. Same blob bytes under a fresh key — a
            # small dedup loss, never a correctness one.
            k0 = resume[0] - 1
            for b in resume[1]["bodies"]:
                if b.get("shape") is not None and k0 >= 0:
                    persist["mod"][b["id"]] = (b["shape"], _blob_key(keys[k0], b["id"]))

    t_build = time.monotonic()
    snaps_out = []
    # Diagnostic: WHERE the incremental resume started. resume_from == 0 (or src=full)
    # means the whole history replayed (checkpoint miss) — the usual cause of a
    # surprise multi-second rebuild; a high resume_from means only the tail features
    # (e.g. one expensive boolean) ran, so the cost is genuine OCCT geometry.
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
    )
    elapsed = time.monotonic() - t_build

    # Builds WITH feature errors are cached too: failed features are recorded
    # no-ops, snapshots carry the accumulated errors (so a resume past a broken
    # feature re-reports it), and OCCT failures are deterministic. Refusing to
    # cache here would force a slow full rebuild on EVERY edit of a document
    # with one permanently-failing feature.
    start = resume[0] if resume else 0
    if from_disk:
        merged = [None] * start  # no per-feature RAM snaps for the disk prefix
    else:
        merged = list(_CACHE["snaps"][:start])  # reused prefix
    merged.extend(snap for (_i, snap) in snaps_out)  # freshly built tail
    for j in range(0, max(0, len(merged) - _RAM_SNAP_WINDOW)):
        merged[j] = None  # bound RAM; disk checkpoints cover the deep prefix
    _CACHE = {"feature_sigs": new_sigs, "snaps": merged, "global_sig": gsig,
              # quiet-proof for the next build's resume-cap decision (see above);
              # missing key (worker restart, Compute All reset) reads falsy =
              # conservative
              "proj_quiet": projections is not None and not projections}

    # Tip checkpoint: make the just-built state instantly restorable by the next
    # process (app restart, worker respawn). The final snapshot carries exactly
    # the loop state to persist. Debounced by build cost — trivial warm edits
    # (<0.5 s) don't spam the store; anything that cost real time is worth the
    # ~15 ms/body write.
    if (persist is not None and merged and merged[-1] is not None
            and (elapsed >= 0.5 or persist["acc_ms"] >= 500.0)):
        tip = merged[-1]
        _save_checkpoint(
            persist, len(features) - 1, tip["bodies"], tip["datums"],
            tip["errors_ref"][: tip["n_errors"]], tip["n"],
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


# --- face provenance: which feature created/last-modified each face --------
# Lets the UI map a picked face back to its feature (click a chamfer face → select
# the chamfer). Each body carries `_owners`: {face-fingerprint → feature id}. After
# every feature we re-fingerprint the CHANGED bodies; a face whose fingerprint is new
# (not carried over from before) is attributed to the current feature, while
# unchanged faces keep their owner. A move transforms the fingerprint keys so
# provenance survives it. Fingerprint = (area, centre) quantized.

def _update_owners(f, val, bodies, pre_shape, pre_owners_by_id, pre_owners_all):
    """Attribute each face of every CHANGED body to a feature. Unchanged bodies (same
    shape object) keep their owners untouched — bounding the cost to what moved."""
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
            continue  # unchanged this feature — keep prior owners
        prior = pre_owners_by_id.get(bid, {})
        if trsf is not None and b.get("id") in move_ids and prior:
            prior = {_move_fp(k, trsf): v for k, v in prior.items()}  # follow the move
        owners = {}
        for fp in _shape_face_fps(sh):
            owners[fp] = prior.get(fp) or pre_owners_all.get(fp) or fid
        b["_owners"] = owners


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
    _entity_edges' deterministic order as source.index — the authoritative
    correspondence, stable across sibling deletions AND source moves. A
    multi-edge sibling WITHOUT an index is unresolvable -> stale, like an
    unknown source kind. An index beyond the fresh edge count means that
    edge is gone -> stale.

    Silhouette correspondence: a silhouette source has NO per-curve selectors —
    the source is the whole body, and the fresh HLR curve LIST can change count
    and order across rebuilds. Each group's siblings (shortlex id order) are
    matched against the fresh list in three passes, each fresh curve consumed
    at most once: (1) cached-curve match within _curve_close tolerance (steady
    state); (2) NEAREST same-kind curve by _curve_dist — endpoint + midpoint
    distance, pairs consumed in globally ascending order — so a resized
    cylinder's silhouette lines track their own side; (3) the remaining
    siblings positionally against the remaining fresh curves. Assigned curves
    are orientation-normalized to the cached endpoint order (_curve_oriented).
    Siblings beyond the fresh set go stale; fresh curves with no sibling are
    DROPPED (re-run the Project pick to pick up new outline curves — auto-add
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
    # _fresh_projection — siblings of one multi-edge source share the projected
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
    never reach here — their group-level correspondence runs in
    _recompute_projections."""
    src = e.get("source") or {}
    kind = src.get("kind")
    if kind in ("edge", "faceBoundary"):
        # faceBoundary persists PER-EDGE by:"match" sels too (see the pick site
        # in sketchMode.ts) — both kinds resolve via resolve_edges. LENIENT on
        # purpose: an upstream resize makes the fingerprint a "marginal match"
        # (length changed), which is exactly the association we must follow —
        # only a body/edge that no longer resolves AT ALL goes stale.
        body = ctx.find_body(src.get("body"))
        if body is None or body.get("shape") is None:
            return None
        edges = resolve_edges(body["shape"], src.get("sel"))
        if not edges:
            return None  # the source edge is gone — keep last shape
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


def _collect_datums(document):
    """The datumPlane registry for a document WITHOUT running a rebuild — datum
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
    """The projectGeometry aux-op: resolve each source against the PREFIX document
    (the frontend truncates at the sketch's timeline position) and project the
    resolved edges onto the target plane. Resolution is STRICT — a missing body/
    sketch/entity, a zero-edge or low-confidence selector match all produce a
    per-source error entry (pick time wants a clear refusal; the lenient
    keep-last-shape path is the rebuild refresh handler's job). Read-only:
    rebuild_cached gives warm prefix bodies without mutating anything.

    Returns {"results": [{source_index, ok, curves: [{fp?, curve}], error?}]}
    — `fp` (a sidecar-authored edge fingerprint for a by:"match" selector) only
    for body-edge sources; sketch curves are tracked by stable ids."""
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


def _require_body(bodies, bid):
    """The prefix body `bid` with live shape, or the strict pick-time refusal."""
    body = next((b for b in bodies if b["id"] == bid), None)
    if body is None or body.get("shape") is None:
        raise ValueError(
            f'source body "{bid}" is not available here — '
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
            f'source sketch "{src.get("sketch")}" is not available here — '
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
        # marginal path" — every diagnostic assertion in the suite keys on it.
        # Refusing on a merely non-empty `diag` was equivalent once, but it also
        # swept up advisory entries and turned a perfectly good pick into a hard
        # failure (see the note in geom_select._nearest_one).
        lossy = next((d for d in diag if d.get("lossy")), None)
        if lossy is not None:
            raise ValueError(
                "the source selection is ambiguous on this body — "
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
