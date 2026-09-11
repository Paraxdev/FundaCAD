"""Geometry that belongs to a plugin, registered at runtime instead of compiled in.

WHAT THIS IS FOR. A plugin that adds a modeling tool has to own the geometry the
tool makes, or it is not the owner of anything: it is a panel in front of code
that shipped with the application whether the plugin was installed or not. The
surface texture was exactly that for a long time. Its tool, its panel, its icon
and its history row lived under plugins/, and the two thousand lines that
actually displace a mesh lived in this directory, dispatched from a table in
builder.py that named "texture" in plain text. Uninstalling it removed the way
to make one and changed nothing about what the application could build.

So a plugin registers here, and what it registers is of two kinds.

A FEATURE HANDLER is a rebuild-time verb: the same shape as everything in
builder._FEATURE_HANDLERS, `(feature, ctx) -> None`, and it lands in the same
dispatch. This is what makes `{"type": "texture", ...}` mean something.

A MESH PASS is a tessellation-time hook, which the feature handler alone cannot
be. Displacement does not happen when the feature runs; it happens much later,
against the FINAL shape, so that a texture survives the booleans and fillets
applied after it. A pass therefore gets three callables and a version:

    resolve(body, spec, diag) -> [Face, ...]
        which faces of the FINAL shape one stashed spec lands on
    displace(face, tri, loc, ident, spec, density_cap, **kw)
        -> (positions, indices, normals) for one face
    code_version() -> int
        bumped by the plugin when its algorithm changes, so a mesh displaced by
        the previous version is never served out of a disk cache

WHERE THE SPECS LIVE. On the body dict under `BODY_KEY`, as a flat list, each
entry carrying `"pass"` to say whose it is. The core plumbing that carries that
list, the timeline snapshot, the checkpoint cache, the three mesh caches, treats
it as opaque JSON and never looks inside. It used to be called `_textures` and
the core knew what one was.

WHAT HAPPENS WITH NOTHING REGISTERED. Everything here answers empty, and the
application builds documents that have no plugin features in them exactly as it
did before. A document that DOES have one gets `unregistered()` naming the
plugin that owns the type, which is the whole of the missing-plugin warning: see
builder's dispatch and src/document/missingPlugins.ts for the two halves.

NO SANDBOX, AND THAT IS THE DESIGN. A registered module is imported into the
geometry worker and runs with everything that process has. That is the same
bargain the window side already offers a `builtin` plugin, and the same one
Blender, Rhino and Fusion make: geometry code that cannot call the kernel is
not geometry code. `sandboxNote("builtin")` is where the person is told, in the
words they read before they install.
"""

import importlib.util
import json
import os
import sys

import appenv

#: Where a body carries the specs of every pass that applies to it. One key for
#: all plugins, because the core plumbing that copies it around should not grow
#: a branch per plugin; `spec["pass"]` is what tells them apart.
BODY_KEY = "_mesh_passes"

#: The manifest field naming the module to import, relative to the plugin
#: directory. A plugin without one contributes no geometry and is not looked at.
MANIFEST_ENTRY = "geometry"

#: The manifest field listing the feature types a plugin owns. Used for the
#: warning when the plugin is NOT loaded, so it is read off the manifest of
#: every plugin found on disk, not off the ones that registered.
MANIFEST_TYPES = "featureTypes"


class MeshPass:
    """One plugin's tessellation-time hook. See the module docstring."""

    __slots__ = ("name", "plugin", "resolve", "displace", "code_version")

    def __init__(self, name, plugin, resolve, displace, code_version):
        self.name = name
        self.plugin = plugin
        self.resolve = resolve
        self.displace = displace
        self.code_version = code_version


# feature type -> (handler, plugin id)
_FEATURES = {}
# pass name -> MeshPass
_PASSES = {}
# feature type -> plugin id, for every plugin FOUND ON DISK whether or not its
# geometry loaded. This is what lets the warning name a plugin it could not run.
_OWNERS = {}
# plugin ids whose geometry module was imported successfully
_LOADED = set()
# plugin id -> the reason its geometry would not import, for the log and the
# diagnostic. A plugin that is installed but broken is a different failure from
# one that is absent and says so.
_BROKEN = {}

_discovered = False


# --- what a plugin calls ---------------------------------------------------


def register_feature(type_name, plugin, handler):
    """Claim a feature type. `handler(feature, ctx)` joins builder's dispatch."""
    if type_name in _FEATURES and _FEATURES[type_name][1] != plugin:
        raise ValueError(
            f"feature type {type_name!r} is already owned by "
            f"{_FEATURES[type_name][1]}, {plugin} cannot claim it too"
        )
    _FEATURES[type_name] = (handler, plugin)
    _OWNERS.setdefault(type_name, plugin)


def register_mesh_pass(name, plugin, resolve, displace, code_version):
    """Claim a tessellation-time pass. See the module docstring for the three
    callables."""
    if name in _PASSES and _PASSES[name].plugin != plugin:
        raise ValueError(
            f"mesh pass {name!r} is already owned by {_PASSES[name].plugin}, "
            f"{plugin} cannot claim it too"
        )
    _PASSES[name] = MeshPass(name, plugin, resolve, displace, code_version)


def stash(body, spec):
    """Append one pass spec to a body, REBINDING the list rather than mutating it.

    Body dicts are shallow-copied by builder._snapshot (`dict(b)`), so appending
    to an existing list would reach back through the shared reference and give
    every earlier snapshot the spec too. This cost a real bug once, when the
    list was called `_textures` and each feature handler did its own append.
    """
    body[BODY_KEY] = (body.get(BODY_KEY) or []) + [spec]


# --- what the core calls ---------------------------------------------------


def handler_for(type_name):
    """The registered handler for a feature type, or None."""
    ent = _FEATURES.get(type_name)
    return ent[0] if ent else None


def owner_of(type_name):
    """The plugin id that owns a feature type, whether or not it is loaded."""
    return _OWNERS.get(type_name)


def unregistered(type_name):
    """The user-facing reason a feature type cannot be built, or None if it can.

    Three different situations and three different sentences, because "unknown
    feature type: texture" told a person nothing they could act on. The document
    is fine in every one of them; what is missing is the code that reads it.
    """
    if type_name in _FEATURES:
        return None
    owner = _OWNERS.get(type_name)
    if owner is None:
        return f"unknown feature type: {type_name}"
    why = _BROKEN.get(owner)
    if why:
        return (
            f'this needs the "{owner}" plugin, which is installed but would not '
            f"load: {why}"
        )
    return (
        f'this needs the "{owner}" plugin, which is not installed. The feature '
        f"is kept in the document and will build again once it is."
    )


def specs(body):
    """The pass specs on a body, or None. The core's one reader of BODY_KEY."""
    return body.get(BODY_KEY) or None


def cache_key(body):
    """A cache key covering every pass on a body, or None if it has none.

    The code version of each contributing pass rides in the key, so a plugin
    that changes its algorithm cannot be served meshes its previous version
    displaced out of the disk cache. It is per pass rather than global: a
    texture update must not invalidate a different plugin's cached bodies.
    """
    sp = specs(body)
    if not sp:
        return None
    versions = {}
    for spec in sp:
        name = spec.get("pass")
        p = _PASSES.get(name)
        if p is not None:
            try:
                versions[name] = int(p.code_version())
            except Exception:
                versions[name] = -1
        else:
            # A spec whose pass is not loaded still belongs in the key: the
            # body meshes differently once the plugin arrives, and a stale
            # undisplaced mesh must not survive the install.
            versions[name] = -1
    return "%s:%s" % (
        json.dumps(versions, sort_keys=True),
        json.dumps(sp, sort_keys=True),
    )


def resolve(body, diag=None):
    """Every (spec, faces) pair on a body, across all its passes.

    Order is preserved across the whole list, which is what makes "a later
    feature wins a face an earlier one also claimed" mean timeline order even
    when the two come from different plugins.
    """
    sp = specs(body)
    if not sp:
        return None
    out = []
    for spec in sp:
        p = _PASSES.get(spec.get("pass"))
        if p is None:
            continue  # its plugin is gone; the build already warned
        try:
            faces = p.resolve(body, spec, diag)
        except Exception as ex:  # noqa: BLE001 - one pass must not stop the rest
            print(
                f"[plugin-geometry] {p.plugin}: resolving {spec.get('pass')!r} "
                f"failed: {type(ex).__name__}: {ex}",
                flush=True,
            )
            continue
        if faces:
            out.append((spec, faces))
    return out or None


def displace(spec, *args, **kw):
    """Run the owning pass's displacement for one face.

    `spec` is read TWICE on purpose and the caller passes it twice: once here to
    choose the pass, and again inside `args` as the argument the pass itself
    reads. Routing and payload are the same object, and collapsing them would
    mean either this function knowing the pass's argument order or the pass
    having to re-declare which one it is.

    Raises KeyError when the pass is not loaded. The caller already treats any
    exception here as "show this face undisplaced", so an uninstalled plugin
    degrades exactly like a displacement that threw, which is the behaviour that
    keeps a rebuild from dying on a missing plugin. In practice it cannot
    happen: `resolve` above drops the specs of passes it cannot run, so no such
    face ever reaches here.
    """
    p = _PASSES[spec.get("pass")]
    return p.displace(*args, **kw)


def has_pass(spec):
    """Whether the pass that made this spec is loaded and can displace it."""
    return spec.get("pass") in _PASSES


def loaded_plugins():
    """Plugin ids whose geometry is registered, sorted. For the log and tests."""
    return sorted(_LOADED)


def broken_plugins():
    """plugin id -> why its geometry would not import. For the log and tests."""
    return dict(_BROKEN)


# --- discovery -------------------------------------------------------------


def plugin_roots():
    """Directories that may contain plugin directories, most specific first.

    FUNDACAD_PLUGIN_DIR is what the Rust shell sets to the installed-plugins
    directory (src-tauri/src/plugins/mod.rs `plugins_root`). The repository's own
    plugins/ is the development fallback, so `python server.py` out of a checkout
    behaves like the installed app rather than silently building nothing.
    """
    out = []
    env = appenv.get("PLUGIN_DIR")
    if env:
        out.append(env)
    repo = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "plugins")
    if repo not in out:
        out.append(repo)
    return [d for d in out if os.path.isdir(d)]


def _read_manifest(d):
    try:
        with open(os.path.join(d, "manifest.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _import_module(plugin_id, path):
    """Import a plugin's geometry module under a name that cannot collide.

    The plugin's own directory goes on sys.path so that its module can import
    its siblings by plain name, which is how the rest of this package is written
    and what a plugin author will expect. APPENDED, never inserted: a plugin that
    happened to ship a `builder.py` or a `server.py` would otherwise shadow the
    engine's own module of that name for the whole process, from the moment it
    was installed, and the resulting failure would look like the engine being
    broken rather than like that plugin being present.

    What this does NOT solve is two plugins shipping the same module name, where
    whichever loaded first wins. That is the same hazard every plugin system with
    a flat import namespace has, Blender's included, and the answer is the same:
    a plugin's modules want distinctive names. The ENTRY module is exempt,
    because it is registered under a name namespaced by plugin id, so `register.py`
    is safe to reuse and is what the docs tell people to call it.
    """
    d = os.path.dirname(path)
    if d not in sys.path:
        sys.path.append(d)
    mod_name = "fundacad_plugin_%s" % plugin_id.replace(".", "_").replace("-", "_")
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"no loadable module at {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


def discover(force=False):
    """Find and import every installed plugin's geometry. Idempotent.

    NEVER RAISES. A plugin whose geometry will not import is recorded in
    `_BROKEN` and the rest are still loaded: one bad plugin must not take the
    geometry engine down with it, because the engine is also what builds the
    documents that have nothing to do with that plugin. What it costs instead is
    a named diagnostic on the features that needed it, which is the failure
    being visible rather than fatal.
    """
    global _discovered
    if _discovered and not force:
        return
    _discovered = True
    for root in plugin_roots():
        try:
            names = sorted(os.listdir(root))
        except OSError:
            continue
        for name in names:
            d = os.path.join(root, name)
            if not os.path.isdir(d):
                continue
            man = _read_manifest(d)
            if not man:
                continue
            pid = man.get("id") or name
            # Record ownership BEFORE trying to import, so a plugin that is
            # present but broken can still be named by the warning.
            for t in man.get(MANIFEST_TYPES) or []:
                _OWNERS.setdefault(t, pid)
            rel = man.get(MANIFEST_ENTRY)
            if not rel or pid in _LOADED or pid in _BROKEN:
                continue
            path = os.path.join(d, *str(rel).split("/"))
            if not os.path.isfile(path):
                _BROKEN[pid] = f"its manifest names {rel!r}, which is not in the bundle"
                continue
            try:
                mod = _import_module(pid, path)
                reg = getattr(mod, "register", None)
                if callable(reg):
                    reg(sys.modules[__name__], pid)
                _LOADED.add(pid)
            except Exception as ex:  # noqa: BLE001 - see the docstring
                _BROKEN[pid] = f"{type(ex).__name__}: {ex}"
                print(
                    f"[plugin-geometry] {pid}: geometry did not load: "
                    f"{type(ex).__name__}: {ex}",
                    flush=True,
                )


def source_stamp():
    """(name, mtime, size) for every plugin geometry file, for the pool's stamp.

    server._src_stamp watches this package so that a worker running stale code
    is noticed. A plugin's geometry is code the same worker imported and has
    exactly the same problem, so it is watched the same way. Without this,
    editing a plugin's geometry during development changes nothing until the app
    is restarted, with nothing to say why.
    """
    out = []
    for root in plugin_roots():
        for base, dirs, files in os.walk(root):
            dirs[:] = [x for x in sorted(dirs) if x not in ("__pycache__", "node_modules", ".git")]
            for fn in sorted(files):
                if not fn.endswith(".py"):
                    continue
                full = os.path.join(base, fn)
                try:
                    st = os.stat(full)
                except OSError:
                    continue
                out.append((os.path.relpath(full, root), st.st_mtime_ns, st.st_size))
    return tuple(sorted(out)) or None


def _reset_for_tests():
    """Drop everything registered. Tests only; see sidecar/tests/."""
    global _discovered
    _FEATURES.clear()
    _PASSES.clear()
    _OWNERS.clear()
    _LOADED.clear()
    _BROKEN.clear()
    _discovered = False
