"""Put the sidecar and this plugin's geometry on sys.path, and register it the way the engine does."""

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

for _t in ("teardropHole", "roofBridge", "counterboreBridge", "sacrificialLayer"):
    assert plugin_geometry.handler_for(_t) is not None, (
        f"{_t} did not register: check manifest.json's {plugin_geometry.MANIFEST_ENTRY!r} entry "
        f"(broken: {plugin_geometry.broken_plugins()})"
    )
