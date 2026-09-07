#!/usr/bin/env python3
"""Package mcp/ as an installable plugin bundle.

The bundle is a zip with plugin.json and the server's sources at the TOP level,
because the app launches ``<plugin dir>/server.py`` and server.py puts its own
directory on sys.path. Nothing is vendored into it: the interpreter and the
packages both come from the runtime the app already installed, handed over in
the launch command the Plugins section produces.

Left out: tests (they import from the repository and could only ever fail from
inside a bundle) and every byte of __pycache__ (a compiled file from whichever
interpreter happened to run last is not part of the plugin).

Python rather than a shell script with ``zip``, for two reasons. The Windows
development box has no ``zip``, so a shell version could only ever be run in
CI, which is the worst place to find out it is wrong. And the archive here is
written with a fixed timestamp and sorted entries, so two builds of identical
sources produce identical bytes: a digest that changes for no reason is a
digest nobody bothers to compare.

Usage: python scripts/build-plugin-mcp.py [output directory]
"""

import hashlib
import os
import sys
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(REPO, "mcp")

SKIP_DIRS = {"tests", "__pycache__"}
SKIP_SUFFIX = (".pyc",)

# 1980-01-01, the earliest a zip entry can carry. Any fixed value would do; the
# point is that it is not "now".
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def sources():
    """Every file that belongs in the bundle, as (archive name, full path)."""
    out = []
    for root, dirs, files in os.walk(SRC):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if name.endswith(SKIP_SUFFIX):
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, SRC).replace(os.sep, "/")
            out.append((rel, full))
    return sorted(out)


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "dist-plugins")
    for required in ("plugin.json", "server.py"):
        if not os.path.isfile(os.path.join(SRC, required)):
            sys.exit("missing mcp/" + required)

    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, "plugin-mcp.zip")

    entries = sources()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
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
    for rel, _ in entries:
        print("  " + rel)
    print(digest + "  " + os.path.basename(zip_path))


if __name__ == "__main__":
    main()
