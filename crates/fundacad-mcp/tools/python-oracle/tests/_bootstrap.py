"""Puts the oracle and the shared client on sys.path so `import render` and
`from client import McpClient` resolve.

The same arrangement sidecar/tests/_bootstrap.py uses, and for the same reason:
these files run directly, which puts tests/ on sys.path and neither of those.
"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_TOOLS = os.path.dirname(_ROOT)
for _p in (_TOOLS, _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

#: The server these suites test. The shared client defaults to the Rust one.
ORACLE_SERVER = os.path.join(_ROOT, "server.py")

# NO TEST MAY FIND THE RUNNING APP.
#
# Discovery reads a session file the app publishes in its app data directory, so
# a Server built by a test on a machine with FundaCAD open attaches to it, and
# every tool that changes the document then PUSHES that change into the document
# on the user's screen. Running the suite once with the app open put six
# features into it, one undo step each: the tests passed their own assertions
# against the app's document rather than their own, and the damage was in
# another process.
#
# Pointing discovery at a path that cannot exist is the whole fix: read_session_file
# returns None without dialling anything, so there is no attach and no connect
# timeout either. setdefault, not assignment, so a test that wants a session of
# its own still sets one (test_live_session.py does, per subprocess, and says so).
os.environ.setdefault(
    "FUNDACAD_SESSION_FILE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "no-app-in-tests.json"),
)
