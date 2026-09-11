"""Make this plugin's geometry importable, and register it, the way the app does.

Imported for its side effects by every test file here, the same way sidecar/tests
does it: these run as `__main__` scripts (`uv run python test_texture.py`), so a
pytest-only conftest would leave them with an empty sys.path and no registry.

These tests exercise code that runs INSIDE the geometry engine, so they need the
same two things the engine arranges at startup: the sidecar package on the path
(`from builder import ...`), and this plugin's own directory on it, so that
`import texture` finds the copy in this plugin rather than anything else.

Registration goes through the real `plugin_geometry.discover()` rather than a
hand-rolled call to `register()`. That is the point of running it here: if the
manifest stops naming the geometry entry, or the entry stops registering the
feature type, these tests fail in the same way the application would, instead of
passing against a registry the test populated itself.
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

assert plugin_geometry.handler_for("texture") is not None, (
    "the texture feature did not register: check that manifest.json still names "
    f"{plugin_geometry.MANIFEST_ENTRY!r} and that register() claims the type "
    f"(broken: {plugin_geometry.broken_plugins()})"
)
