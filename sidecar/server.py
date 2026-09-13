"""FundaCAD geometry sidecar, WebSocket loop + dispatch.

Protocol: one JSON request/response per message, matched by `id`.
  rebuild -> tessellated mesh (+ per-tri faceIds) + edge polylines + bbox
  export  -> writes a STEP/STL/3MF file at the given path

Heavy geometry (rebuild + tessellate) runs in a separate worker **process**, not
on the asyncio event loop. Two reasons:
  * responsiveness, the socket keeps serving (pings, other connections) while a
    rebuild runs, instead of blocking the loop on a GIL-holding OCCT call;
  * robustness, OCCT lives in another process, so a kernel crash (segfault on a
    bad boolean) can't take the server down; the pool just respawns the worker.
ONE worker (max_workers=1), for reasons that are about correctness, not CPU
saturation: features form a serial dependency chain (no second rebuild can
usefully overlap), crash isolation needs a disposable process, and we use the
'spawn' start method because fork + OCCT's threads can deadlock. Meshing still
fans out across all cores per op (occt_smp.configure), but the boolean hot path
is deliberately SERIAL per-op (builder._serial_bool, parallel BOP measured
~5x slower on many-small-tool fuses), so idle cores during a long rebuild are
expected, not a lost opportunity (audited 2026-07-25: parallel body chains /
speculative tessellation refuted, see .fable/parallelism-audit-2026-07-25.md).

Lifecycle: on Linux we ask the kernel to SIGTERM us if our parent (the Tauri
shell) dies (PR_SET_PDEATHSIG), so we never orphan. We print `LISTENING <port>`
on stdout once bound, which the Rust shell waits for before opening the webview.
"""

import asyncio
import ctypes
import hashlib
import hmac
import json
import multiprocessing as mp
import os
import re
import secrets
import signal
import sys
import threading
import time
import traceback
import urllib.parse
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import numpy as np

import websockets

import appenv
import live_session
import occt_smp
import plugin_geometry

HOST = "127.0.0.1"
# Env-overridable so a test/benchmark instance can run beside the app's own
# sidecar without stealing its port.
PORT = int(appenv.get("SIDECAR_PORT", "8765"))

# Exit status for "could not bind the port". A contract with the Rust shell:
# src-tauri/src/sidecar.rs `describe_exit` turns it into a message that names the
# port instead of the useless "exit code 1". Do not reuse this code for anything else.
EXIT_PORT_IN_USE = 3

# Every connection needs the per-launch token (FUNDACAD_SIDECAR_TOKEN, or minted and
# printed as `TOKEN <t>`). There is no open mode.
_TOKEN: str | None = None

# A foreign Origin is refused even with the token; no Origin (a non-browser client) is allowed.
ALLOWED_ORIGINS = {
    "tauri://localhost",       # Linux (WebKitGTK) + macOS (WKWebView)
    "http://tauri.localhost",  # Windows WebView2 (useHttpsScheme off, the default)
    "https://tauri.localhost", # Windows WebView2 with useHttpsScheme on
    "http://localhost:5173",
    "http://127.0.0.1:5173",
}
# Headless/browser e2e harnesses run vite on a side port; let the launcher
# (which already controls the token) extend the allowlist explicitly.
ALLOWED_ORIGINS |= {o for o in appenv.get("EXTRA_ORIGINS", "").split(",") if o}

# Per-peer-IP concurrent-connection cap. The sidecar is bound to 127.0.0.1, so
# every connection shares that address and this is effectively a global cap on
# open sockets, it stops a runaway/leaky client (or a token holder stuck in a
# reconnect loop) from exhausting file descriptors. The legit webview holds 1, 2.
MAX_CONNS_PER_IP = 8
_ip_conns: dict[str, int] = {}

# A single geometry op (rebuild/tessellate/export) must finish within this many
# seconds. OCCT can spin forever or segfault on degenerate input (e.g. a face
# offset that collapses a hole); the timeout + worker recycling turns that into a
# clean, recoverable error instead of a frozen app.
JOB_TIMEOUT = 25.0
# Whole-history ops are supervised by progress (STALL_TIMEOUT), not a wall clock. That
# holds while their silent phases stay short (a 48 MB STEP write is 2.8 s). `import`
# keeps a wall-clock budget: OCP holds the GIL for the whole read.

# Import phase labels and their share of the wall clock, measured on the 356 MiB
# reference STEP: read+convert 90.6 s, canonicalize 93.9 s, encode 7.3 s.
# Mirrors builder.IMPORT_PHASE_* codes.
_IMPORT_PHASES = (
    ("Reading file", 0.47),
    ("Simplifying faces", 0.49),
    ("Packaging", 0.04),
)

# Re-exported for tests and tools. Patch these on their own module; rebinding
# `server.x` changes nothing the code reads.
import wire
from wire import (  # noqa: F401
    _CANCEL,
    _body_wire_size,
    _cancelled_result,
    _chunk_bodies,
    _encode_binary_reply,
    _err,
    _manifest_entry,
    _ok,
    _pack_edges,
    _reply_bytes,
    _reply_for,
    _send_reply,
    _stream_binary_reply,
    _too_large_error,
)
from viewport_mesh import (  # noqa: F401
    VIEWPORT_DENSITY_CAP,
    _DEFAULT_RELATIVE_DEFLECTION,
    _DEFAULT_TOLERANCE,
    _HELPER_BYTES,
    _INSTANCE_PAYLOADS,
    _MESH_CACHE,
    _MESH_PERSIST_MIN_MS,
    _PARALLEL_MAX_HELPERS,
    _PARALLEL_MIN_FACES,
    _PRECOMPUTED,
    _VIEWPORT_ANG_TOL,
    _VIEWPORT_RELATIVE,
    _VIEWPORT_SIZE_TIERS,
    _body_payload,
    _compute_payload,
    _effective_tolerance,
    _instance_key,
    _mesh_key,
    _moved_payload,
    _parallel_payloads,
    _payload_helper_init,
    _payload_in_helper,
    _union_bbox,
    _viewport_profile,
)

# A job is reaped only after STALL_TIMEOUT without a heartbeat (per feature and per body).
STALL_TIMEOUT = 60.0

# the worker-process pool; set in main(). Heavy ops are dispatched here.
_pool: ProcessPoolExecutor | None = None
_mp_ctx = None  # the 'spawn' context, kept so we can rebuild the pool after a crash
_HB = None  # shared heartbeat counter (multiprocessing.Value), set in main()
_HB_IDX = None  # feature index the worker last started (Value 'q'; -1 = meshing/none)
# Meshing progress, apart from _HB_IDX so the timeline can show a fraction. -1 when idle.
_HB_MESH = None       # bodies meshed so far (Value 'q')
_HB_MESH_TOTAL = None  # bodies to mesh in this pass (Value 'q')

# --- pool bring-up health --------------------------------------------------
# A worker dying at startup (a broken install) and one crashing on a shape raise the
# same BrokenProcessPool; the warm-up future tells them apart (_worker_came_up).
MAX_INIT_ATTEMPTS = 2  # the original bring-up plus one retry for a real transient

_INIT_ERR = None  # shared buffer; the worker writes its startup traceback here
_WORKER_ERR_BUF = None  # worker-side handle on that buffer (set in _worker_init)
_pool_gen = -1  # bumped per pool; the idempotency key for one bring-up attempt
_warm = None  # (generation, Future) for the CURRENT pool's warm-up
_failed_gens: set = set()  # generations whose worker never finished _worker_init
_reaped_gens: set = set()  # generations WE killed (timeout/stall), not init failures
_ever_came_up = False  # a worker started successfully at least once this session
_env_broken = False  # latched: the worker cannot start on this machine

_pool_src = None  # source stamp the CURRENT pool's worker was started from

_SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))


def _src_stamp(directory=None):
    """What the worker's copy of this package looked like when it imported it.

    A worker process imports every module in here ONCE, at spawn, and then lives
    for the rest of the session. Edit a file after that and the code on disk and
    the code doing the work disagree, silently and indefinitely: the fix is in
    the file, the failure is still in the process, and nothing anywhere says so.
    Measured on this repo the day the check was written, a thread that had just
    been fixed still failed in the running app twenty minutes later, and the only
    way to tell was to compare a file's mtime against a process's start time.

    So the pool carries a stamp of the sources it was built from, and
    _pool_available compares it. Size as well as mtime because a coarse
    filesystem clock can hand two edits the same second.

    Returns None when there is nothing here to watch, an unreadable directory,
    or one with no .py in it. Not the packaged app, which was the first guess and
    is wrong: the bundle copies sidecar/*.py next to a real interpreter, so the
    stamp is taken there too. It just never changes, an installed tree being
    read-only, so the cost is one scandir per job and no recycle ever.
    """
    try:
        with os.scandir(directory or _SIDECAR_DIR) as it:
            out = []
            for e in it:
                if not e.name.endswith(".py"):
                    continue
                st = e.stat()
                out.append((e.name, st.st_mtime_ns, st.st_size))
    except OSError:
        return None
    return tuple(sorted(out)) or None


def _watched_stamp():
    """Everything the worker imported that can go stale: this package, and the
    geometry of every installed plugin.

    Separate from _src_stamp because they are two trees with two answers, and
    because _src_stamp's contract is about the directory it is handed: a caller
    asking after an empty tree must still be told there is nothing to watch,
    rather than being handed some other tree's stamp.

    A plugin's geometry is code this same worker imported and has exactly the
    staleness problem the docstring above describes. Without watching it,
    editing a plugin's geometry during development changes nothing until the app
    is restarted, with nothing anywhere to say why.
    """
    own = _src_stamp()
    plug = plugin_geometry.source_stamp()
    if not plug:
        return own
    extra = tuple(("plugin:" + n, m, sz) for n, m, sz in plug)
    return tuple(sorted((own or ()) + extra)) or None


_INIT_FAIL_MSG = (
    "the geometry engine could not start on this computer, this is an "
    "installation or environment problem, not a problem with your model. "
    'Please use "Report a bug" with the engine log included: the log now '
    "carries the exact error."
)


# --- worker process (separate interpreter) ---------------------------------


def _worker_init(hb=None, hb_idx=None, err_buf=None, mesh=None, mesh_total=None):
    """Runs once when a worker process starts: die with the server (anti-orphan),
    pin OCCT to all cores, and warm the heavy imports so the first real rebuild
    isn't paying build123d's import cost. `hb` is the shared heartbeat counter;
    the rebuild loop bumps it per feature so the supervisor can distinguish a
    long build (fine) from a wedged one (reap). `hb_idx` carries WHICH feature
    is being built (-1 = tessellation), so the supervisor can stream progress
    frames to the frontend during a long build.

    `err_buf` is shared memory used to hand a STARTUP traceback back to the
    server. It is needed because CPython catches an initializer's exception in
    the CHILD, logs it to the child's stderr and returns, and on Windows the
    spawned worker does not inherit the Rust-owned stderr pipe, so that log goes
    nowhere. That is why field bug 8aa9ded7 arrived with no evidence at all.
    Shared memory crosses the boundary on every platform."""
    try:
        _die_with_parent()  # SIGTERM the worker if the server process dies
        # Publish the handles we were given as worker-side globals: _warmup and
        # anything else running in this process needs the error buffer, and the
        # parent's _HB/_HB_IDX are set in main(), which never runs in a spawned
        # worker (so these are None here without this).
        global _WORKER_ERR_BUF, _HB, _HB_IDX, _HB_MESH, _HB_MESH_TOTAL
        _WORKER_ERR_BUF, _HB, _HB_IDX = err_buf, hb, hb_idx
        _HB_MESH, _HB_MESH_TOTAL = mesh, mesh_total
        occt_smp.configure()
        # Before build123d: it scans system fonts at import and one unreadable file kills it.
        import font_guard

        font_guard.ensure()
        import builder  # noqa: F401  (warm the import)
        import tessellate  # noqa: F401

        # A spawned worker inherits no imports, so plugins register here.
        plugin_geometry.discover()
        loaded, broken = plugin_geometry.loaded_plugins(), plugin_geometry.broken_plugins()
        if loaded or broken:
            print(f"[plugin-geometry] loaded {loaded}"
                  + (f", broken {broken}" if broken else ""), flush=True)

        # Warm the OCCT font subsystem (~1.6 s cold on the first glyph build) at startup so
        # the user's first sketch-text/tessellateText isn't laggy.
        try:
            builder._text_faces({"text": "A", "height": 1}, lambda x: x)
        except Exception:
            pass

        # Bound the disk cache from free disk (Store.cache_budget), meshes first.
        try:
            import geomstore
            geomstore.default_store().evict_to_budget()
        except Exception:
            pass  # advisory maintenance must never stop a worker coming up

        if hb is not None:
            def _tick(i):
                hb.value += 1  # single writer (this worker); no lock needed
                if hb_idx is not None:
                    hb_idx.value = i

            import progress
            progress.on_feature_tick = _tick
    except BaseException:
        _publish_init_error(err_buf)
        # MUST re-raise: this is what breaks the pool. Swallowing it would leave
        # a worker with no `builder` accepting jobs, which fails per-operation
        # and looks exactly like the bug this whole path exists to end.
        raise


def _publish_init_error(err_buf):
    """Write the current exception into the shared buffer, EXCEPTION LINE FIRST.

    Both this buffer and the log tail a bug report carries keep the HEAD of what
    they are given, while a traceback's actual error is its LAST line, so the
    one line worth having is written first and the frames follow."""
    if err_buf is None:
        return
    try:
        summary = "".join(traceback.format_exception_only(*sys.exc_info()[:2])).strip()
        text = f"{summary}\n{traceback.format_exc()}"
        # Array('c') raises at exactly len(), so stop one short.
        err_buf.value = text.encode("utf-8", "replace")[: len(err_buf) - 1]
    except Exception:
        pass


def _warmup():
    """Submitted at pool creation to force the (lazy) worker to spawn and run
    _worker_init now, rather than on the user's first rebuild.

    It builds real geometry rather than returning a constant, because importing
    OCP is NOT the same test as OCP working: a wheel built for a newer
    instruction set, or a mismatched/delay-loaded TBB or TKernel, imports fine
    and then faults on the first kernel call. Classified as an op-crash, that
    told the user their sketch was degenerate and to try a different value,
    on an install where nothing would ever build. A box and one boolean cost a
    few ms on an already-cold path and put that failure in the init bucket,
    where it gets the environment diagnosis and the retry bound."""
    try:
        import builder  # noqa: F401
        from build123d import Box, Location

        solid = Box(1, 1, 1)
        cut = Box(0.5, 0.5, 2).moved(Location((0.25, 0.25, 0)))
        result = solid - cut
        if result.volume <= 0:
            raise RuntimeError("geometry self-test produced an empty solid")
    except BaseException:
        # Same channel as an initializer failure: this IS a bring-up failure,
        # it just happens one step later than the import.
        _publish_init_error(_WORKER_ERR_BUF)
        raise
    return True


EXPORT_DENSITY_CAP_PER_FACE = 200_000
EXPORT_TRIANGLE_HARD_CAP = 10_000_000
EXPORT_TRIANGLE_WARN = 500_000


# Export tessellation is absolute and finer than the viewport's, with its own cache.
_EXPORT_TOL = 0.02
_EXPORT_ANG_TOL = 0.3
_EXPORT_MESH_CACHE = {}  # body id -> {"shape", "pass_key", "positions", "indices"}


def _export_mesh(b, tol=None):
    """Export-grade (positions, indices) for one live body, three-tier cached
    (RAM identity -> disk artifact -> compute + persist), mirroring
    _body_payload. Worker-side only."""
    import pickle

    from tessellate import tessellate
    from progress import progress_tick

    # Unlike the viewport twin, this ticks on EVERY tier including a RAM hit,
    # not just the compute path: export walks every body in one uninterrupted
    # loop, so the guarantee worth having is one tick per body regardless of
    # which tier served it. A mixed warm/cold export is the common case.
    progress_tick()
    tol = _EXPORT_TOL if tol is None else tol
    bid, sh = b["id"], b["shape"]
    # Covers every plugin mesh pass on this body, each pass's own code version
    # included, so an algorithm change cannot be served a mesh its previous
    # version displaced. None when the body has no pass on it at all.
    pass_key = plugin_geometry.cache_key(b)
    ent = _EXPORT_MESH_CACHE.get(bid)
    # Tolerance is part of the key, or a coarser backoff retry gets the finer mesh back.
    if (ent is not None and ent["shape"] is sh
            and ent["pass_key"] == pass_key and ent["tol"] == tol):
        return ent["positions"], ent["indices"]
    # OCCT keeps a finer triangulation for a coarser request unless it is dropped first.
    retolerance = ent is not None and ent["shape"] is sh and ent.get("tol") != tol

    mesh_key = None
    if b.get("meshKey"):
        mesh_key = "%s-export-t%s" % (b["meshKey"], tol)
        if pass_key:
            mesh_key += "-x%s" % hashlib.sha1(pass_key.encode()).hexdigest()[:16]
    mesh = None
    if mesh_key:
        try:
            import geomstore
            raw = geomstore.default_store().get_mesh(mesh_key)
            if raw is not None:
                mesh = pickle.loads(raw)  # trusted local cache, worker-only
        except Exception:
            mesh = None
    if mesh is None:
        t0 = time.monotonic()
        passes = plugin_geometry.resolve(b)
        pos, idx, _fids = tessellate(
            sh, tolerance=tol, angular_tolerance=_EXPORT_ANG_TOL,
            mesh_passes=passes, density_cap=EXPORT_DENSITY_CAP_PER_FACE,
            force_remesh=retolerance,
        )
        mesh = (pos, idx)
        if mesh_key and (time.monotonic() - t0) * 1000.0 >= _MESH_PERSIST_MIN_MS:
            try:
                import geomstore
                geomstore.default_store().put_mesh(mesh_key, pickle.dumps(mesh, 5))
            except Exception:
                pass
    # Numpy, not lists: 48 MB against 313 MB for 2M triangles, held for the worker's life.
    positions = np.asarray(mesh[0], dtype=np.float64)
    indices = np.asarray(mesh[1], dtype=np.int32)
    _EXPORT_MESH_CACHE[bid] = {
        "shape": sh, "pass_key": pass_key, "tol": tol,
        "positions": positions, "indices": indices,
    }
    return positions, indices


# Filenames Windows refuses outright, in ANY case and with or without an
# extension: CON.step is as invalid as CON. A body legitimately named "Con" or
# "Aux" is not exotic in mechanical CAD ("auxiliary bracket"), and the failure
# is an opaque OS error at write time on one platform only.
_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

# Filesystems cap a name in BYTES, not characters: ext4 and APFS both stop at
# 255 bytes. `\w` is Unicode-aware, so a CJK or emoji body name survives
# sanitising and then blows the limit at about a third of the character count.
_MAX_NAME_BYTES = 200  # flat reserve for the extension and a dedup suffix


def _safe_part_filename(label, fallback):
    """A filesystem-safe stem for one exported body.

    Refuses nothing and raises nothing: every input yields SOME usable name, so
    an awkwardly-named body can never block an export of the others.
    """
    name = re.sub(r"[^\w.-]+", "_", str(label)).strip("_")
    if not name or set(name) <= {"."}:  # empty or dot-only → no dotfiles
        name = str(fallback)
    # Byte budget, trimmed on a CHARACTER boundary so the result stays valid
    # UTF-8, truncating the bytes directly can split a multi-byte codepoint.
    while len(name.encode("utf-8")) > _MAX_NAME_BYTES and len(name) > 1:
        name = name[:-1]
    name = name.rstrip("_.") or str(fallback)
    if name.split(".")[0].lower() in _WINDOWS_RESERVED:
        name = f"{name}_"
    return name


def _budget_refusal(ntri):
    """The refusal message past the triangle hard cap, or None while under it.

    ONE mechanism, because this had drifted into three: two raising sites and one
    returning an error dict, with the WARN threshold duplicated beside two of
    them and missing from the third, which is how exportProject came to have no
    budget at all. A new export format now cannot be added without it.

    Deliberately NOT worded "textured": since untextured stl/3mf was routed
    through this path too, the old message told someone exporting a plain
    3,000-body assembly to reduce a texture scale they were not using.
    """
    if ntri <= EXPORT_TRIANGLE_HARD_CAP:
        return None
    return (f"export too dense ({ntri:,}+ triangles), reduce texture scale or "
            f"depth, or export fewer bodies")


def _budget_warning(ntri):
    """The non-blocking 'very dense' warning, or None. Same single-source reason."""
    if ntri <= EXPORT_TRIANGLE_WARN:
        return None
    return f"export is very dense ({ntri:,} triangles)"


def _prune_export_cache(live):
    """Drop export-cache entries for deleted/consumed bodies, a stale entry
    pins its OCCT shape in RAM for the worker's lifetime."""
    ids = {b["id"] for b in live}
    for k in list(_EXPORT_MESH_CACHE):
        if k not in ids:
            del _EXPORT_MESH_CACHE[k]


def _set_mesh_progress(done, total):
    """Publish "meshed `done` of `total` bodies" to the supervisor, or (-1, -1)
    to say no meshing is in flight. Worker-side; a failure here must never break
    a rebuild, so every path is swallowed."""
    try:
        if _HB_MESH is not None:
            _HB_MESH.value = int(done)
        if _HB_MESH_TOTAL is not None:
            _HB_MESH_TOTAL.value = int(total)
    except Exception:
        pass


# The worker holds the document and applies {baseRevision, revision, ops}; any mismatch
# answers {"resync": true} and the client sends it whole once.
_DOC_STATE = {"rev": None, "doc": None}


def _apply_doc_ops(payload):
    """Apply a client delta to the held document, or adopt a full document.
    Returns the effective document, or None when a resync is needed."""
    if "document" in payload:
        _DOC_STATE["doc"] = payload["document"]
        _DOC_STATE["rev"] = payload.get("revision")
        return _DOC_STATE["doc"]
    if _DOC_STATE["doc"] is None or _DOC_STATE["rev"] != payload.get("baseRevision"):
        return None
    doc = _DOC_STATE["doc"]
    ops = payload.get("ops") or {}
    if "parameters" in ops:
        doc["parameters"] = ops["parameters"]
    if "bodyVisibility" in ops:
        doc["bodyVisibility"] = ops["bodyVisibility"]
    if "bodyIds" in ops:
        doc["bodyIds"] = ops["bodyIds"]
    if "length" in ops:
        feats = doc.get("features", [])
        del feats[ops["length"]:]
        while len(feats) < ops["length"]:
            feats.append(None)  # placeholder, must be covered by "set" below
        doc["features"] = feats
    for i, f in ops.get("set", []):
        doc["features"][i] = f
    if any(f is None for f in doc.get("features", [])):
        _DOC_STATE["doc"] = None  # hole the ops didn't fill, force resync
        return None
    _DOC_STATE["rev"] = payload.get("revision")
    return doc


def _err_wire(e):
    """Project an internal error dict to its wire shape, carrying the machine
    `code` only when the refusal set one (errors.py) so the frontend can branch
    on the category instead of matching the human message. Mirrors what
    ResolveDiag already does for recoverable diagnostics."""
    w = {"message": e["message"], "feature_id": e.get("feature_id")}
    if e.get("code"):
        w["code"] = e["code"]
    return w


def _rebuild_job(document, tolerance, known=None):
    """Worker: rebuild the document and tessellate. Returns a result dict; a
    feature failure comes back INSIDE the result as "featureError" (with the
    surviving geometry), or as {"error": {...}} only when nothing built at all.
    Args/return must stay picklable.

    Uses rebuild_cached (RAM prefix + durable disk checkpoints). The reply is
    protocol v2: PER-BODY payloads with etags. `known` maps body id -> etag the
    client already holds; a body whose payload is identity-cached under the same
    etag is answered with a stub ("unchanged") instead of its mesh, the client
    reassembles locally. Worker respawn empties the RAM caches, which simply
    downgrades every body to a full payload once."""
    from builder import rebuild_cached

    diag = []
    proj = []
    datums = {}
    sketch_planes = {}
    datum_marks = {}
    body_ids = {}
    known = known or {}
    t0 = time.monotonic()
    part, errors, bodies = rebuild_cached(
        document, diagnostics=diag, projections=proj, datums_out=datums,
        sketch_planes_out=sketch_planes, datum_marks_out=datum_marks,
        body_ids_out=body_ids,
    )
    new_ids = {"bodyIds": body_ids} if body_ids != document.get("bodyIds") else {}
    t_rebuild = time.monotonic() - t0
    if errors and part is None and not bodies:
        # nothing built at all, the document is unusable, surface as fatal
        return {"error": _err_wire(errors[0])}
    if part is None:
        # no solid yet (e.g. only sketches exist), not an error; the frontend
        # still renders sketch overlays. Projection refresh entries still ride
        # along (a sketchCurve source needs no body at all).
        result = {"protocol": 2, "bodies": [], "bbox": None, **new_ids}
        if proj:
            result["projectionUpdates"] = proj
        # Datums resolve without any solid (a document can be nothing but planes),
        # so they ride along on this path too.
        if datums:
            result["datumPlanes"] = datums
        if sketch_planes:
            result["sketchPlanes"] = sketch_planes
        # Datum axes/points that follow geometry resolve without a solid too (an
        # axis can follow an edge of a body that IS the only body). Same path.
        if datum_marks:
            result["datumMarks"] = datum_marks
        return result

    live_ids = set()
    out = []
    body_boxes = []
    t0 = time.monotonic()
    # One profile for the whole document: a big assembly is meshed coarser so its
    # reply fits the frame cap (see _VIEWPORT_SIZE_TIERS). Computed once, outside
    # the loop, so every body in one reply is meshed on the same terms.
    profile = _viewport_profile(len(bodies))
    if profile[0] != 1.0:
        print("[rebuild] %d bodies -> coarse viewport profile (x%.1f linear, ang %.2f)"
              % (len(bodies), profile[0], profile[1]), flush=True)
    # Announce the denominator BEFORE the loop so the very first progress frame
    # can already say "1 of 3071" rather than starting at an unknown total.
    n_to_mesh = sum(1 for b in bodies if b.get("shape") is not None)
    n_meshed = 0
    _set_mesh_progress(0, n_to_mesh)
    _INSTANCE_PAYLOADS.clear()
    _parallel_payloads(bodies, tolerance, profile)
    for b in bodies:
        if b.get("shape") is None:
            continue
        live_ids.add(b["id"])
        ent = _body_payload(b, tolerance, profile)
        n_meshed += 1
        _set_mesh_progress(n_meshed, n_to_mesh)
        body_boxes.append(ent.get("bbox"))
        # In the envelope, not the etag-cached payload, or it freezes with the geometry.
        node_ref = {"nodeRef": b["node_ref"]} if b.get("node_ref") else {}
        face_colors = {"faceColors": b["face_colors"]} if b.get("face_colors") else {}
        if b.get("part_color"):
            face_colors["partColor"] = b["part_color"]
        if known.get(b["id"]) == ent["etag"]:
            out.append({"id": b["id"], "name": b["name"], "etag": ent["etag"],
                        **node_ref, **face_colors, "unchanged": True})
        else:
            item = {"id": b["id"], "name": b["name"], "etag": ent["etag"],
                    **node_ref, **face_colors}
            item.update(ent["payload"])
            out.append(item)
    t_payload = time.monotonic() - t0
    _INSTANCE_PAYLOADS.clear()
    _PRECOMPUTED.clear()
    _set_mesh_progress(-1, -1)  # meshing done, stop claiming a denominator
    for bid in list(_MESH_CACHE):
        if bid not in live_ids:
            del _MESH_CACHE[bid]  # body deleted/consumed, drop its cache
    # The union of per-body boxes; walking the merged part took an untickable 95 s.
    t0 = time.monotonic()
    doc_bbox = _union_bbox(body_boxes)
    t_bbox = time.monotonic() - t0
    # Phase log for scale diagnosis (large assemblies): shows where a slow
    # build actually spends its time, and correlates with the stall watchdog.
    print(f"[rebuild] features={len(document.get('features', []))} "
          f"bodies={len(out)} rebuild={t_rebuild:.1f}s payloads={t_payload:.1f}s "
          f"bbox={t_bbox:.1f}s",
          flush=True)
    result = {"protocol": 2, "bodies": out, "bbox": doc_bbox, **new_ids}
    # Sent every rebuild: a few bytes, and no invalidation for the frontend to get wrong.
    if datums:
        result["datumPlanes"] = datums
    if sketch_planes:
        # Only the sketches that MOVED. An absent id means the document
        # cache is still where the build put it, which is what every
        # frontend reader already falls back to.
        result["sketchPlanes"] = sketch_planes
    if datum_marks:
        # Only the datums that FOLLOW geometry, and the frontend falls back to
        # the baked coordinate for every id absent here, the same as sketchPlanes.
        result["datumMarks"] = datum_marks
    if diag:  # only attach when a selector resolved with low confidence
        result["diagnostics"] = diag
    if proj:  # only attach when the projection refresh found real changes
        result["projectionUpdates"] = proj
    if errors:
        # The banner gets the most downstream error, the one nearest the user's latest edit.
        result["featureError"] = _err_wire(errors[-1])
        result["featureErrors"] = [_err_wire(e) for e in errors]
    return result


def _rebuild_delta_job(payload, tolerance, known=None):
    """Rebuild entry point for the delta wire protocol: adopt/patch the held
    document, or ask for a resync when we can't."""
    doc = _apply_doc_ops(payload)
    if doc is None:
        return {"resync": True}
    return _rebuild_job(doc, tolerance, known)


def _compute_all_job(payload, tolerance):
    """mainstream MCAD's 'Compute All' escape hatch: bypass and REBUILD every cache layer,
    RAM prefix snapshots, mesh cache, and this document's disk checkpoints and
    blobs (purged so a hypothetically poisoned blob can't survive put_blob's
    key-dedup skip). One full cold rebuild follows; all caches repopulate."""
    import builder

    document = _apply_doc_ops(payload)
    if document is None:
        return {"resync": True}
    builder.reset_cache()
    _MESH_CACHE.clear()
    try:
        import geomstore
        sigs = [builder._feature_sig(f) for f in document.get("features", [])]
        keys = builder._chain_keys_scoped(document, sigs)
        geomstore.default_store().purge(keys)
    except Exception:
        pass
    return _rebuild_job(document, tolerance)


def _export_job(document, fmt, path, body=None, separate=False,
                palette=None, body_colors=None):
    """Worker: rebuild + export. Default exports the merged part to `path`; `body`
    (a body id) exports just that body; `separate` writes EACH body to its own
    '<base>-<name>.<ext>'. Returns {"path"} (+ {"paths"} for separate) or {"error"}.

    Textured bodies can't go through build123d's BRep-native exporters.export()
    (texture is mesh-only, applied at tessellation time, see texture.py), so an
    STL/3MF target with a texture anywhere branches to tessellate()+mesh_writers
    at export grade instead; a document with NO textures takes the exact same
    export(...) calls as before, unchanged. STEP is BRep-only regardless,
    texture never reaches it, so a textured body exported as STEP gets a
    non-blocking warning instead of a silent drop."""
    import os
    import re
    from builder import rebuild_cached
    from exporters import export
    import mesh_writers

    # rebuild_cached, not rebuild: export runs in the SAME long-lived worker as
    # edits, so a warm cache makes this ~0 s instead of a gratuitous full rebuild
    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    _prune_export_cache(live)
    # Export what BUILT, and warn about what didn't, never silently. Refusing
    # to export ANYTHING because one feature errored blocked the whole
    # import-repair→print loop (one stubborn face held nine good bodies
    # hostage). Only a document where nothing built at all is a hard error.
    if errors and part is None and not live:
        e = errors[0]
        return {"error": _err_wire(e)}
    if part is None and not live:
        return {"error": {"message": "nothing to export, no bodies built yet"}}
    warnings = [
        _err_wire(e) for e in errors
    ]
    any_displaced = any(plugin_geometry.specs(b) for b in live)
    if fmt == "step" and any_displaced:
        # Named generically because the sentence has to stay true for whatever
        # plugin put the displacement there, not just the one that shipped first.
        warnings.append({
            "message": "surface displacement from a plugin is not represented "
                       "in STEP exports"
        })

    def _done(res):
        if warnings:
            res["warnings"] = warnings
        return res

    def _mesh_export(target_bodies, p):
        """Concatenate target_bodies into one merged, textured, export-grade mesh
        and write it via mesh_writers. Raises past the triangle hard cap, a
        document-wide safety net so a pathological scale/depth combo can't
        allocate an unbounded mesh."""
        pos_parts, idx_parts, vbase = [], [], 0
        ntri = 0
        for b in target_bodies:
            pos, idx = _export_mesh(b)
            # Per body, so the cap stops the allocation instead of reporting it afterwards.
            ntri += len(idx) // 3
            refusal = _budget_refusal(ntri)
            if refusal:
                raise ValueError(refusal)
            pos_parts.append(np.asarray(pos, dtype=np.float64))
            idx_parts.append(np.asarray(idx, dtype=np.int64) + vbase)
            vbase += len(pos_parts[-1]) // 3
        # A one-element concatenate copies the whole array a second time, and the
        # separate/single-body paths always hit that case.
        positions = (pos_parts[0] if len(pos_parts) == 1
                     else np.concatenate(pos_parts) if pos_parts else np.empty(0))
        mindices = (idx_parts[0] if len(idx_parts) == 1
                    else np.concatenate(idx_parts) if idx_parts
                    else np.empty(0, dtype=np.int64))
        warn = _budget_warning(ntri)
        if warn:
            warnings.append({"message": warn})
        if fmt == "stl":
            mesh_writers.write_stl(positions, mindices, p)
        elif fmt == "3mf":
            mesh_writers.write_plain_3mf(positions, mindices, p)
        else:
            raise ValueError(f"texture is not supported for {fmt} export")
        return p

    def _glb_export(target_bodies, p):
        """GLB sibling of _mesh_export: same export-grade meshes, but bodies are
        kept SEPARATE (one glTF node/mesh/material each) instead of merged, so
        every body keeps its name and its palette colour in a viewer.

        Routed here for textured AND untextured bodies alike. Deliberately never
        goes through exporters.export(): that path serialises body["shape"], and
        texture displacement lives only in the mesh, so a textured body would
        export silently untextured."""
        from project3mf import _norm_color

        pal = palette or []
        slots = body_colors or {}
        entries, ntri = [], 0
        for b in target_bodies:
            pos, idx = _export_mesh(b)
            ntri += len(idx) // 3
            # Same reason as _mesh_export: bound the allocation as it happens.
            # GLB keeps bodies SEPARATE, so without this a 3,000-body assembly
            # holds every mesh at once before anything is checked.
            refusal = _budget_refusal(ntri)
            if refusal:
                raise ValueError(refusal)
            slot = slots.get(b["id"], 0)  # unassigned -> slot 0, as the 3MF path does
            entry = pal[slot] if isinstance(slot, int) and 0 <= slot < len(pal) else None
            entries.append({
                "name": b.get("name") or b["id"],
                "positions": pos,
                "indices": idx,
                "color": _norm_color(entry.get("color")) if entry else None,
            })
        warn = _budget_warning(ntri)
        if warn:
            warnings.append({"message": warn})
        return mesh_writers.write_glb(entries, p)

    def _write_one_body(b, p):
        """ONE body to `p`, via whichever writer the format needs.

        Shared by the separate-bodies and single-body paths, which became
        identical once untextured stl/3mf stopped taking the bypass: the
        `b.get("_textures")` test was the only thing that had distinguished them.
        The whole-document path stays separate, it genuinely differs (STEP tree,
        fused part)."""
        if fmt == "glb":
            return _glb_export([b], p)
        if fmt in ("stl", "3mf"):
            return _mesh_export([b], p)  # textured or not: caps, cache, tolerance
        return export(b["shape"], fmt, p)

    if separate:
        if not live:
            return {"error": {"message": "nothing to export, no bodies"}}
        # Prefer the user's sidebar rename (display-only override carried on the
        # document) over the positional default ("Body1"), so exported part files
        # are named the way the user named the bodies.
        names = document.get("bodyNames") or {}
        base, ext = os.path.splitext(path)
        # A fresh directory: the save dialog only confirmed overwriting `parts.step`,
        # not the sibling files actually written.
        outdir = base
        try:
            os.makedirs(outdir, exist_ok=False)
        except FileExistsError:
            return {"error": {"message": (
                f"{os.path.basename(outdir)} already exists, the separate-bodies "
                f"export writes a folder of that name. Choose another name, or "
                f"move the existing folder."
            )}}
        except OSError as e:
            return {"error": {"message": f"could not create {outdir}: {e}"}}
        written, used = [], set()
        for b in live:
            label = names.get(b["id"]) or b["name"]
            name = _safe_part_filename(label, b["id"])
            cand, i = name, 2
            while cand.lower() in used:  # case-insensitive: Windows and macOS
                cand, i = f"{name}_{i}", i + 1
            used.add(cand.lower())
            written.append(_write_one_body(b, os.path.join(outdir, f"{cand}{ext}")))
        return _done({"path": outdir, "paths": written})

    if body:
        tgt = next((b for b in live if b["id"] == body), None)
        if tgt is None:
            return {"error": {"message": f"body '{body}' not found to export"}}
        if fmt == "glb":
            return _done({"path": _glb_export([tgt], path)})
        return _done({"path": _write_one_body(tgt, path)})

    # GLB always goes per-body: it carries per-body colour, and routing it through
    # export() would drop texture displacement (see _glb_export).
    if fmt == "glb":
        return _done({"path": _glb_export(live, path)})
    # All stl/3mf go through the capped, cached path; build123d's exporters bypass the caps.
    if fmt in ("stl", "3mf"):
        return _done({"path": _mesh_export(live, path)})
    # A labelled tree, so names, hierarchy, colours and placements survive. Whole documents only.
    if fmt == "step" and body is None and not separate:
        import export_tree

        tree = export_tree.build_export_tree(
            document, live, root_name=os.path.splitext(os.path.basename(path))[0] or "Model"
        )
        if tree is not None:
            return _done({"path": export(tree, fmt, path)})
    return _done({"path": export(part, fmt, path)})


def _export_project_job(document, path, palette, body_colors, body_names, settings):
    """Worker: rebuild + write an Orca-project 3MF (one object per body, palette
    slot → extruder). Same export-what-built semantics as _export_job: failed
    features become warnings; only zero live bodies is a hard error."""
    from builder import rebuild_cached
    from project3mf import sanitize_inputs, write_project_3mf

    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    _prune_export_cache(live)
    if not live:
        if errors:
            e = errors[0]
            return {"error": _err_wire(e)}
        return {"error": {"message": "nothing to export, no bodies built yet"}}

    palette, body_colors, body_names = sanitize_inputs(palette, body_colors, body_names)
    meshed = []
    ntri = 0
    for b in live:
        # Export-grade tolerance, the viewport default (0.1) is visibly faceted
        # on a printed part. Cached across exports of an unchanged body.
        positions, indices = _export_mesh(b)
        if not len(indices):
            continue  # degenerate body with no triangulation, skip, like exports do
        # This path had NO budget at all, which made it the way round every cap
        # the plain export enforces. Checked per body, before the mesh is kept,
        # so the allocation is bounded to the cap plus one body.
        ntri += len(indices) // 3
        refusal = _budget_refusal(ntri)
        if refusal:
            return {"error": {"message": refusal}}
        meshed.append(
            {"id": b["id"], "name": b["name"], "positions": positions, "indices": indices}
        )
    if not meshed:
        return {"error": {"message": "nothing to export, no meshable bodies"}}

    res = {"path": write_project_3mf(meshed, path, palette, body_colors, body_names, settings)}
    if errors:
        res["warnings"] = [
            _err_wire(e) for e in errors
        ]
    return res


def _migrate_geometry_job(items):
    """Worker: convert pre-v5 inline base64 ASCII BREP to blobs in the durable
    store, returning the content hash for each.

    IN THE WORKER, deliberately. This parses geometry that came out of a file the
    user opened, and `builder._brep_b64_to_shape` exists precisely so a crafted
    `.funda` cannot aim a parser fuzz at OCCT, doing it in the parent would put
    that fuzz one segfault away from taking the whole sidecar down instead of a
    disposable worker.

    Per-item failures are reported, not raised: one unreadable legacy body must
    not block migrating the rest, and the document keeps its inline copy for
    anything that fails, so nothing is lost either way."""
    from builder import _brep_b64_to_shape, _shape_to_blob

    out, failed = [], []
    for it in items:
        try:
            out.append({"id": it["id"], "geom": _shape_to_blob(_brep_b64_to_shape(it["brep"]))})
        except Exception as e:  # noqa: BLE001
            failed.append({"id": it.get("id"), "message": str(e)})
    return {"items": out, "failed": failed}


def _interference_job(document):
    """Worker: rebuild + pairwise interference check among live bodies. Returns
    {"pairs": [...]}, one entry per pair of solids that actually overlap (boolean
    intersection volume above a tiny epsilon), with the overlap volume + bbox so the
    frontend can report and zoom to each clash."""
    from builder import rebuild_cached, _bbox_pair_overlap, bbox_of
    from progress import progress_tick

    # rebuild_cached for the same reason as _export_job: same worker, warm cache
    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    # like export: check the bodies that BUILT, warn about what didn't, one red
    # feature must not block clash-checking an otherwise-valid assembly
    if errors and not live:
        e = errors[0]
        return {"error": _err_wire(e)}
    # One box per body, ticked: the exact boxes take 95 s on a 3,072-body assembly.
    boxes = []
    for b in live:
        progress_tick()
        boxes.append(bbox_of(b["shape"]))
    pairs = []
    for i in range(len(live)):
        # Ticked in two places, both proportional to real work: once per row,
        # and again before each boolean. The bbox rejects are cheap enough to
        # sweep in bulk, but a single row of a dense assembly can spend minutes
        # in the booleans below, which is longer than the stall timeout.
        progress_tick()
        for j in range(i + 1, len(live)):
            a, b = live[i], live[j]
            if not _bbox_pair_overlap(boxes[i], boxes[j]):
                continue  # cheap AABB reject before the (crashable) boolean
            progress_tick()
            try:
                common = a["shape"] & b["shape"]
                vol = abs(getattr(common, "volume", 0.0) or 0.0)
            except Exception:
                continue  # tangent/degenerate intersection, treat as no clash
            if vol <= 1e-6:
                continue
            bb = common.bounding_box()
            pairs.append({
                "a": a["id"], "b": b["id"], "aName": a["name"], "bName": b["name"],
                "volume": vol,
                "bbox": {
                    "min": [bb.min.X, bb.min.Y, bb.min.Z],
                    "max": [bb.max.X, bb.max.Y, bb.max.Z],
                },
            })
    return {"pairs": pairs}


def _inspect_job(document, detail=True, bodies_filter=None, max_faces=None, max_edges=None):
    """Worker: rebuild + exact B-rep measurements of the live bodies.

    rebuild_cached for the same reason export and interference use it: same
    worker, warm cache, so asking what the model measures right after building
    it costs a cache hit rather than a second rebuild.

    Errors are REPORTED, not raised. A document with one red feature still has
    bodies, and the whole point of this op is to be able to look at what did
    build and work out why the rest did not."""
    from builder import rebuild_cached
    from inspect_model import MAX_EDGES, MAX_FACES, inspect_bodies

    part, errors, bodies = rebuild_cached(document)
    live = [b for b in bodies if b.get("shape") is not None]
    if bodies_filter:
        want = set(bodies_filter)
        live = [b for b in live if b["id"] in want or b.get("name") in want]
    return {
        "bodies": inspect_bodies(
            live, detail=detail,
            max_faces=MAX_FACES if max_faces is None else int(max_faces),
            max_edges=MAX_EDGES if max_edges is None else int(max_edges),
        ),
        "errors": [_err_wire(e) for e in (errors or [])],
    }


def _import_job(path, fmt):
    """Worker: read an external geometry file (STL/3MF/STEP/BREP) into an embeddable
    BREP payload. Returns the `import` feature fields or {"error"}."""
    from builder import import_geometry

    try:
        return import_geometry(path, fmt)
    except Exception as ex:
        return {"error": {"message": str(ex)}}


def _list_fonts_job():
    """Worker: enumerate system font families (read-only)."""
    from builder import list_fonts

    try:
        return list_fonts()
    except Exception as ex:
        return {"error": {"message": str(ex)}}


def _tessellate_text_job(entity, path_entity):
    """Worker: per-glyph 2D outlines for a text entity (read-only preview)."""
    from builder import tessellate_text

    try:
        return tessellate_text(entity, path_entity)
    except Exception as ex:
        return {"error": {"message": str(ex)}}


def _project_geometry_job(document, plane, sources):
    """Worker: resolve + project geometry sources onto a sketch plane (read-only;
    per-source errors ride inside `results`, only a failed prefix rebuild or a
    bad plane spec is a whole-call error). `document` is the frontend-truncated
    timeline PREFIX, rebuild_cached gives its bodies from the warm cache."""
    from builder import project_geometry

    try:
        return project_geometry(document, plane, sources)
    except Exception as ex:
        return {"error": {"message": str(ex)}}


# --- server process ---------------------------------------------------------


def _die_with_parent():
    """Exit when the parent (the Rust shell, or the server for a worker) dies, so we
    never orphan. Linux delivers SIGTERM via PR_SET_PDEATHSIG. macOS has no such
    mechanism, so a daemon thread polls getppid() and exits on reparenting (the parent
    dying makes our ppid change / become 1). Windows is covered by the Rust-side Job
    Object (KILL_ON_JOB_CLOSE), so no watchdog is needed there."""
    if sys.platform == "linux":
        try:
            PR_SET_PDEATHSIG = 1
            libc = ctypes.CDLL("libc.so.6", use_errno=True)
            libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)
        except Exception:
            pass  # best-effort; the Rust side also kills us on exit
        return

    if sys.platform == "darwin":
        orig_ppid = os.getppid()

        def _watch():
            while True:
                time.sleep(1.0)
                try:
                    ppid = os.getppid()
                except Exception:
                    os._exit(0)
                if ppid != orig_ppid or ppid <= 1:
                    os._exit(0)  # parent gone (reparented to launchd) -> don't orphan

        threading.Thread(target=_watch, daemon=True).start()


def _new_pool():
    """Create a fresh single-worker pool and kick off its warm-up.

    Returns None once _env_broken has latched, see _pool_available(), which is
    what turns that back into a live pool if the failure was transient."""
    global _pool_gen, _warm, _pool_src
    if _env_broken:
        return None
    # BEFORE the spawn, so a file edited while the worker is starting is caught
    # on the next request rather than being baked in as if it were already there.
    _pool_src = _watched_stamp()
    _pool_gen += 1
    gen = _pool_gen
    _warm = None
    if _INIT_ERR is not None:
        try:
            _INIT_ERR.value = b""  # drop the previous generation's traceback
        except Exception:
            pass
    pool = ProcessPoolExecutor(
        max_workers=1, mp_context=_mp_ctx,
        initializer=_worker_init,
        initargs=(_HB, _HB_IDX, _INIT_ERR, _HB_MESH, _HB_MESH_TOTAL),
    )
    try:
        # Submitted at creation to force the lazy spawn, and KEPT, because this
        # future is the only public signal separating an init failure from a
        # mid-op crash (see _worker_came_up).
        fut = pool.submit(_warmup)
    except Exception:
        # Was `except Exception: pass`, so pool creation could never report a
        # problem. Do NOT return None here: a spawn that failed on a momentary
        # ENOMEM is exactly the transient the retry budget is for, and the
        # executor will try again lazily on the next submit.
        _note_init_failure(gen)
        return pool
    _warm = (gen, fut)
    _watch_warmup(fut, gen)
    return pool


def _worker_came_up(gen=None) -> bool:
    """Did the pool's worker finish _worker_init and execute a task?

    concurrent.futures gives us nothing else to go on: an initializer exception
    and a mid-op segfault raise the SAME BrokenProcessPool carrying the SAME
    private `_broken` string, and CPython swallows the initializer's exception
    inside the child. But the warm-up is submitted at pool creation and the
    single worker runs FIFO, so it always completes BEFORE any user job:

        resolved            -> the worker initialised and ran a task
        raised / not done   -> it never got that far  => environment failure

    `gen` is required for correctness, not hygiene: up to MAX_CONNS_PER_IP
    connections can have work in flight, and one worker death breaks EVERY
    in-flight future. Without keying on the generation, the second op to notice
    would read the REPLACEMENT pool's still-pending warm-up, conclude the
    environment is broken, and latch a healthy install."""
    w = _warm
    if w is None:
        return False
    wgen, fut = w
    if gen is not None and gen != wgen:
        return False
    if not fut.done() or fut.cancelled():
        return False
    return fut.exception() is None


def _init_traceback() -> str:
    if _INIT_ERR is None:
        return ""
    try:
        return _INIT_ERR.value.decode("utf-8", "replace")
    except Exception:
        return ""


def _note_init_failure(gen):
    """Record ONE failed bring-up (idempotent per generation) and print the
    worker's real traceback to stderr, which the Rust shell mirrors into
    sidecar.log, the file a bug report uploads."""
    global _env_broken
    if gen in _failed_gens or gen in _reaped_gens:
        return
    _failed_gens.add(gen)
    tb = _init_traceback()
    print(
        "[init] geometry worker failed to start (attempt %d/%d): %s"
        % (len(_failed_gens), MAX_INIT_ATTEMPTS,
           tb or "<no Python traceback, the worker died before it could report "
                 "one; a native library failed to load>"),
        file=sys.stderr, flush=True,
    )
    # An install that demonstrably worked earlier in this session is not an
    # environment failure, whatever just happened, so a post-reap respawn that
    # fails to come up must never brick the session.
    if len(_failed_gens) >= MAX_INIT_ATTEMPTS and not _ever_came_up:
        _env_broken = True
        print("[init] giving up: the geometry worker will not be restarted "
              "again this session.", file=sys.stderr, flush=True)


def _watch_warmup(fut, gen):
    """Report a bring-up outcome as soon as it is known, at LAUNCH, not on the
    user's first rebuild. `gen` is captured so a late watcher cannot attribute
    its failure to a pool that has since been replaced."""
    global _ever_came_up

    async def _w():
        global _ever_came_up
        try:
            await asyncio.wrap_future(fut)
        except Exception:
            # _note_init_failure skips pools we reaped, which also break their warm-up.
            _note_init_failure(gen)
        else:
            _ever_came_up = True
            _failed_gens.clear()  # only CONSECUTIVE failures count

    try:
        asyncio.get_running_loop().create_task(_w())
    except RuntimeError:
        pass  # no loop yet (pool built before serve starts); the op path re-checks


def _pool_available():
    """Ensure there is a pool to submit to, rebuilding if a previous attempt
    left us without one. Returns an error dict when geometry is unavailable.

    `_pool is None` must stay RECOVERABLE: today's code kept the executor object
    on a failed spawn, so the next operation simply retried. Making None
    terminal would let one transient failure disable geometry for the whole
    session with the retry budget unspent."""
    global _pool
    if _env_broken:
        return {"error": {"message": _INIT_FAIL_MSG}}
    if _pool is not None and _pool_src is not None:
        now = _watched_stamp()
        if now is not None and now != _pool_src:
            # The worker is running code this package no longer contains. Retire
            # it: the next job spawns a worker that imports what is on disk. This
            # is the same recycle a crash or a stall performs, so the document is
            # as safe here as it is there, the frontend holds it and resends it.
            print("sidecar: sources changed, recycling the geometry worker",
                  file=sys.stderr, flush=True)
            _kill_pool(_pool)
            _pool = None
    if _pool is None:
        _pool = _new_pool()
    if _pool is None:
        return {"error": {"message": _INIT_FAIL_MSG}}
    return None


def _on_broken(gen):
    """Turn a BrokenProcessPool into the right reply, and rebuild the pool.

    This is the split the whole change exists for: a worker that never started
    is a broken installation and must say so, while a worker that died mid-op is
    the pre-existing per-operation crash and keeps its message (and its feature
    naming, via _crash_feature)."""
    global _pool
    if _worker_came_up(gen):
        _pool = _new_pool()
        return {"error": {"message": "the geometry kernel crashed on this operation"}}
    if gen != _pool_gen:
        # A peer already handled this generation and rebuilt; don't count it
        # twice or report an environment failure we haven't established.
        return {"error": {"message": "the geometry kernel crashed on this operation"}}
    _note_init_failure(gen)
    _pool = _new_pool()
    return {"error": {"message": _INIT_FAIL_MSG}}


def _kill_pool(pool):
    """Forcibly terminate a pool's worker process(es), used to stop a worker that's
    spinning on a runaway OCCT call, since shutdown() alone would wait for it."""
    _reaped_gens.add(_pool_gen)  # a deliberate kill is not a failed bring-up
    try:
        for p in list(getattr(pool, "_processes", {}).values()):
            try:
                p.kill()
            except Exception:
                pass
    finally:
        try:
            pool.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass


async def _run(loop, fn, *args, timeout=JOB_TIMEOUT):
    """Run a heavy job in the worker pool with a hard timeout. On timeout (runaway
    OCCT) or a worker crash (segfault), recycle the pool and return a clean error
    dict so the socket stays alive and the app keeps working."""
    global _pool
    err = _pool_available()
    if err is not None:
        return err
    gen = _pool_gen  # captured BEFORE submit: a peer may recycle while we wait
    token = _CANCEL.get()
    cancelled = lambda: bool(token and token["cancelled"])
    try:
        fut = loop.run_in_executor(_pool, fn, *args)
        res = await asyncio.wait_for(fut, timeout=timeout)
        # a cancel that lands in the last moments still reports cancelled: the
        # caller has already moved on and must not be handed a surprise result
        return _cancelled_result() if cancelled() else res
    except asyncio.TimeoutError:
        if cancelled():
            return _cancelled_result()  # the pool was killed BY the cancel
        _kill_pool(_pool)
        _pool = _new_pool()
        return {"error": {"message": "operation timed out, geometry too complex or degenerate"}}
    except BrokenProcessPool:
        if cancelled():
            return _cancelled_result()
        return _on_broken(gen)


_EXPORT_SEC_PER_BODY = 0.09  # 4x the measured 22.6 ms/body, see _export_stall_budget


def _export_stall_budget(document):
    """Wall-clock reap budget for an export, in seconds.

    `_run_stall` normally supervises by PROGRESS, which is the right design, but
    the export WRITE (build123d's export_step/export_stl, or Mesher.write) is a
    single atomic OCCT call that holds the GIL, so nothing inside it can bump the
    heartbeat. Supervision therefore degrades to a wall clock here, exactly as it
    already does for `import` below, and for the same reason.

    Left on the default STALL_TIMEOUT this was not a slow path but a BROKEN one:
    the 3,071-body reference assembly writes 1,031.8 MB of STEP in 69.4 s, and
    the 60 s default reaped it at 60.1 s, reporting "the geometry kernel was
    restarted" for a kernel that was working fine, and leaving NO file at the
    path the user chose. `_export_job` ticks once per body while `rebuild_cached`
    runs and then goes silent for the whole write, so the rebuild half never
    protected it.

    Scaled on the document's body count, which is what the write actually costs
    per unit: _EXPORT_SEC_PER_BODY is 4x the measured 22.6 ms/body, floored at the
    old default so a small export keeps its tight guard. Generous at the top is
    safe because Cancel stays live throughout, the frontend wraps export in
    `runBusy`, and the supervisor's 1 s poll honours the cancel token
    independently of the GIL-holding worker."""
    # an import feature carries one `parts` entry per body it explodes to; any
    # other feature contributes at most a body or two
    feats = (document or {}).get("features") or ()
    n = sum(len(f.get("parts") or ()) or 1 for f in feats if isinstance(f, dict))
    return max(STALL_TIMEOUT, _EXPORT_SEC_PER_BODY * n)


def _building_frame(ws, rid):
    """An `on_progress` callback that emits one interim "building" frame.

    The client routes status frames to its progress listeners and never resolves
    the pending call with one. `meshed`/`meshTotal` carry the payload phase's
    real denominator so the timeline can say "meshing 812/3071" instead of
    sitting at 0%. Shared by `rebuild` and `computeAll`, which want the identical
    frame."""
    async def _send(idx, meshed=-1, mesh_total=-1):
        await ws.send(json.dumps(
            {"id": rid, "status": "building", "feature": idx,
             "meshed": meshed, "meshTotal": mesh_total}
        ))

    return _send


def _job_entry(fn, *args):
    """Run a supervised job, announcing in the heartbeat that it has STARTED.

    Two faults used to compound into "one operation stalled for over 60 s" on a
    document holding NOTHING: no bodies, no sketches.

    The supervisor's clock started at SUBMIT (`last_t` was set right after
    run_in_executor). The pool is max_workers=1 and the warm-up is submitted at
    pool creation, so the first job after a pool comes up QUEUES behind a cold
    build123d/OCP import and could spend its whole budget without executing a
    single instruction. A job that has not started cannot have stalled. Worse,
    the reap recycles the pool, which submits a fresh warm-up, so the retry
    queues behind another cold import: a spiral rather than a one-off.

    The second fault is why an EMPTY document is the shape that surfaces it. The
    heartbeat's only writer is builder's per-feature tick, which fires per
    feature and per tessellated body, so a zero-feature rebuild never ticked at
    all. Nothing could reset the clock and STALL_TIMEOUT degenerated into a plain
    wall clock over queue plus execution.

    One tick here answers both: _run_stall resets its clock whenever the counter
    moves, so the budget measures EXECUTION stall, and an empty document gets the
    one tick it could never otherwise produce. It deliberately does NOT touch
    _HB_IDX; no feature is in progress yet, and -1 already means "none".

    This does not lengthen the budget. A job that starts and then wedges still
    stops ticking and is still reaped after STALL_TIMEOUT. Only the clock's
    origin moves, from when the job was queued to when it began."""
    if _HB is not None:
        _HB.value += 1
    return fn(*args)


async def _run_stall(loop, fn, *args, stall=STALL_TIMEOUT, on_progress=None):
    """Run a rebuild-class job supervised by PROGRESS instead of wall clock: kill
    the worker only when the shared heartbeat hasn't moved for `stall` seconds.
    A 10k-feature cold build can legitimately run for minutes and is never
    reaped while it makes progress; a single wedged OCCT call stops ticking and
    gets reaped, and the disk checkpoints turn that into a ratchet (the retry
    resumes from the last checkpoint, so it converges to a reported error on
    the one bad feature instead of a death spiral). `on_progress` (async, takes
    the current feature index) is fired roughly once a second while the job
    runs, the rebuild path streams it to the frontend as building frames."""
    global _pool
    err = _pool_available()
    if err is not None:
        return err
    # Submit is INSIDE the try below via gen capture: a pool that is already
    # broken raised BrokenProcessPool straight out of run_in_executor, past
    # _crash_feature and into handle()'s catch-all, shipping raw CPython text.
    gen = _pool_gen
    token = _CANCEL.get()
    cancelled = lambda: bool(token and token["cancelled"])
    try:
        fut = loop.run_in_executor(_pool, _job_entry, fn, *args)
    except BrokenProcessPool:
        if cancelled():
            return _cancelled_result()
        return _on_broken(gen)
    last = _HB.value if _HB is not None else 0
    last_t = loop.time()
    # The pool's warm-up, if this job was submitted before it finished. With
    # max_workers=1 a job submitted while the warm-up still holds the worker
    # cannot start, and the time it spends WAITING must not be charged to its
    # stall budget. See _job_entry.
    warm = _warm[1] if _warm is not None and _warm[0] == gen else None
    while True:
        try:
            res = await asyncio.wait_for(asyncio.shield(fut), timeout=1.0)
            return _cancelled_result() if cancelled() else res
        except asyncio.TimeoutError:
            # cancel kills the pool, which usually surfaces as BrokenProcessPool
            # below, but the 1s poll can land first, so check here too
            if cancelled():
                fut.cancel()
                return _cancelled_result()
            if on_progress is not None:
                try:
                    await on_progress(
                        int(_HB_IDX.value) if _HB_IDX is not None else -1,
                        int(_HB_MESH.value) if _HB_MESH is not None else -1,
                        int(_HB_MESH_TOTAL.value) if _HB_MESH_TOTAL is not None else -1,
                    )
                except Exception:
                    pass  # a dropped progress frame must never kill the build
            if _HB is not None:
                cur = _HB.value
                if cur != last:
                    last, last_t = cur, loop.time()
                    continue
            # Still queued behind the worker's cold start: hold the clock at now
            # rather than reaping a job that has not run an instruction. A broken
            # bring-up is NOT waited on forever; it resolves this future with
            # BrokenProcessPool, which the handler below already owns.
            if warm is not None and not warm.done():
                last_t = loop.time()
                continue
            if loop.time() - last_t > stall:
                _kill_pool(_pool)
                _pool = _new_pool()
                fut.cancel()
                return {"error": {"message": (
                    "one operation stalled for over %d s, the geometry kernel was "
                    "restarted; progress up to the last checkpoint is kept"
                ) % int(stall)}}
        except BrokenProcessPool:
            if cancelled():
                return _cancelled_result()  # the pool was killed BY the cancel
            # Before recycling: the heartbeat names the feature a segfault died in.
            idx = int(_HB_IDX.value) if _HB_IDX is not None else -1
            res = _on_broken(gen)
            # feature_index only means anything for a real op crash; on an
            # environment failure there is no culprit feature to name, and
            # _crash_feature would rewrite the message into "your shape is
            # degenerate", the exact misattribution this change removes.
            if res.get("error", {}).get("message") != _INIT_FAIL_MSG:
                res["error"]["feature_index"] = idx
            return res


def _crash_feature(res, document):
    """Name the feature a crashed/stalled worker died on.

    OCCT segfaults inside native code, so there is no exception and no
    traceback to attribute, only the heartbeat index the worker last published.
    Map it back to a real feature id so the error names the culprit and the
    timeline can chip it, instead of reporting a nameless kernel crash.
    """
    if (res or {}).get("cancelled"):
        return res  # a cancel is not a crash; don't attribute it to a feature
    err = (res or {}).get("error")
    if not isinstance(err, dict):
        return res
    idx = err.pop("feature_index", -1)
    feats = ((document or {}).get("features") or [])
    if not (isinstance(idx, int) and 0 <= idx < len(feats)):
        return res
    f = feats[idx] or {}
    fid, ftype = f.get("id"), (f.get("name") or f.get("type") or "feature")
    if fid:
        err["feature_id"] = fid
    err["message"] = (
        f"{ftype} crashed the geometry kernel, this shape is degenerate for OCCT "
        "(often a cut that runs exactly tangent to a fillet); try a slightly "
        "different value"
    )
    # ALSO write it to stderr, which is mirrored into <app_data>/sidecar.log,
    # the file the bug reporter uploads. A segfaulted worker leaves no traceback,
    # so without this line a field report contains no evidence the kernel died at
    # all; the only record was a toast the user has probably dismissed.
    print(
        f"[crash] worker died building feature {fid} ({ftype}) at index {idx}: "
        f"{json.dumps(f, default=str)[:800]}",
        file=sys.stderr, flush=True,
    )
    return res


def _authorized(request) -> bool:
    """True iff the request carries the per-launch shared secret (and, when a
    browser supplies an Origin, a Tauri one). The token stops local processes
    and DNS-rebinding pages; the origin check stops a page that somehow learned
    the token."""
    if not _TOKEN:
        return False
    q = urllib.parse.urlparse(request.path).query
    tok = urllib.parse.parse_qs(q).get("token", [""])[0]
    if not hmac.compare_digest(tok, _TOKEN):  # constant-time compare
        return False
    origin = request.headers.get("Origin", "")
    if origin and origin not in ALLOWED_ORIGINS:
        # Loud on stderr (mirrored to sidecar.log): a silent origin rejection
        # looked like a healthy-but-unreachable sidecar for three field reports
        # straight, the Windows webview origin was missing from the allowlist.
        print(f"[auth] rejected WS handshake from origin {origin!r} "
              f"(allowed: {sorted(ALLOWED_ORIGINS)})", file=sys.stderr, flush=True)
        return False
    return True


def _mint_token() -> str:
    """Manual `python server.py` (no FUNDACAD_SIDECAR_TOKEN env): mint one and
    print it on stdout so a prober can read it and append ?token=… to its URL."""
    t = secrets.token_urlsafe(32)
    print(f"TOKEN {t}", flush=True)
    return t


async def _dispatch(ws, loop, req, req_id, op):
    """Run one request and send its reply. Split out of handle() so the read
    loop can stay responsive while this is running, see handle().

    INVARIANT, relied on by the chunked reply path: _serialized holds its lock
    across the whole of this function, INCLUDING every `await ws.send(...)`. A
    streamed reply is several frames that must reach the client contiguously,
    so moving a send outside that lock, or letting two heavy ops run
    concurrently, would splice two documents' bodies together."""
    if op == "rebuild":
        tol = req.get("tolerance", 0.1)
        payload = {
            k: req[k]
            for k in ("document", "baseRevision", "revision", "ops")
            if k in req
        }

        res = await _run_stall(
            loop, _rebuild_delta_job, payload, tol, req.get("known"),
            on_progress=_building_frame(ws, req_id),
        )
        res = _crash_feature(res, req.get("document"))
        await _send_reply(ws, req_id, res, bool(req.get("binary")), bool(req.get("chunked")))

    elif op == "computeAll":
        tol = req.get("tolerance", 0.1)
        payload = {"document": req["document"], "revision": req.get("revision")}
        res = await _run_stall(loop, _compute_all_job, payload, tol,
                               on_progress=_building_frame(ws, req_id))
        res = _crash_feature(res, req.get("document"))
        await _send_reply(ws, req_id, res, bool(req.get("binary")), bool(req.get("chunked")))

    elif op == "export":
        res = await _run_stall(loop, _export_job, req["document"], req["format"], req["path"], req.get("body"), req.get("separate", False), req.get("palette") or [], req.get("bodyColors") or {}, stall=_export_stall_budget(req["document"]))
        await ws.send(_reply_for(req_id, res))

    elif op == "exportProject":
        # settings is written into the 3MF verbatim (project config for
        # the slicer); cap its size like any untrusted request field.
        settings = req.get("settings") or {}
        if not isinstance(settings, dict) or len(json.dumps(settings)) > 262144:
            await ws.send(_err(req_id, "exportProject: bad settings"))
            return
        res = await _run_stall(
            loop, _export_project_job, req["document"], req["path"],
            req.get("palette") or [], req.get("bodyColors") or {},
            req.get("bodyNames") or {}, settings,
            stall=_export_stall_budget(req["document"]),
        )
        await ws.send(_reply_for(req_id, res))

    elif op == "interference":
        res = await _run_stall(loop, _interference_job, req["document"])
        await ws.send(_reply_for(req_id, res))

    elif op == "inspect":
        res = await _run_stall(
            loop, _inspect_job, req["document"], bool(req.get("detail", True)),
            req.get("bodies"), req.get("maxFaces"), req.get("maxEdges"),
        )
        await ws.send(_reply_for(req_id, res))

    elif op == "import":
        # A size-derived budget (a 356 MiB STEP took 193 s), passed as stall= because OCP
        # holds the GIL for the whole read and nothing can tick.
        try:
            _sz = os.path.getsize(req["path"]) / (1024 * 1024)
        except OSError:
            _sz = 0.0
        budget = max(90.0, 60.0 + 1.5 * _sz)
        # A tighter estimate than the reaper budget for the progress bar (measured 0.41-0.54 s/MiB).
        eta = max(3.0, 0.5 * _sz)

        async def _importing(code, *_mesh, _rid=req_id, _t0=loop.time(), _b=eta):
            # *_mesh swallows the meshing counters _run_stall passes positionally
            # (an import does not mesh). Without it they would bind to _rid/_t0
            # and corrupt every import frame.
            i = code if 0 <= code < len(_IMPORT_PHASES) else 0
            base = sum(w for _, w in _IMPORT_PHASES[:i])
            label, w = _IMPORT_PHASES[i]
            # Nothing is observable INSIDE a phase (the GIL is held), so creep
            # on elapsed time within that phase's share and never let it reach
            # the next phase's floor.
            frac = min(0.95, max(0.0, (loop.time() - _t0) / _b))
            await ws.send(json.dumps({
                "id": _rid, "status": "importing",
                "phase": i, "label": label,
                "pct": int(100 * min(0.99, base + w * frac)),
            }))

        res = await _run_stall(
            loop, _import_job, req["path"], req["format"],
            stall=budget, on_progress=_importing,
        )
        await ws.send(_reply_for(req_id, res))

    elif op == "listFonts":
        res = await _run(loop, _list_fonts_job, timeout=JOB_TIMEOUT)
        await ws.send(_reply_for(req_id, res))

    elif op == "tessellateText":
        res = await _run(loop, _tessellate_text_job, req["entity"], req.get("pathEntity"), timeout=JOB_TIMEOUT)
        await ws.send(_reply_for(req_id, res))

    elif op == "projectGeometry":
        # Usually a warm prefix-cache hit, but a cold start replays the whole
        # prefix like export/interference do, and that replay ticks, so a long
        # one is no longer mistaken for a hang.
        res = await _run_stall(
            loop, _project_geometry_job, req["document"], req["plane"],
            req.get("sources") or [],
        )
        await ws.send(_reply_for(req_id, res))

    elif op == "migrateGeometry":
        # One-way v4 -> v5: the document still carries inline base64, so nothing
        # is lost if this never runs. JOB_TIMEOUT and a WALL CLOCK, not stall
        # supervision: this decodes a bounded list of already-embedded blobs, it
        # does not rebuild, so it has no heartbeat to supervise.
        res = await _run(loop, _migrate_geometry_job, req.get("items") or [], timeout=JOB_TIMEOUT)
        await ws.send(_reply_for(req_id, res))

    elif op == "ping":
        await ws.send(_ok(req_id, {"pong": True}))

    else:
        await ws.send(_err(req_id, f"unknown op: {op}"))


#: The one heavy job at a time. See handle() for why it is not per connection.
#: Created at import: an asyncio.Lock binds to no loop until it is awaited, so a
#: module-level one is safe and there is only ever the one serve() loop anyway.
_JOB_LOCK = asyncio.Lock()

#: The one shared document a running app and an outside agent both work on.
#: Process-wide, like the pool: there is one engine here and one app driving it.
#: See live_session.py for the rules; this file only carries them to the wire.
_LIVE = live_session.LiveSession()

#: Ops the live session answers. Named here rather than matched inline so
#: handle() can route them without knowing what any of them do.
_SESSION_OPS = frozenset({
    "session_host", "session_release", "session_state", "session_propose",
    "session_leave",
})


def _session_reply(ws, req, req_id, op):
    """One live-session op, answered from the request that carried it.

    These run on the READ path, never behind the heavy lock, and that is not an
    optimisation. The host publishes its document on a loop; if that queued
    behind a rebuild, the app would stop answering an agent for exactly as long
    as the agent's own build took, and the agent would read "no app" and start a
    second engine. Every one of them is a dict update, no geometry, no worker,
    nothing that can block.

    The connection is the identity. A host that loses its socket stops being the
    host, and a guest that reconnects is a new guest, which is what both of those
    events actually mean.
    """
    who = _conn_id(ws)
    if op == "session_host":
        res = _LIVE.publish(who, req.get("document"), req.get("revision") or 0,
                            req.get("title"), req.get("status"))
    elif op == "session_release":
        res = _LIVE.release(who)
    elif op == "session_state":
        res = _LIVE.state(who, req.get("name"))
    elif op == "session_propose":
        res = _LIVE.propose(who, req.get("document"), req.get("baseRevision") or 0,
                            req.get("note"), req.get("name"))
    # Spelled out rather than left as a bare `else`, because the coverage harness
    # builds its universe by scraping this file for equality tests against a
    # quoted op name: an op that only ever appears inside a set is an op nothing
    # measures.
    elif op == "session_leave":
        res = _LIVE.leave(who)
    else:
        # Unreachable: handle() routes only _SESSION_OPS here, and this is the
        # branch that says so if the two ever fall out of step.
        return _err(req_id, f"unknown session op: {op}")
    return _ok(req_id, res)


def _conn_id(ws):
    """A stable name for one websocket connection.

    id() of the object, which is unique among LIVE objects and is exactly the
    lifetime wanted: it names this connection for as long as it exists and is
    meaningless afterwards, which is what "the host is whoever is still on the
    socket" means. Never leaves this process.
    """
    return f"c{id(ws):x}"


async def _serialized(ws, loop, req, req_id, op, lock, running):
    """One heavy op, serialized against its peers, with a cancel token bound to
    this task's context so _run/_run_stall can see it."""
    try:
        async with lock:
            token = {"cancelled": False}
            _CANCEL.set(token)
            running["id"] = req_id
            running["token"] = token
            try:
                await _dispatch(ws, loop, req, req_id, op)
            finally:
                running["id"] = None
                running["token"] = None
    except asyncio.CancelledError:
        raise
    except Exception as ex:
        try:
            await ws.send(_err(req_id, str(ex) or type(ex).__name__))
        except Exception:
            pass


def _cancel_running(running, target=None):
    """Stop the job in flight. A ProcessPoolExecutor job cannot be interrupted
    any other way, so this kills the worker exactly as the timeout path does and
    hands back a fresh pool. The token tells _run/_run_stall that the resulting
    BrokenProcessPool is a CANCEL, not a crash, otherwise a user pressing
    Cancel would be told the geometry kernel crashed.

    `target` (a request id) cancels only that request; None cancels whatever is
    running. Returns whether anything was actually stopped."""
    global _pool
    token = running.get("token")
    if token is None:
        return False
    if target is not None and running.get("id") != target:
        return False
    token["cancelled"] = True
    pool = _pool
    if pool is not None:
        _kill_pool(pool)
        _pool = _new_pool()
    return True


async def handle(ws):
    peer = ws.remote_address[0] if ws.remote_address else None
    if peer is not None:
        if _ip_conns.get(peer, 0) >= MAX_CONNS_PER_IP:
            await ws.close(code=1008, reason="too many connections")
            return
        _ip_conns[peer] = _ip_conns.get(peer, 0) + 1
    # Before the try: the finally reads it, and an early return used to leak the per-IP count.
    tasks: set = set()
    try:
        if not _authorized(ws.request):
            await ws.close(code=1008, reason="unauthorized")
            return
        loop = asyncio.get_running_loop()
        # Process-wide, not per connection: the heartbeat and rebuild cache assume one job at a time.
        lock = _JOB_LOCK
        running: dict = {"id": None, "token": None}
        async for raw in ws:
            try:
                req = json.loads(raw)
            except Exception as ex:
                await ws.send(_err(None, f"bad JSON: {ex}"))
                continue

            req_id = req.get("id")
            op = req.get("op")
            if True:
                # Control ops answer on the READ path so they are never queued
                # behind a running job. That is the whole point: an import can
                # hold the worker for 100+ seconds, and cancel has to be heard
                # DURING it, not after.
                if op == "cancel":
                    hit = _cancel_running(running, req.get("target"))
                    await ws.send(_ok(req_id, {"cancelled": hit}))
                    continue

                if op in _SESSION_OPS:
                    await ws.send(_session_reply(ws, req, req_id, op))
                    continue

                task = asyncio.create_task(
                    _serialized(ws, loop, req, req_id, op, lock, running)
                )
                tasks.add(task)
                task.add_done_callback(tasks.discard)
    finally:
        for t in list(tasks):
            t.cancel()
        # Whoever this was, they are gone. A host that keeps hosting after its
        # socket closed would leave an agent editing a document no window has
        # open, and a guest that keeps its lease would keep the app polling fast
        # for nothing.
        who = _conn_id(ws)
        _LIVE.release(who)
        _LIVE.leave(who)
        if peer is not None:
            _ip_conns[peer] = _ip_conns.get(peer, 0) - 1
            if _ip_conns[peer] <= 0:
                _ip_conns.pop(peer, None)


async def main():
    global _pool, _mp_ctx, _TOKEN, _HB, _HB_IDX, _INIT_ERR, _HB_MESH, _HB_MESH_TOTAL
    _die_with_parent()
    _TOKEN = appenv.get("SIDECAR_TOKEN") or _mint_token()
    _mp_ctx = mp.get_context("spawn")
    _HB = _mp_ctx.Value("Q", 0)  # heartbeat: bumped by the worker per feature
    _HB_IDX = _mp_ctx.Value("q", -1)  # which feature is building (-1 = meshing)
    # meshing progress; -1/-1 means "not meshing" (see the _HB_MESH comment above)
    _HB_MESH = _mp_ctx.Value("q", -1)
    _HB_MESH_TOTAL = _mp_ctx.Value("q", -1)
    # lock=False deliberately: a locked Array could deadlock the parent's read if
    # _kill_pool SIGKILLs a worker mid-write. One writer (the dying worker), one
    # reader (us, after it is dead), the same reasoning as _HB's single-writer
    # comment. A raw c_char array still supports .value.
    _INIT_ERR = _mp_ctx.Array("c", 16384, lock=False)
    _pool = _new_pool()
    try:
        # A document embeds imported B-reps, far past the 1 MiB default message cap. No
        # compression on a loopback socket: it cost 84 ms per 5 MB reply.
        bound = False
        try:
            async with websockets.serve(handle, HOST, PORT, max_size=wire._MAX_FRAME,
                                        compression=None):
                bound = True
                # readiness signal the Rust shell waits for before connecting
                print(f"LISTENING {PORT}", flush=True)
                await asyncio.Future()  # run forever
        except OSError as e:
            if bound:
                raise  # already serving; this is not a bind failure, do not mislabel it
            # The Rust shell shows the FATAL line in a toast, so it names the port and stays short.
            print(f"FATAL: cannot open port {PORT} on {HOST}", file=sys.stderr, flush=True)
            print(f"  bind failed: {e}", file=sys.stderr, flush=True)
            sys.exit(EXIT_PORT_IN_USE)
    finally:
        _kill_pool(_pool)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
