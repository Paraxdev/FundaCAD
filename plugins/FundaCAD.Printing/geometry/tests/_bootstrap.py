"""Make this plugin's geometry importable, and register it, the way the app does.

These run as `__main__` scripts from sidecar/, so the sidecar package and this
plugin's geometry directory both go on the path, and registration goes through
the real `plugin_geometry.discover()`, so a manifest that stops naming the entry
fails here the way the app would.
"""

import os
import sys

_GEOM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PLUGIN = os.path.dirname(_GEOM)
_REPO = os.path.dirname(os.path.dirname(_PLUGIN))
_SIDECAR = os.path.join(_REPO, "sidecar")

for p in (_SIDECAR, _GEOM):
    if p not in sys.path:
        sys.path.insert(0, p)

import plugin_geometry  # noqa: E402

plugin_geometry.discover()

assert plugin_geometry.exporter_for("print-project-3mf") is not None, (
    "the project exporter did not register: check that manifest.json still names "
    f"{plugin_geometry.MANIFEST_ENTRY!r} and that register() claims it "
    f"(broken: {plugin_geometry.broken_plugins()})"
)
