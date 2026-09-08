"""Where the server looks for the geometry engine.

From a source checkout the answer is a sibling directory and always has been.
Installed as a plugin there is no sibling: the plugin lives under the app data
directory and the engine's sources are in the app's resources, so the app hands
the path over in the environment when it writes the launch command.

Both readings have a way to be silently wrong, and each test here is one of
them. An override that is ignored sends an installed plugin looking under
`<app data>/plugins/mcp/sidecar`, which does not exist, and the failure surfaces as
a FileNotFoundError from Popen naming a path nobody set. An override that is
trusted without checking does the same thing while looking like it worked.

Run: uv run python plugins/mcp/tests/test_sidecar_dir.py
"""

import _bootstrap  # noqa: F401
import _run

import os
import tempfile

import sidecar_link

VARS = ("FUNDACAD_SIDECAR_DIR", "SINDRI_SIDECAR_DIR", "SINDRICAD_SIDECAR_DIR")


class env:
    """Set the override, and put back whatever was there."""

    def __init__(self, value):
        self.value = value

    def __enter__(self):
        self.saved = {k: os.environ.get(k) for k in VARS}
        for k in VARS:
            os.environ.pop(k, None)
        if self.value is not None:
            os.environ["FUNDACAD_SIDECAR_DIR"] = self.value

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def default_dir():
    """Where the engine is in THIS checkout, worked out from this test file
    rather than from the module under test.

    Counted from here on purpose: sidecar_link searches upward for a directory
    containing sidecar/server.py, so an expectation that searched the same way
    would agree with a broken search. This file is at plugins/mcp/tests/, three
    levels under the root, and if that ever stops being true this line is the
    one that says so."""
    here = os.path.dirname(os.path.abspath(__file__))          # .../plugins/mcp/tests
    root = os.path.dirname(os.path.dirname(os.path.dirname(here)))
    return os.path.join(root, "sidecar")


def test_a_checkout_finds_the_engine_in_it():
    """The control for everything below: with nothing set, the answer is the
    engine this repository has, and it is really there."""
    with env(None):
        found = sidecar_link.sidecar_dir()
    assert os.path.isdir(found), found
    assert os.path.samefile(found, default_dir()), found


def test_an_installed_plugin_is_told_where_the_engine_is():
    with tempfile.TemporaryDirectory() as tmp:
        with env(tmp):
            found = sidecar_link.sidecar_dir()
        assert os.path.samefile(found, tmp), found


def test_an_override_naming_nothing_is_not_believed():
    """A path that is not there is a setting that is wrong, and falling back to
    the sibling turns it into a working session with a confusing engine rather
    than an error message about a directory that does not exist."""
    missing = os.path.join(tempfile.gettempdir(), "fundacad-no-such-engine-dir")
    assert not os.path.exists(missing)
    with env(missing):
        found = sidecar_link.sidecar_dir()
    assert os.path.samefile(found, default_dir()), found


if __name__ == "__main__":
    _run.run(globals(), "sidecar directory")
