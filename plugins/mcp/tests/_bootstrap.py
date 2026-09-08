"""Puts mcp/ on sys.path so `import render` resolves.

The same arrangement sidecar/tests/_bootstrap.py uses, and for the same reason:
these files run directly (`uv run python mcp/tests/test_render.py`), which puts
tests/ on sys.path and not mcp/.
"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
