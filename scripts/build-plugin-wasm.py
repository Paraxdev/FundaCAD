#!/usr/bin/env python3
"""Build a plugin's geometry component: plugins/<id>/geometry-rs to plugins/<id>/geometry.wasm.

A plugin that owns geometry for the Rust engine carries a Rust crate in
`geometry-rs/` built against crates/fundacad-geom/wit/plugin.wit, and names the
component in its manifest as `"geometryWasm": "geometry.wasm"`. The component is
a build artifact: it is written beside the manifest, ignored by git, and packed
into the bundle by scripts/build-plugins.py, which calls `build` below.

Needs the wasm32-wasip2 target (`rustup target add wasm32-wasip2`). CARGO picks
the cargo to run, for a machine where the first one on PATH is the wrong one.

Usage:
    python scripts/build-plugin-wasm.py [plugin id ...]

With no ids, every plugin that has a geometry-rs crate is built.
"""

import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGINS = os.path.join(REPO, "plugins")

CRATE_DIR = "geometry-rs"
TARGET = "wasm32-wasip2"
OUTPUT = "geometry.wasm"


def crate_of(src):
    """The plugin's geometry crate directory, or None."""
    d = os.path.join(src, CRATE_DIR)
    return d if os.path.isfile(os.path.join(d, "Cargo.toml")) else None


def _package_name(crate):
    with open(os.path.join(crate, "Cargo.toml"), encoding="utf-8") as fh:
        in_package = False
        for line in fh:
            s = line.strip()
            if s.startswith("["):
                in_package = s == "[package]"
            elif in_package and s.startswith("name"):
                return s.split("=", 1)[1].strip().strip('"').replace("-", "_")
    sys.exit(f"{crate}/Cargo.toml has no package name")


def build(pid, src):
    """Compile the component and copy it to <src>/geometry.wasm. Returns its path."""
    crate = crate_of(src)
    if crate is None:
        sys.exit(f"plugins/{pid} has no {CRATE_DIR}/Cargo.toml")
    cargo = os.environ.get("CARGO") or shutil.which("cargo")
    if cargo is None:
        sys.exit(f"cargo is not on PATH, and plugins/{pid} needs it to build {OUTPUT}")
    r = subprocess.run(
        [cargo, "build", "--release", "--locked", "--target", TARGET],
        cwd=crate, capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"plugins/{pid}: could not build {OUTPUT}\n{r.stdout}{r.stderr}")
    built = os.path.join(crate, "target", TARGET, "release", _package_name(crate) + ".wasm")
    out = os.path.join(src, OUTPUT)
    shutil.copyfile(built, out)
    return out


def main():
    only = set(sys.argv[1:])
    found = 0
    for name in sorted(os.listdir(PLUGINS)):
        src = os.path.join(PLUGINS, name)
        if only and name not in only:
            continue
        if crate_of(src) is None:
            if only:
                sys.exit(f"plugins/{name} has no {CRATE_DIR} crate")
            continue
        out = build(name, src)
        print(f"{out}  ({os.path.getsize(out)} bytes)")
        found += 1
    if not found:
        sys.exit("no plugin has a geometry-rs crate")


if __name__ == "__main__":
    main()
