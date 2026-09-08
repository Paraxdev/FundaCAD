#!/usr/bin/env python3
"""Package everything in plugins/ as installable plugin bundles.

One script for all of them rather than one per plugin. A per-plugin script is a
per-plugin chance to get the reproducibility wrong, and the reproducibility is
the whole reason this is a program and not a `zip` invocation.

A PLUGIN IS A DIRECTORY UNDER plugins/ WITH A manifest.json IN IT. That is the
entire rule. Adding a plugin means adding a directory, not editing this file,
and a directory without a manifest is skipped rather than packaged into
something that cannot be installed.

EXCEPT the builtins, which are skipped. A plugin of kind "builtin" is the app's
own code, shipped inside the app and only turned on and off; there is no zip for
it to arrive in and nothing that could install one. Packaging it would put an
asset on the release that nothing can consume, under a name the app would then
be entitled to offer as a download.

The bundle is a zip with manifest.json and the plugin's sources at the TOP level,
because the app runs `<plugin dir>/<entry>` and the entry point puts its own
directory on sys.path. Nothing is vendored: for a Python plugin the interpreter
and the packages both come from the runtime the app already installed, handed
over in the launch command the Plugins section produces.

Left out: tests (they import from the repository and could only ever fail from
inside a bundle), every byte of __pycache__ (a compiled file from whichever
interpreter happened to run last is not part of the plugin), and the build
leftovers of a compiled plugin (`target/`, `node_modules/`).

Python rather than a shell script with `zip`, for two reasons. The Windows
development box has no `zip`, so a shell version could only ever be run in CI,
which is the worst place to find out it is wrong. And the archive here is
written with a fixed timestamp and sorted entries, so two builds of identical
sources produce identical bytes: a digest that changes for no reason is a
digest nobody bothers to compare.

Usage:
    python scripts/build-plugins.py [output directory] [plugin id ...]

With no ids, every plugin is built.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGINS = os.path.join(REPO, "plugins")

MANIFEST = "manifest.json"
CODE = "main.js"

SKIP_DIRS = {"tests", "__pycache__", "target", "node_modules", ".git"}

# .pyc for the obvious reason. .ts and .vue for a less obvious one: a plugin
# directory may carry an APP-SIDE COMPANION -- the settings block a process
# plugin contributes, the activation module a built-in is -- and that code is
# compiled into the application, not run out of the bundle. The app has no way
# to run a .ts from a zip and never will without a decision nobody has taken, so
# shipping the source would be shipping a file that looks like it does something
# and does nothing at all. What the bundle carries is what the far side runs.
SKIP_SUFFIX = (".pyc", ".ts", ".vue")

# 1980-01-01, the earliest a zip entry can carry. Any fixed value would do; the
# point is that it is not "now".
FIXED_TIME = (1980, 1, 1, 0, 0, 0)

#: What a plugin of each kind must contain to be worth shipping. Checked here
#: rather than left to the install to discover: a bundle missing its entry
#: point installs perfectly and then does nothing, which is the most annoying
#: shape a failure can have.
#:
#: `builtin` is here because a builtin is no longer something that ships INSIDE
#: the app. The word describes REACH -- it runs in the application's own
#: JavaScript context, with the application's own reach, which is what
#: sandboxNote("builtin") tells the person on the consent screen. Where it comes
#: from is a separate question, and the answer is now the same as for every
#: other kind: a zip on a release.
ENTRY = {
    "builtin": CODE,
    "process": "server.py",
    "compute": "plugin.js",
    "panel": "index.html",
}

#: The app-side module of a plugin that runs in the window, built by
#: scripts/build-plugin-code.mjs and read back by src-tauri's plugin_code.
#: Generated into the bundle rather than committed: it is a build artifact of the
#: directory beside it, and a committed copy is a copy that can be stale.

#: Ships inside the app, so there is no bundle to build. See the module docs.
BUILTIN = "builtin"

#: `Publisher.Name`, or a bare name. Mirrors ID in src/plugins/manifest.ts,
#: which is the copy that decides whether a bundle installs; this one only
#: refuses to NAME an asset something the app would not accept back, so that
#: the failure lands here rather than on a release nobody can install from.
ID = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,30}(\.[A-Za-z][A-Za-z0-9-]{0,30})?$")


def read_manifest(pid, src):
    with open(os.path.join(src, MANIFEST), encoding="utf-8") as fh:
        try:
            return json.load(fh)
        except ValueError as e:
            sys.exit(f"plugins/{pid}/{MANIFEST} is not readable JSON: {e}")


def discover(only):
    """Plugin directories to build, as (id, path)."""
    if not os.path.isdir(PLUGINS):
        sys.exit("no plugins/ directory")
    out = []
    skipped = []
    for name in sorted(os.listdir(PLUGINS)):
        path = os.path.join(PLUGINS, name)
        if not os.path.isdir(path) or not os.path.isfile(os.path.join(path, MANIFEST)):
            continue
        if only and name not in only:
            continue
        out.append((name, path))
    if only:
        missing = sorted(set(only) - {n for n, _ in out})
        if missing:
            sys.exit("no such plugin: " + ", ".join(missing))
    return out


def build_code(pid, src):
    """Compile a plugin's app-side module, and hand back (name, bytes).

    Only for the kind that has one. The build is a vite library build and it is
    the slow part of packaging, so it runs once per plugin and its output goes
    straight into the zip rather than onto the disk beside the source, where a
    stale copy could be committed by accident.
    """
    node = shutil.which("node")
    if node is None:
        sys.exit("node is not on PATH, and a builtin's bundle needs it to build main.js")
    script = os.path.join(REPO, "scripts", "build-plugin-code.mjs")
    with tempfile.TemporaryDirectory() as tmp:
        target = os.path.join(tmp, CODE)
        r = subprocess.run(
            [node, script, src, target],
            cwd=REPO, capture_output=True, text=True,
        )
        if r.returncode != 0:
            sys.exit(f"plugins/{pid}: could not build {CODE}\n{r.stdout}{r.stderr}")
        with open(target, "rb") as fh:
            return CODE, fh.read()


def sources(src):
    """Every file that belongs in a bundle, as (archive name, full path)."""
    out = []
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if name.endswith(SKIP_SUFFIX):
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            out.append((rel, full))
    return sorted(out)


def check(pid, src):
    """Refuse to package something that could not work once installed."""
    manifest = read_manifest(pid, src)

    if not ID.match(pid):
        sys.exit(f"plugins/{pid} is not a usable plugin id (Publisher.Name, ASCII)")
    if manifest.get("id") != pid:
        # The directory name is what the release asset is named after and what
        # the app installs into. A manifest disagreeing with it would install
        # under one name and be looked for under another.
        sys.exit(f"plugins/{pid}/{MANIFEST} says id {manifest.get('id')!r}, not {pid!r}")

    kind = manifest.get("kind")
    entry = ENTRY.get(kind)
    if entry is None:
        sys.exit(f"plugins/{pid}/{MANIFEST} has an unknown kind: {kind!r}")
    # A builtin's entry point is GENERATED from main.ts, so what has to be on
    # disk is the source it is generated from.
    on_disk = "main.ts" if kind == BUILTIN else entry
    if not os.path.isfile(os.path.join(src, on_disk)):
        sys.exit(f"plugins/{pid} is kind {kind} and has no {on_disk}")
    return manifest


def build(pid, src, out_dir):
    manifest = check(pid, src)
    zip_path = os.path.join(out_dir, f"plugin-{pid}.zip")
    entries = sources(src)
    generated = []
    if os.path.isfile(os.path.join(src, "main.ts")):
        # A bundle may carry app-side code whatever its kind, and two kinds may
        # not: `compute` and `panel` are described to the person as contained
        # ("no network and no access to your files, so the list above is all it
        # can do"), and app-side code would make that sentence false. src-tauri's
        # plugin_code refuses to serve one; this refuses to build one.
        if manifest.get("kind") not in (BUILTIN, "process"):
            sys.exit(
                f"plugins/{pid} is kind {manifest.get('kind')} and has a main.ts. "
                "That kind is described as contained, so it cannot carry code that "
                "runs in the app."
            )
        generated.append(build_code(pid, src))

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, data in generated:
            info = zipfile.ZipInfo(rel, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, data)
        for rel, full in entries:
            info = zipfile.ZipInfo(rel, date_time=FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            # 0644 as a regular file. Left explicit because the default carries
            # whatever the checkout happened to have, and on Windows that is
            # not the same as on the release runner.
            info.external_attr = 0o100644 << 16
            with open(full, "rb") as fh:
                z.writestr(info, fh.read())

    with open(zip_path, "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()

    print(zip_path)
    # Generated first, exactly as they are written, so the listing is what is IN
    # the zip rather than what was on disk beside it.
    for rel, data in generated:
        print(f"  {rel}  ({len(data)} bytes, built)")
    for rel, _ in entries:
        print("  " + rel)
    print(digest + "  " + os.path.basename(zip_path))
    return zip_path


def main():
    args = sys.argv[1:]
    out_dir = args[0] if args else os.path.join(REPO, "dist-plugins")
    only = set(args[1:])

    found = discover(only)
    if not found:
        sys.exit("nothing to build: no directory under plugins/ has a " + MANIFEST)

    os.makedirs(out_dir, exist_ok=True)
    for pid, src in found:
        build(pid, src, out_dir)


if __name__ == "__main__":
    main()
