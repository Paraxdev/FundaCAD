"""Not rebuilding what has not changed.

Split out of builder.py. The rebuild is stateless by design — the whole feature
tree, from scratch, every time — and this is what makes that affordable. Each
feature gets a signature over the fields it actually reads (including the
parameters it can reach through an expression, which is why _param_closure
exists), the signatures chain into a key per prefix of the tree, and a matching
key means the state after that prefix can be restored instead of recomputed.

Two tiers: an in-process snapshot ring for the common case of scrubbing one
value, and a disk checkpoint keyed the same way for the case where the worker
died or the document was reopened. The disk tier stores B-rep blobs, so a body
that is byte-identical across documents is stored once.
"""

import hashlib
import json
import os

import font_guard  # noqa: F401  MUST precede build123d — see font_guard.py

from progress import progress_tick
from shape_util import _wrap_topods, _wrapped_or_none

_CACHE = {"feature_sigs": [], "snaps": [], "global_sig": None}


# import features embed multi-MB BREP b64 — hashing it once per (feature id,
# size, head, tail) instead of json.dumps-ing it into every signature keeps
# per-edit sig work O(doc structure), not O(embedded geometry)
_IMPORT_BREP_SIGS = {}


def _feature_sig(f):
    if f.get("type") == "import" and isinstance(f.get("brep"), str):
        b = f["brep"]
        mk = (f.get("id"), len(b), b[:64], b[-64:])
        h = _IMPORT_BREP_SIGS.get(mk)
        if h is None:
            h = hashlib.blake2b(b.encode(), digest_size=16).hexdigest()
            _IMPORT_BREP_SIGS[mk] = h
        g = dict(f)
        g["brep"] = h
        return json.dumps(g, sort_keys=True, separators=(",", ":"))
    return json.dumps(f, sort_keys=True, separators=(",", ":"))


def _global_sig(document):
    # params affect features globally. Body visibility only gates LEGACY extrude
    # booleans (features without a captured `hiddenBodies` set) — when every
    # extrude carries its own set, an eye toggle changes NO geometry and must
    # not invalidate the cache (it used to force a full rebuild per click).
    legacy_vis = any(
        f.get("type") == "extrude" and "hiddenBodies" not in f
        for f in document.get("features", [])
    )
    return json.dumps(
        {
            "p": document.get("parameters", {}),
            "v": document.get("bodyVisibility", {}) if legacy_vis else None,
        },
        sort_keys=True, separators=(",", ":"),
    )


# --- durable checkpoint cache (proving-ground/rebuild-scaling-design-2026-07-03.md §3) ---
#
# Chain keys are INPUT-addressed: key_i = H(key_{i-1} ‖ feature_sig_i), seeded with
# H(env_sig ‖ global_sig). Geometry is never hashed, so OCCT float nondeterminism
# can't poison a key; a chain key found on disk proves the entire document prefix
# (and params/visibility/env) that produced it is byte-identical — exactly the
# validity condition of today's RAM prefix cache. Phase 1 changes durability only,
# not invalidation semantics. Restores are verified against per-body fingerprints
# (face/edge/vertex counts + bbox): any divergence is a cache MISS, never wrong geometry.

_ENV_SIG = None


def _env_sig():
    """Hash of everything outside the document that shapes geometry: kernel/library
    versions + the sidecar's own geometry source files. Automatic and conservative —
    any builder change costs one cold rebuild per doc instead of risking stale
    geometry from a forgotten manual version bump. SINDRI_ENV_SIG overrides for dev."""
    global _ENV_SIG
    if _ENV_SIG is None:
        forced = os.environ.get("SINDRI_ENV_SIG")
        if forced:
            _ENV_SIG = forced
        else:
            h = hashlib.blake2b(digest_size=16)
            try:
                import OCP
                h.update(getattr(OCP, "__version__", "?").encode())
            except Exception:
                pass
            try:
                import build123d as _b3d
                h.update(getattr(_b3d, "__version__", "?").encode())
            except Exception:
                pass
            here = os.path.dirname(os.path.abspath(__file__))
            # Every source file whose contents can change a build RESULT. A
            # module left off keeps serving cached geometry built by its own
            # previous version, which is the hardest kind of stale to spot: the
            # code is right, the output is not, and a restart does not help
            # because the checkpoints are on disk.
            #
            # So it is EVERY module, discovered rather than listed. This used to
            # be a hand-written list of six files, which was survivable while
            # builder.py held the whole kernel and is not now that it is split
            # across a dozen modules — a list is one refactor away from being
            # wrong, and being wrong here is silent. Sorted, so the hash does not
            # depend on directory order. A module that cannot affect geometry
            # (server.py) costs an occasional cold rebuild when it is edited,
            # which is the cheap side of this trade by a wide margin.
            names = sorted(
                n for n in os.listdir(here)
                if n.endswith(".py") or n == "selector_tuning.json"
            )
            for name in names:
                try:
                    with open(os.path.join(here, name), "rb") as fh:
                        h.update(name.encode())
                        h.update(fh.read())
                except OSError:
                    pass
            _ENV_SIG = h.hexdigest()
    return _ENV_SIG


# --- P3: scoped invalidation (design §5 Phase 3) ----------------------------
# The durable chain keys scope params (and, for the features that consult it,
# visibility) PER FEATURE instead of poisoning key_0: a parameter edit then
# invalidates only from the first feature whose expressions (transitively)
# reference it, and a visibility toggle only from the first extrude — both were
# full cold rebuilds before. Conservative by construction: the reference scan
# is a word-boundary superset (a body name that happens to equal a param name
# merely over-invalidates, never under). The RAM cache keeps the old
# whole-document _global_sig semantics untouched; on its (now more frequent)
# miss the disk chain simply resumes deeper.

_IDENT_RE = None


def _param_closure(params):
    """name -> the set of param names its raw value transitively references."""
    import re
    global _IDENT_RE
    if _IDENT_RE is None:
        _IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
    names = set(params)
    deps = {
        n: (set(_IDENT_RE.findall(v)) & names) if isinstance(v, str) else set()
        for n, v in params.items()
    }
    closed = {}

    def close(n, seen):
        if n in closed:
            return closed[n]
        if n in seen:
            return {n}  # cycle guard — self-set, still conservative
        out = {n}
        for d in deps[n]:
            out |= close(d, seen | {n})
        closed[n] = out
        return out

    return {n: close(n, set()) for n in names}


def _feature_scope(f, params, closure, hidden_json):
    """The per-feature invalidation scope string: raw values of every param the
    feature's strings (transitively) reference, plus the hidden-body set for
    feature types that consult visibility (extrude booleans)."""
    refs = set()

    def walk(v):
        if isinstance(v, str):
            if len(v) <= 256:  # embedded BREP b64 etc. can't reference params
                refs.update(_IDENT_RE.findall(v))
        elif isinstance(v, dict):
            for k, x in v.items():
                # `nodes`/`parts` are the imported assembly tree: product NAMES
                # straight out of a STEP file, which are not expressions and must
                # never be scanned for parameter identifiers. A real product
                # called "Bracket t Left" would otherwise pull parameter `t` into
                # this import's invalidation scope, so dragging an unrelated
                # slider would force a cold re-import of the single most
                # expensive feature in the document.
                if k in ("nodes", "parts"):
                    continue
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(f)
    used = set()
    hit = refs & set(params)
    for r in hit:
        used |= closure[r]
    scope = json.dumps(
        {n: params[n] for n in sorted(used)}, sort_keys=True, separators=(",", ":")
    )
    if f.get("type") == "extrude" and "hiddenBodies" not in f:
        # legacy extrude only: gated by the LIVE visibility map, so the map is
        # part of its invalidation scope. A captured-visibility extrude carries
        # hiddenBodies in its own signature and ignores the live map entirely.
        scope += "|" + hidden_json
    return scope


# Identity-keyed memos for per-feature signature/scope work. With the delta
# wire protocol the worker holds ONE document object and patches it, so an
# unchanged feature keeps its exact dict object across edits — id() identity is
# a sound memo key as long as the entry also pins the object (so the id can't
# be recycled). Rebuilt each pass, so they never outgrow the current document.
_SIG_MEMO = {}
_SCOPE_MEMO = {}


def _feature_sigs(features):
    """Per-feature sigs with identity memoization: json.dumps runs only for
    features whose dict object actually changed since the last rebuild."""
    global _SIG_MEMO
    new_memo = {}
    sigs = []
    for f in features:
        ent = _SIG_MEMO.get(id(f))
        s = ent[1] if (ent is not None and ent[0] is f) else _feature_sig(f)
        new_memo[id(f)] = (f, s)
        sigs.append(s)
    _SIG_MEMO = new_memo
    return sigs


def _chain_keys_scoped(document, feature_sigs):
    """Input-addressed chain keys with P3 scoping: key_0 = H(env) only; each
    key_i folds in the feature's sig + its param/visibility scope."""
    global _SCOPE_MEMO
    params = document.get("parameters", {}) or {}
    closure = _param_closure(params)
    vis = document.get("bodyVisibility", {}) or {}
    hidden_json = json.dumps(sorted(k for k, v in vis.items() if v is False))
    pkey = json.dumps(params, sort_keys=True, separators=(",", ":"))
    k = hashlib.blake2b(_env_sig().encode(), digest_size=16).hexdigest()
    keys = []
    new_memo = {}
    for f, s in zip(document.get("features", []), feature_sigs):
        ent = _SCOPE_MEMO.get(id(f))
        if ent is not None and ent[0] is f and ent[1] == pkey and ent[2] == hidden_json:
            scope = ent[3]
        else:
            scope = _feature_scope(f, params, closure, hidden_json)
        new_memo[id(f)] = (f, pkey, hidden_json, scope)
        k = hashlib.blake2b((k + s + scope).encode(), digest_size=16).hexdigest()
        keys.append(k)
    _SCOPE_MEMO = new_memo
    return keys


def _disk_store():
    """The geomstore singleton, or None when disabled (SINDRI_DISK_CACHE=0) or
    unavailable. Never raises: the disk cache is advisory by design."""
    if os.environ.get("SINDRI_DISK_CACHE", "1") == "0":
        return None
    try:
        import geomstore
        return geomstore.default_store()
    except Exception:
        return None


def _body_fingerprint(shape):
    """Cheap identity check for a restored body (design §3.3): face/edge/vertex counts
    + bbox. A mismatch means the restore diverged and the checkpoint is treated as a
    miss. The counts are deterministic integers, so they never cause a false miss on
    OCCT float noise, and they catch a same-bbox but topologically different solid the
    box alone would wave through — measured stable across a real BREP round trip on
    400 bodies of the reference assembly.

    Every term here is chosen for cost: this runs per body inside _restore_from_disk,
    which walks 3,072 of them on that assembly (see the loop's comment for what the
    old cost did to the stall supervisor).

    - Counts come from TopExp.MapShapes_s, not build123d's `.faces()/.edges()/
      .vertices()`, which build a full list of wrapper objects just to take len() —
      measured 45x slower, and `.edges()` additionally runs a Python-level degenerate
      filter over every edge. These counts therefore INCLUDE degenerate edges, which
      is fine for a fingerprint (still deterministic) but means a value taken here is
      NOT comparable with one taken through build123d.
    - The box is BRepBndLib's poles-based one, not `shape.bounding_box()` (OCCT's
      exact AddOptimal_s): 0.080 ms/body against 67.3 ms.
    - `useTriangulation` MUST stay False. With True the box shifts by up to 0.49 mm
      once a shape carries a triangulation — 492x the 1e-3 compare tolerance — and a
      body IS tessellated when the checkpoint is written and is NEVER tessellated when
      restored, so True would false-miss intermittently and force a cold rebuild. That
      is also why `tessellate.mesh_bbox` (True by design) must not be reused here
      despite computing the same kind of box.
    - Volume is deliberately absent: 23.0 ms/body buying discrimination the counts and
      the box already provide. A blob-key collision restores either a different part
      (caught by the counts) or the same part at a different placement (caught by the
      box)."""
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_VERTEX
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedMapOfShape

    def count(kind):
        m = TopTools_IndexedMapOfShape()
        TopExp.MapShapes_s(shape.wrapped, kind, m)
        return m.Extent()

    bnd = Bnd_Box()
    BRepBndLib.Add_s(shape.wrapped, bnd, False)
    return {
        "f": count(TopAbs_FACE),
        "e": count(TopAbs_EDGE),
        "vx": count(TopAbs_VERTEX),
        "b": [] if bnd.IsVoid() else [round(x, 4) for x in bnd.Get()],
    }


def _blob_key(chain_key, body_id):
    """One feature can modify SEVERAL bodies (extrude-cut across overlapping
    bodies, boolean): the chain key alone would collide their blobs and the
    dedup skip in put_blob would silently keep only the first one written
    (caught by the restore fingerprint guard). Mix the body id in."""
    return hashlib.blake2b(
        (chain_key + ":" + str(body_id)).encode(), digest_size=16
    ).hexdigest()


def _persist_tick(persist, i, dt_s, bodies, datums, errors, counter, diagnostics=None,
                  sketch_planes=None):
    """Per-feature bookkeeping for the durable cache: track each body's
    last-modifying chain key (shape-identity comparison, O(bodies)), and drop a
    budget-spaced checkpoint when accumulated replay cost since the last one
    exceeds the budget (~1 s). Written DURING the loop on purpose: a timeout or
    crash then loses at most one budget's worth of work (the ratchet)."""
    keys = persist["keys"]
    mod = persist["mod"]
    for b in bodies:
        cur = mod.get(b["id"])
        sh = b.get("shape")
        if cur is None or cur[0] is not sh:
            mod[b["id"]] = (sh, _blob_key(keys[i], b["id"]))
    persist["acc_ms"] += dt_s * 1000.0
    if persist["acc_ms"] < persist.get("budget_ms", 1000.0):
        return
    _save_checkpoint(persist, i, bodies, datums, errors, counter["n"], diagnostics,
                     sketch_planes)


def _save_checkpoint(persist, i, bodies, datums, errors, counter_n, diagnostics=None,
                     sketch_planes=None):
    """Best-effort: a cache write failure must never break a rebuild."""
    try:
        store, keys, mod = persist["store"], persist["keys"], persist["mod"]
        manifest, fps, owners = [], [], {}
        textures = {}
        for b in bodies:
            # One tick per body, at the top so every path through the loop
            # counts (the shapeless `continue` below included). Serialising a
            # body's B-rep to the blob store is the expensive part, and on a
            # large assembly this loop alone can outrun the stall timeout.
            progress_tick()
            sh = b.get("shape")
            # The assembly-tree node this body came from. Body metadata that is
            # NOT recoverable from the shape, exactly like `_owners` and
            # `_textures` below — and an import always blows the checkpoint
            # budget, so a disk resume is the NORMAL way an assembly document
            # reopens. Omitting it here would flatten the tree on every reopen,
            # with no error and nothing for `_body_fingerprint` to catch, since
            # that compares geometry only.
            node_ref = b.get("node_ref")
            entry = {"body_id": b["id"], "name": b["name"], "blob_key": None}
            if node_ref:
                entry["node_ref"] = node_ref
            # Same class of state, and the same trap: `_intact` exempts an
            # explicitly collapsed import from _drop_debris, and it is NOT
            # recoverable from the shape. Dropping it here would let the debris
            # pass delete legitimate small parts on every disk resume — which is
            # the NORMAL way an assembly document reopens, since an import always
            # blows the checkpoint budget. Third time this key set has bitten:
            # `_textures`, then `node_ref`, now this.
            if b.get("_intact"):
                entry["_intact"] = True
            if sh is None or _wrapped_or_none(sh) is None:
                manifest.append(entry)
                fps.append(None)
                continue
            blob_key = (mod.get(b["id"]) or (None, _blob_key(keys[i], b["id"])))[1]
            store.put_blob(blob_key, sh)
            entry["blob_key"] = blob_key
            manifest.append(entry)
            fps.append(_body_fingerprint(sh))
            owners[b["id"]] = [[list(k), v] for k, v in (b.get("_owners") or {}).items()]
            # `_textures` is body state that is NOT in the shape: _handle_texture
            # stores the raw spec and displacement happens lazily at tessellation.
            # Without persisting it, a disk resume past the texture feature returned
            # an untextured body with no error — the mesh AND the export silently
            # lost the texture. Same class of state as `_owners` above.
            if b.get("_textures"):
                textures[b["id"]] = b["_textures"]
        state = json.dumps({
            "datums": datums,
            # Rides with `datums` for the same reason, and one more: the resume
            # below REPLAYS the prefix's sketches with no bodies to resolve a
            # face against, so without this a resumed build would put a
            # face-anchored sketch back on its stale cached plane.
            "sketch_planes": sketch_planes or {},
            "errors": errors,
            # diagnostics ride along with errors so a disk resume can re-report
            # BOTH (see _snapshot). Every producer emits plain JSON scalars; if
            # one ever emits something json can't encode, this whole write fails
            # into the `except` below and SILENTLY disables the disk cache — hence
            # test_checkpoint's serializability guard.
            "diagnostics": diagnostics or [],
            "n": counter_n,
            "owners": owners,
            "textures": textures,
            "fps": fps,
        })
        store.save_checkpoint(keys[i], i, manifest, state, persist["acc_ms"])
        persist["acc_ms"] = 0.0
    except Exception:
        pass


def _restore_from_disk(store, chain_keys):
    """Find the deepest restorable checkpoint for this exact document prefix and
    reconstruct a resume snapshot from it. Returns (start_index, snapshot, mod_map)
    or None. Every failure path — missing blob, fingerprint mismatch, bad JSON —
    returns None (cache miss), never partial state."""
    try:
        cp = store.find_checkpoint(chain_keys)
        if cp is None:
            return None
        state = json.loads(cp["state_json"])
        bodies = []
        mod = {}
        for ent, fp in zip(cp["manifest"], state["fps"]):
            # One tick per body, at the top so every path through the loop counts —
            # same rule as the checkpoint-WRITE loop. Ticking INSIDE matters: this
            # restore measured 146.2 s on the 356 MiB reference assembly (3,072
            # bodies) against STALL_TIMEOUT = 60 s, and the ticks used to sit only
            # before and after, leaving one silent 146 s gap. The supervisor reaped
            # the worker at 60 s, before rebuild_cached's first print — which is why
            # the document simply never opened and NOTHING was logged. Cheapening
            # _body_fingerprint brought the same restore under 8.5 s, but a bigger
            # assembly would walk into the same wall; the tick is the real fix.
            progress_tick()
            if ent["blob_key"] is None:
                shapeless = {"id": ent["body_id"], "name": ent["name"],
                             "shape": None, "_owners": {}}
                if ent.get("node_ref"):
                    shapeless["node_ref"] = ent["node_ref"]
                if ent.get("_intact"):
                    shapeless["_intact"] = True
                bodies.append(shapeless)
                continue
            raw = store.get_blob(ent["blob_key"])
            if raw is None:
                return None
            shape = _wrap_topods(raw)
            if shape is None:
                return None
            got = _body_fingerprint(shape)
            # e/vx were always computed and stored but never actually compared; they
            # carry the discrimination the dropped volume term used to add, for free.
            if (got["f"] != fp["f"]
                    or got["e"] != fp["e"]
                    or got["vx"] != fp["vx"]
                    or len(got["b"]) != len(fp["b"])
                    or any(abs(a - c) > 1e-3 for a, c in zip(got["b"], fp["b"]))):
                return None  # diverged restore = miss, never wrong geometry
            body = {
                "id": ent["body_id"], "name": ent["name"], "shape": shape,
                "_owners": {
                    tuple(k): v
                    for k, v in state.get("owners", {}).get(ent["body_id"], [])
                },
            }
            # only set the key when the body really is textured, so a plain body's
            # dict stays exactly as it was before textures were persisted
            tex = state.get("textures", {}).get(ent["body_id"])
            if tex:
                body["_textures"] = tex
            # same rule for the assembly-tree node: absent on every body that did
            # not come from a manifest-bound import, and on every checkpoint
            # written before this existed
            if ent.get("node_ref"):
                body["node_ref"] = ent["node_ref"]
            if ent.get("_intact"):
                body["_intact"] = True
            bodies.append(body)
            mod[ent["body_id"]] = (shape, ent["blob_key"])
        snap = {
            "bodies": bodies,
            "sketches_ref": {}, "n_sketches": 0,  # rebuilt via replay_sketches
            "datums": state["datums"],
            # .get for the same reason "diagnostics" has one below.
            "sketch_planes": state.get("sketch_planes", {}),
            "n": state["n"],
            "errors_ref": state["errors"], "n_errors": len(state["errors"]),
            # .get: checkpoints written before diagnostics were persisted have no
            # such key. In practice _env_sig hashes builder.py into every chain
            # key, so those rows can no longer be matched at all — this is purely
            # so a stale row degrades to the old behaviour instead of raising.
            "diags_ref": state.get("diagnostics", []),
            "n_diags": len(state.get("diagnostics", [])),
            "replay_sketches": True,
        }
        return cp["feat_index"] + 1, snap, mod
    except Exception:
        return None


# RAM snapshots kept per feature (beyond disk checkpoints); bounds worker memory
# (~0.2 MB/snapshot measured, so 300 ≈ 60 MB) — a resume below the window falls
# through to the disk cache. SINDRI_RAM_SNAP_WINDOW overrides for large docs / tight RAM.
