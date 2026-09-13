"""Meshing bodies for the viewport: tolerances, the per-body payload and its caches, and the parallel helper pool."""

import hashlib
import multiprocessing as mp
import numpy as np
import occt_smp
import os
import plugin_geometry
import time


# Worker-global per-body mesh cache, validated by SHAPE OBJECT IDENTITY **and**
# tolerance: the cached entry holds a reference to the exact shape object it was
# computed from (which also keeps id() stable), so `entry["shape"] is body["shape"]`
# is a sound "nothing changed" test, snapshots share shape refs and every mutating
# feature rebinds the body's shape to a new object. Tolerance must also match: the
# same shape re-tessellated at a coarser/finer tolerance is a different payload, and
# shape identity alone would wrongly serve the wrong-resolution mesh. A hit skips
# BRepMesh readback, edge polylines, AND faceOwners fingerprinting for that body
# (the fixed ~1.4 s/edit).
_MESH_CACHE = {}


# Textured-face triangle budgets. Viewport stays interactive while scrubbing
# depth/scale; export gets much more headroom (per-face cap + a document-wide
# hard cap + a printable-sweet-spot warning, both applied in _export_job /
# _export_project_job below).
VIEWPORT_DENSITY_CAP = 80_000


# Below this, a mesh's tessellate+build cost doesn't recoup a disk write. An
# interactive param drag re-tessellates every tick with a brand-new content key
# (guaranteed cache miss on write AND on the next tick's read), writing every
# such tick to disk is pure churn for a payload that will almost never be read
# back. Mirrors the checkpoint-tip debounce in builder.py's rebuild_cached
# (trivial warm edits don't spam the store; anything that cost real time is
# worth the write).
_MESH_PERSIST_MIN_MS = 50.0


# Wire default (also the literal fallback in the "rebuild"/"computeAll" handlers
# below), the reference point our size-adaptive scaling is relative to.
_DEFAULT_TOLERANCE = 0.1


# The interactive viewport meshes with OCCT's RELATIVE deflection: chord tolerance
# as a fraction of each feature's own size, so a 1mm fillet gets a finer mesh than
# the 60mm face it sits on, exactly where faceting is visible.
#
# EXPORTS STAY ABSOLUTE (_EXPORT_TOL): a 3MF/STL for printing needs a deterministic
# chord error in millimetres. Hence `relative` is a per-call argument, not a switch.
#
# 0.001 was measured on a 60mm ring (5mm tall, 1mm fillet) plus a 6mm cube, a 400mm
# plate and a sphere:
#   * ring fillet deviation 0.152 -> 0.080mm (-48%) for +22% triangles and +5ms. At
#     MATCHED cost absolute is worse: 0.03mm gives 8472 tris at 0.098mm.
#   * 400mm plate: the 60mm hole goes 0.096 -> 0.053mm, triangles 164 -> 216.
#   * 6mm cube: 628 -> 7428 tris, 2.5 -> 12.0ms, fillet deviation 0.022 -> 0.006mm.
#     A 12x ratio at trivial absolute cost, triangle count tracking feature
#     complexity instead of part size is the POINT of relative deflection.
#   * bare sphere is the worst case (4002 -> 10108 tris, 17 -> 55ms), still well
#     inside the stall supervisor's budget.
_VIEWPORT_RELATIVE = True


_DEFAULT_RELATIVE_DEFLECTION = 0.002


# OCCT's ANGULAR deflection governs how faceted a fillet LOOKS: it caps the turn
# between adjacent facets. The old 0.5 rad let the worst adjacent-facet angle on a
# 1mm fillet reach 47 degrees, visible banding however fine the linear term got,
# because the tessellation is anisotropic (plenty of divisions AROUND a ring, almost
# none ACROSS the fillet, and only the angular term adds those).
#
# 60mm ring + 1mm fillet, worst angle / triangles / mesh time:
#     lin 0.001 ang 0.50   47.38deg    7992 tris    7.9ms   <- old
#     lin 0.001 ang 0.20   45.96deg   20284 tris   22.8ms
#     lin 0.002 ang 0.18    5.14deg   10640 tris   11.0ms   <- chosen
#     lin 0.002 ang 0.15    4.29deg   14784 tris   16.7ms
#     lin 0.001 ang 0.10    2.86deg   33264 tris   47.9ms
# 0.18 sits just past a sharp cliff and buys a 9x smoother fillet for +33%
# triangles. The linear term must NOT be over-tightened: lin 0.001 + ang 0.18 is
# WORSE than lin 0.002 at the same angle, because finer linear subdivision changes
# which criterion OCCT applies. Re-measure before touching either number.
_VIEWPORT_ANG_TOL = 0.18


# DOCUMENT-SIZE tolerance profile. A large assembly's reply has to fit the 128 MiB
# frame cap (a security control, see MAX_FRAME) and at shipping quality it does
# not: the 356 MiB reference assembly (3,071 bodies) yields 9,943,003 triangles and
# 263.3 MiB at 0.002/0.18, against 3,809,240 and 121.1 MiB at 0.008/0.35.
#
# The LINEAR term alone cannot do this, 4x coarser cut only 13% of the triangles,
# because the angular term binds. Same 60mm ring, worst adjacent-facet angle:
#     lin 0.002 ang 0.18    5.14deg   10,640 tris   <- shipping
#     lin 0.004 ang 0.26    7.35deg    5,488 tris
#     lin 0.008 ang 0.35   10.04deg    2,880 tris   <- large-document tier
# Coarsening the ANGULAR term costs 5.14 -> 10.04deg, not the 47deg the table above
# reads as implying (that row is lin 0.001, not 0.002). Still a real regression, so
# a document small enough to fit keeps full quality.
#
# Thresholds are anchored on the measured ~86 KiB/body at shipping quality. Body
# count is a PROXY, bodies vary enormously in face count, so _rebuild_job also
# guards the encoded reply against the cap rather than trusting this.
_VIEWPORT_SIZE_TIERS = (
    # (bodies at or above, linear scale on _DEFAULT_RELATIVE_DEFLECTION, angular)
    (2200, 4.0, 0.35),
    (1200, 2.0, 0.26),
)


def _viewport_profile(n_bodies):
    """(linear scale, angular tolerance) for a document of `n_bodies` bodies."""
    for threshold, scale, ang in _VIEWPORT_SIZE_TIERS:
        if n_bodies >= threshold:
            return scale, ang
    return 1.0, _VIEWPORT_ANG_TOL


def _effective_tolerance(shape, requested, size_scale=1.0):
    """Map the requested (interactive-viewport) wire tolerance to the value we
    actually hand BRepMesh, in the units the viewport's meshing mode expects.

    RELATIVE mode (_VIEWPORT_RELATIVE, the default): OCCT sizes the deflection
    per feature itself, so there is NO bbox term here, applying our own size
    scaling on top would double-count the very adaptivity we just delegated.

        effective = _DEFAULT_RELATIVE_DEFLECTION * (requested / DEFAULT_TOLERANCE)

    ABSOLUTE mode: scale the requested tolerance to this body's size, so a 500mm
    frame doesn't pay for a triangle budget tuned for a 5mm part and a 5mm part
    isn't left visibly faceted by a tolerance tuned for the frame.

        effective = clamp(diag / 2500, 0.05, 0.8) * (requested / DEFAULT_TOLERANCE)

    `diag` is the body's bounding-box diagonal (cheap OCCT bbox, no meshing).
    Dividing by 2500 makes a ~250mm-diagonal part (roughly the part the fixed
    0.1mm default was tuned for) land back on 0.1mm; the clamp keeps a 10mm
    bracket from going arbitrarily fine (0.05mm floor) and a multi-metre frame
    from going arbitrarily coarse (0.8mm ceiling).

    Either way the `requested / DEFAULT` factor keeps the wire contract intact: a
    client that asks for a smaller tolerance than the default still gets a
    proportionally finer mesh for every body. Deterministic, a pure function of
    (bbox, requested, size_scale), so cache keys built from the result stay
    stable.

    `size_scale` is the document-size coarsening from _viewport_profile: 1.0 for
    a document that fits the frame cap at full quality, higher for one that does
    not. It multiplies the deflection in BOTH modes."""
    scale = (requested / _DEFAULT_TOLERANCE if _DEFAULT_TOLERANCE else 1.0) * size_scale
    if _VIEWPORT_RELATIVE:
        return _DEFAULT_RELATIVE_DEFLECTION * scale

    from tessellate import bbox

    bb = bbox(shape)
    dx = bb["max"][0] - bb["min"][0]
    dy = bb["max"][1] - bb["min"][1]
    dz = bb["max"][2] - bb["min"][2]
    diag = (dx * dx + dy * dy + dz * dz) ** 0.5
    base = min(max(diag / 2500.0, 0.05), 0.8)
    return base * scale


def _union_bbox(boxes):
    """Union of {"min":[x,y,z],"max":[...]} boxes, or None if there are none.

    This replaces a single bbox(merged_compound) call. That call was ONE OCCT
    walk over every solid with no way to tick inside it, measured 95.3 s on the
    356 MiB reference assembly against STALL_TIMEOUT = 60 s, so the supervisor
    reaped the worker before the rebuild could finish, every time. The union is
    exactly equivalent (`part` is the Compound of the same shapes) but is
    accumulated per body, where _body_payload's own progress tick covers it."""
    present = [bb for bb in boxes if bb is not None]
    if not present:
        return None
    return {
        "min": [min(bb["min"][i] for bb in present) for i in range(3)],
        "max": [max(bb["max"][i] for bb in present) for i in range(3)],
    }


# The payload of the first body in a reply that uses each shared B-rep shape,
# keyed by that shape plus everything else the payload depends on. An imported
# assembly is mostly instances, a screw placed forty times is one TShape at forty
# Locations, and every one of them used to be read back node by node, given
# normals, banded and edge-sampled from scratch. Cleared per reply, so it never
# holds a shape the document no longer has.
_INSTANCE_PAYLOADS = {}


def _instance_key(sh, tolerance, profile):
    """(key, placement) for a body whose payload can be moved from another
    instance, or (None, None). Mirrored or scaled placements are left out: a
    mirror flips triangle winding and a scale stretches normals."""
    try:
        w = sh.wrapped
        trsf = w.Location().Transformation()
        if trsf.IsNegative() or abs(trsf.ScaleFactor() - 1.0) > 1e-12:
            return None, None
        return (w.TShape(), w.Orientation(), tolerance, profile), trsf
    except Exception:
        return None, None


def _moved_payload(src, src_trsf, trsf, body_id, face_owners):
    """`src`, a payload computed for the instance placed at `src_trsf`, carried
    to the instance placed at `trsf`. Topology-indexed fields are shared as-is."""
    from tessellate import mesh_bbox

    rel = trsf.Multiplied(src_trsf.Inverted())
    M = np.array([[rel.Value(r, c) for c in range(1, 5)] for r in range(1, 4)])
    R, t = M[:, :3], M[:, 3]
    out = dict(src)
    pos = np.asarray(src["positions"], dtype=np.float64).reshape(-1, 3) @ R.T + t
    out["positions"] = pos.ravel().tolist()
    if src.get("normals") is not None:
        out["normals"] = (np.asarray(src["normals"], dtype=np.float64).reshape(-1, 3) @ R.T).ravel().tolist()
    edges = src.get("edges") or []
    if edges:
        counts = [len(e["points"]) for e in edges]
        pts = np.asarray([p for e in edges for p in e["points"]], dtype=np.float64) @ R.T + t
        pts = pts.tolist()
        moved, at = [], 0
        for e, n in zip(edges, counts):
            moved.append({**e, "points": pts[at:at + n], **({"body": body_id} if "body" in e else {})})
            at += n
        out["edges"] = moved
    out["faceOwners"] = face_owners
    out["bbox"] = mesh_bbox(None, out["positions"])
    return out


def _mesh_key(b, tolerance, ang_tol, pass_key):
    """The disk mesh-artifact key for a body at an EFFECTIVE tolerance, or None."""
    mk = b.get("meshKey")
    if not mk:
        return None
    # The mode marker ("r"/"a") and tessellate.CODE_VERSION both ride in the
    # key: a relative deflection and an absolute one are different units that
    # could otherwise collide on the same number, and a payload cached by an
    # older edge/mesh algorithm must never be served after this module
    # changes (the disk artifact carries the EDGE polylines too).
    from tessellate import CODE_VERSION as _tess_ver
    key = "%s-tv%d-%s%s-a%s" % (mk, _tess_ver,
                                "r" if _VIEWPORT_RELATIVE else "a", tolerance,
                                ang_tol)
    if pass_key:
        key += "-x%s" % hashlib.sha1(pass_key.encode()).hexdigest()[:16]
    return key


def _compute_payload(bid, sh, owners_map, passes, tolerance, profile):
    """Mesh one body and gather everything its render payload carries. Pure in
    its arguments, which is what lets a helper process run it (_parallel_payloads).
    `owners_map` None leaves faceOwners out, for the caller to fill in where the
    face fingerprints are already memoized."""
    from tessellate import tessellate, edge_polylines_by_body, mesh_bbox
    from builder import _face_fp

    ang_tol = profile[1]
    # True surface normals ride the payload at shipping quality (see
    # tessellate._display_face for what they fix). They add 12 bytes a
    # vertex, so the coarsened large-document tiers, which exist only to fit
    # the frame cap, leave them out and keep client-side normals, unless a
    # mesh pass needs them for its displacement.
    norm_chunks = [] if (passes or profile[0] == 1.0) else None
    pos, idx, fids = tessellate(sh, tolerance, angular_tolerance=ang_tol,
                                mesh_passes=passes,
                                density_cap=VIEWPORT_DENSITY_CAP,
                                normals_out=norm_chunks,
                                relative=_VIEWPORT_RELATIVE)
    face_owners = (None if owners_map is None
                   else [owners_map.get(_face_fp(face)) for face in sh.faces()])
    # Two-tone inlay preview: dense per-face palette-slot array, same
    # sh.faces() enumeration the fid convention uses. Sparse-by-convention,
    # None (omitted key) when no pass on this body tagged a face.
    #
    # `colorSlot` is read off whatever spec covers the face, whichever
    # plugin put it there. That generality is the point: the payload field
    # was called textureColorSlots and this branch tested for textures, so
    # the one plugin that happened to exist was the only one that could ever
    # paint an inlay.
    face_color_slots = None
    if passes:
        face_specs = {}
        for spec, faces in passes:
            for f in faces:
                face_specs[_face_fp(f)] = spec  # later feature wins, like tessellate
        face_color_slots = [(face_specs.get(_face_fp(face)) or {}).get("colorSlot")
                            for face in sh.faces()]
        if not any(s is not None for s in face_color_slots):
            face_color_slots = None
    edges = edge_polylines_by_body([{"id": bid, "shape": sh}])
    for e in edges:
        e.pop("id", None)  # ids are assigned client-side after assembly
    # Runs of faces that are pieces of one surface the kernel could not
    # store as one, so a pick on one of them takes the whole run. Computed
    # beside faceOwners because both walk sh.faces() and both belong to the
    # payload the disk artifact caches (hence the CODE_VERSION bump).
    import face_bands as _face_bands
    bands = _face_bands.face_bands(sh)
    payload = {
        "positions": pos, "indices": idx, "faceIds": fids,
        "faceOwners": face_owners, "edges": edges,
        "faceCount": (max(fids) + 1) if fids else 0,
        # The box of the vertices just produced, stored in the payload so
        # the disk mesh artifact carries it too, a cache hit must not fall
        # back to a different box and make the camera jump between runs.
        "bbox": mesh_bbox(sh, pos),
    }
    if bands:
        payload["faceBands"] = bands
    if face_color_slots:
        payload["faceColorSlots"] = face_color_slots
    if norm_chunks:
        # Every face normally contributes a chunk (its true surface normals,
        # a displaced face its plugin's), so the chunks tile the whole vertex
        # range. The area-weighted accumulation the client would compute is
        # only the floor under a face that produced no chunk.
        covered = sum(len(chunk) for _vbase, chunk in norm_chunks)
        if covered == len(pos):
            norms = [0.0] * len(pos)
        else:
            from tessellate import vertex_normals
            norms = vertex_normals(pos, idx)
        for vbase, chunk in norm_chunks:
            norms[vbase * 3:vbase * 3 + len(chunk)] = chunk
        payload["normals"] = norms
    return payload


# Payloads computed ahead of the payload loop by helper processes, body id ->
# (payload, build ms). Filled and drained within one reply.
_PRECOMPUTED = {}


# Parallel payloads only pay for their helpers' start-up (each imports OCCT and
# build123d, about 2 s) on a big enough job. Faces are the proxy for the work:
# the SV08 printer's 446 unique bodies are 43k faces and about 60 s serial.
_PARALLEL_MIN_FACES = 6000


_PARALLEL_MAX_HELPERS = 12


# Resident memory one helper costs with OCCT loaded and a large body in hand:
# measured 484 MiB peak meshing the SV08 printer's largest parts.
_HELPER_BYTES = 512 << 20


def _payload_helper_init(threads):
    os.environ["VERXA_THREADS"] = str(threads)
    occt_smp.configure()


def _payload_in_helper(bid, data, tolerance, profile):
    import geomstore
    from shape_util import _wrap_topods

    t0 = time.monotonic()
    sh = _wrap_topods(geomstore.deserialize_shape(data))
    payload = _compute_payload(bid, sh, None, None, tolerance, profile)
    return bid, payload, (time.monotonic() - t0) * 1000.0


def _parallel_payloads(bodies, tolerance, profile):
    """Compute, in helper processes, the payloads the loop in _rebuild_job would
    otherwise build one after another under the GIL: bodies with no RAM entry,
    no disk artifact and no mesh pass, one per shared shape (the rest are moved
    from it). Anything that fails here is simply left for that loop."""
    from concurrent.futures import ProcessPoolExecutor, as_completed

    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedMapOfShape

    import geomstore
    import progress
    import sysmem

    _PRECOMPUTED.clear()
    cpus = os.cpu_count() or 1
    if cpus < 4:
        return
    store = geomstore.default_store()
    todo, seen, faces_total = [], set(), 0
    for b in bodies:
        sh = b.get("shape")
        if sh is None or plugin_geometry.cache_key(b):
            continue
        ent = _MESH_CACHE.get(b["id"])
        if (ent is not None and ent["shape"] is sh and ent["requested"] == tolerance
                and ent.get("profile") == profile and not ent.get("pass_key")):
            continue
        eff = _effective_tolerance(sh, tolerance, profile[0])
        key = _mesh_key(b, eff, profile[1], "")
        if key and os.path.exists(store._mesh_path(key)):
            continue
        inst, _trsf = _instance_key(sh, eff, profile)
        if inst is not None:
            if inst in seen:
                continue
            seen.add(inst)
        fmap = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(sh.wrapped, TopAbs_FACE, fmap)
        todo.append((fmap.Extent(), b, eff))
        faces_total += fmap.Extent()
    if faces_total < _PARALLEL_MIN_FACES:
        return
    helpers = min(_PARALLEL_MAX_HELPERS, cpus // 2, len(todo))
    avail = sysmem.available_bytes()
    if avail is not None:
        helpers = min(helpers, avail // _HELPER_BYTES)
    if helpers < 2:
        return
    todo.sort(key=lambda row: -row[0])
    t0 = time.monotonic()
    first = None
    t_sub = work_ms = 0.0
    try:
        with ProcessPoolExecutor(max_workers=helpers, mp_context=mp.get_context("spawn"),
                                 initializer=_payload_helper_init,
                                 initargs=(max(1, cpus // helpers),)) as pool:
            futures = [
                pool.submit(_payload_in_helper, b["id"], geomstore.serialize_shape(b["shape"]),
                            eff, profile)
                for _n, b, eff in todo
            ]
            t_sub = time.monotonic() - t0
            for fut in as_completed(futures):
                progress.progress_tick()
                if first is None:
                    first = time.monotonic() - t0
                try:
                    bid, payload, build_ms = fut.result()
                except Exception:
                    continue
                work_ms += build_ms
                _PRECOMPUTED[bid] = (payload, build_ms)
    except Exception as ex:
        print(f"[rebuild] parallel payloads stopped: {type(ex).__name__}: {ex}", flush=True)
    print("[rebuild] %d bodies (%d faces) meshed by %d helpers in %.1fs (submit %.1fs, first %.1fs, helper work %.1fs)"
          % (len(_PRECOMPUTED), faces_total, helpers, time.monotonic() - t0, t_sub, first or 0, work_ms / 1000), flush=True)


def _body_payload(b, tolerance, profile):
    """Compute (or fetch) the full render payload for one body: positions/indices/
    faceIds (LOCAL ids, offset client-side), faceOwners, per-body edges. Three
    tiers: identity-cached in RAM -> disk mesh artifact (load path: never pays the
    Python readback loop) -> compute + persist.

    `tolerance` is the RAW requested (wire) tolerance; it's immediately mapped
    through _effective_tolerance to the value BRepMesh actually gets, and every
    cache key below, RAM identity cache AND the disk mesh_key, is keyed on that
    EFFECTIVE value, never the raw request. Two bodies of different sizes (or one
    body whose bbox changed) must not share a cache slot keyed by a tolerance
    neither was actually tessellated at.

    A body's mesh also depends on the plugin mesh-pass specs stashed on it,
    which the shape identity check CANNOT see (a pass never mutates
    body["shape"], see plugin_geometry's module docstring). Both the RAM
    identity check and the disk mesh_key additionally key on a hash of that spec
    list, so scrubbing a pass-only parameter (a texture's depth/scale/…) can't
    serve a stale pre-edit mesh."""
    import pickle
    import uuid as _uuid

    from builder import _face_fp
    import progress

    bid, sh = b["id"], b.get("shape")
    requested = tolerance
    size_scale, ang_tol = profile
    # Each contributing pass's code version rides in the key: a plugin
    # algorithm update must not serve meshes displaced by the previous version
    # from the disk cache.
    pass_key = plugin_geometry.cache_key(b)
    ent = _MESH_CACHE.get(bid)
    # RAM hit BEFORE _effective_tolerance: it's a pure function of (shape,
    # requested), so identical shape identity + identical request imply an
    # identical effective tolerance, an unchanged body (the common case during
    # an interactive drag of some OTHER body) skips it (and, in absolute mode,
    # the OCCT bbox walk it does) instead of paying it on every tick.
    if (
        ent is not None
        and ent["shape"] is sh
        and ent["requested"] == requested
        and ent.get("profile") == profile
        and ent.get("pass_key") == pass_key
    ):
        return ent
    if sh is not None:
        tolerance = _effective_tolerance(sh, tolerance, size_scale)

    mesh_key = _mesh_key(b, tolerance, ang_tol, pass_key)
    payload = None
    if mesh_key:
        try:
            import geomstore
            rawp = geomstore.default_store().get_mesh(mesh_key)
            if rawp is not None:
                payload = pickle.loads(rawp)  # trusted local cache, worker-only
        except Exception:
            payload = None
    inst_key = inst_trsf = None
    if payload is None and sh is not None and not pass_key:
        inst_key, inst_trsf = _instance_key(sh, tolerance, profile)
        hit = _INSTANCE_PAYLOADS.get(inst_key) if inst_key is not None else None
        if hit is not None:
            owners_map = b.get("owners") or {}
            payload = _moved_payload(hit[0], hit[1], inst_trsf, bid,
                                     [owners_map.get(_face_fp(face)) for face in sh.faces()])
    if payload is None:
        got = _PRECOMPUTED.pop(bid, None)
        if got is not None:
            payload, build_ms = got
            owners_map = b.get("owners") or {}
            payload["faceOwners"] = [owners_map.get(_face_fp(face)) for face in sh.faces()]
        else:
            t0 = time.monotonic()
            payload = _compute_payload(bid, sh, b.get("owners") or {},
                                       plugin_geometry.resolve(b), tolerance, profile)
            build_ms = (time.monotonic() - t0) * 1000.0
        if inst_key is not None:
            _INSTANCE_PAYLOADS[inst_key] = (payload, inst_trsf)
        # Persist when the build was expensive OR the document is large. The
        # flat 50 ms rule was written for an interactive drag of a small model,
        # where re-tessellating one changed body every tick under a brand-new
        # content key is pure write churn. It reads very differently at scale:
        # 85% of the 3,072 bodies in the reference assembly build in under
        # 50 ms, so NONE of them were ever cached and every cold-worker open
        # re-tessellated the whole model, most of a 32.9 s payload phase that
        # actual disk loading accounts for only ~5 s of. profile[0] != 1.0 is
        # already the ">1,200 bodies" signal _viewport_profile computed, and a
        # document that large is not being scrubbed tick-by-tick anyway.
        if mesh_key and (build_ms >= _MESH_PERSIST_MIN_MS or profile[0] != 1.0):
            try:
                import geomstore
                geomstore.default_store().put_mesh(mesh_key, pickle.dumps(payload, 5))
            except Exception:
                pass
    # The document bbox is the union of these (see the payload loop), so it is
    # covered by this function's progress tick and reuses the cache on an
    # unchanged body, walking the merged compound was neither.
    ent = {"shape": sh, "requested": requested, "tolerance": tolerance,
           "profile": profile, "bbox": payload.get("bbox"),
           "etag": _uuid.uuid4().hex, "payload": payload, "pass_key": pass_key}
    _MESH_CACHE[bid] = ent
    progress.progress_tick()  # tessellation progress counts as progress
    return ent
