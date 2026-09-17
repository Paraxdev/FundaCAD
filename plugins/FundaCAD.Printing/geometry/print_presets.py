"""OrcaSlicer preset flattening, so a handed-off project opens on the user's own
machine preset.

A minimal `printer_model` stub is NOT enough for OrcaSlicer to bind a machine
preset on "open as project", it falls back to "-" (no printer, no print host).
So the user's ACTIVE machine preset is flattened (its `inherits` chain resolved
the way Orca does) together with a compatible process and filament, and the
result is embedded in Metadata/project_settings.config. The palette still owns
the colours.

This used to be Rust in the app shell. It reads the slicer's own files, which is
knowledge about one slicer, so it lives with the plugin that talks to it.
"""

import json
import os

#: preset fields that are per-file metadata, not effective config, dropped after
#: the inherits chain is merged (mirrors the Orca preset model).
META_KEYS = (
    "inherits", "from", "name", "setting_id", "filament_id", "renamed_from",
    "is_custom_defined", "version", "upward_compatible_machine", "instantiation",
)


def _read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def index_presets(datadir, kind):
    """name -> path for every preset of a kind. System first, then user/default so
    a user preset shadows a same-named system one."""
    dirs = []
    sysroot = os.path.join(datadir, "system")
    try:
        vendors = sorted(os.listdir(sysroot))
    except OSError:
        vendors = []
    for v in vendors:
        kd = os.path.join(sysroot, v, kind)
        if os.path.isdir(kd):
            dirs.append(kd)
            for sub in sorted(os.listdir(kd)):
                if os.path.isdir(os.path.join(kd, sub)):
                    dirs.append(os.path.join(kd, sub))  # one level of vendor subdirs
    dirs.append(os.path.join(datadir, "user", "default", kind))  # user last, wins

    idx = {}
    for d in dirs:
        try:
            entries = sorted(os.listdir(d))
        except OSError:
            continue
        for fn in entries:
            if not fn.endswith(".json"):
                continue
            path = os.path.join(d, fn)
            try:
                name = _read_json(path).get("name")
            except (OSError, ValueError, AttributeError):
                continue
            if isinstance(name, str):
                idx[name] = path
    return idx


def resolve_chain(idx, name):
    """Flatten one preset by walking its `inherits` chain (root first, child
    overrides parent). Returns (merged config, set of names in the chain)."""
    chain, names = [], set()
    cur = name
    while cur is not None and cur not in names:
        names.add(cur)
        path = idx.get(cur)
        if path is None:
            raise ValueError(f"preset not found: {cur}")
        v = _read_json(path)
        chain.append(v)
        inh = v.get("inherits") if isinstance(v, dict) else None
        cur = inh if isinstance(inh, str) and inh else None
    out = {}
    for v in reversed(chain):
        if isinstance(v, dict):
            out.update(v)
    for k in META_KEYS:
        out.pop(k, None)
    return out, names


def is_compatible(idx, name, chain):
    """True if a preset is compatible with the machine. The candidate's own
    chain is resolved first, so a sparse user override inherits
    `compatible_printers` from its system parent."""
    try:
        cfg, _ = resolve_chain(idx, name)
    except (OSError, ValueError):
        return False
    cp = cfg.get("compatible_printers")
    return isinstance(cp, list) and any(isinstance(s, str) and s in chain for s in cp)


def is_user_preset(path, datadir=None):
    """True when a preset file sits under the datadir's `user/` tree. A whole path
    component, not a substring, so it holds for either separator, and taken
    relative to the datadir, whose own path may well contain a `user`."""
    if datadir:
        path = os.path.relpath(path, datadir)
    parts = os.path.normpath(path).replace("\\", "/").split("/")
    return "user" in parts


def pick_preset(idx, chain, hints, datadir=None):
    """Best preset of a kind for the machine: compatible with it, preferring the
    user's own presets, then a name hint (e.g. "0.20"), then alphabetical."""
    user, system = [], []
    for name, path in idx.items():
        if is_compatible(idx, name, chain):
            (user if is_user_preset(path, datadir) else system).append(name)
    for pool in (sorted(user), sorted(system)):
        for n in pool:
            if all(h in n for h in hints):
                return n
        if pool:
            return pool[0]
    return None


def project_settings(datadir, filament_count):
    """The project_settings config for a handoff: the ACTIVE machine preset plus
    a compatible process and filament, all flattened. Embedding all three is what
    makes Orca bind real named presets on "open as project" (a machine-only config
    makes it invent blank project-custom ones named after the file)."""
    if not datadir or not os.path.isdir(datadir):
        raise ValueError(f"Orca datadir not found: {datadir}")
    conf = _read_json(os.path.join(datadir, "OrcaSlicer.conf"))
    machine = (conf.get("presets") or {}).get("machine") if isinstance(conf, dict) else None
    if not isinstance(machine, str) or not machine:
        raise ValueError("no active machine preset in OrcaSlicer.conf")

    m_idx = index_presets(datadir, "machine")
    cfg, chain = resolve_chain(m_idx, machine)

    p_idx = index_presets(datadir, "process")
    proc = pick_preset(p_idx, chain, ["0.20"], datadir)
    if proc:
        try:
            pcfg, _ = resolve_chain(p_idx, proc)
            cfg.update(pcfg)
            cfg["print_settings_id"] = proc
        except (OSError, ValueError):
            pass

    n = max(1, int(filament_count or 1))
    f_idx = index_presets(datadir, "filament")
    fil = pick_preset(f_idx, chain, ["PLA"], datadir)
    if fil:
        try:
            fcfg, _ = resolve_chain(f_idx, fil)
            for k, v in fcfg.items():
                one = v[0] if isinstance(v, list) and v else v
                cfg[k] = [one] * n
            cfg["filament_settings_id"] = [fil] * n
        except (OSError, ValueError):
            pass

    cfg.setdefault("printer_settings_id", machine)
    cfg.pop("filament_colour", None)  # palette owns the colors
    cfg.pop("compatible_printers", None)  # not meaningful in a project config
    return cfg
