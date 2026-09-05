"""The variables this app reads have had three names. All three must answer.

The rename is invisible inside this repository — every read goes through
appenv — and that is exactly what makes it dangerous. A variable of this kind is
set OUTSIDE the repository: a shell profile, a launcher script, a CI job, a
docker-compose file, a .desktop entry. Rename it here and every one of those
silently stops working, with no error and nothing in a log; the only symptom is
a disk cache that is on again, or a blob store pointing at the wrong directory.

So the compatibility is a claim, and a claim needs a test. Each one below has a
control that must fail if the fallback were widened into "any name wins".

Run:  uv run python tests/test_appenv.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import os
import sys
import tempfile
import traceback

import appenv

PASS = "  ok"

#: Every spelling of one variable, so a test can clear the lot.
ALL = [p + "TEST_KNOB" for p in (appenv.PREFIX,) + appenv.LEGACY_PREFIXES]


def _clear():
    for n in ALL:
        os.environ.pop(n, None)


def test_each_retired_spelling_still_answers():
    """The point of the module. A machine that set SINDRI_DISK_CACHE=0 two
    renames ago must still have its disk cache off."""
    for name in ALL:
        _clear()
        os.environ[name] = "set-by-" + name
        got = appenv.get("TEST_KNOB")
        assert got == "set-by-" + name, f"{name} was not read: {got!r}"
    _clear()
    print(PASS, f"all {len(ALL)} spellings answer: {', '.join(ALL)}")


def test_the_current_name_outranks_the_retired_ones():
    """The control for the test above. Someone who has both set is telling us
    which they mean by setting the CURRENT one; a fallback that fired first
    would hand them a stale value from a profile they forgot about."""
    _clear()
    for name in ALL:
        os.environ[name] = "from-" + name
    got = appenv.get("TEST_KNOB")
    _clear()
    assert got == "from-" + appenv.name("TEST_KNOB"), f"a retired name won: {got!r}"
    print(PASS, "with every spelling set, the current one wins")


def test_an_empty_value_is_an_answer_and_not_a_miss():
    """FUNDACAD_EXTRA_ORIGINS= means "no extra origins". Falling through to a
    stale SINDRI_EXTRA_ORIGINS there would do the opposite of what was asked,
    and would do it to the ORIGIN ALLOWLIST, which is a security control."""
    _clear()
    os.environ[appenv.name("TEST_KNOB")] = ""
    os.environ[ALL[1]] = "tauri://evil"
    got = appenv.get("TEST_KNOB", "default")
    _clear()
    assert got == "", f"an explicit empty value fell through to {got!r}"
    print(PASS, "an empty value is a value, not a miss")


def test_nothing_set_is_the_default():
    _clear()
    assert appenv.get("TEST_KNOB") is None
    assert appenv.get("TEST_KNOB", "d") == "d"
    print(PASS, "an unset variable is the default under every spelling")


def test_writing_clears_the_spellings_it_is_replacing():
    """A child handed two names that disagree would read whichever this module
    happens to try first — which is the current one, so the disagreement would be
    invisible here and load-bearing anywhere that reads os.environ directly."""
    _clear()
    os.environ[ALL[1]] = "stale"
    appenv.set_("TEST_KNOB", "fresh")
    assert os.environ[appenv.name("TEST_KNOB")] == "fresh"
    assert ALL[1] not in os.environ, "a retired spelling survived the write"

    env = appenv.apply_to({ALL[2]: "stale"}, "TEST_KNOB", "fresh")
    assert env == {appenv.name("TEST_KNOB"): "fresh"}, env

    appenv.clear("TEST_KNOB")
    assert not any(n in os.environ for n in ALL), "clear left a spelling behind"
    print(PASS, "a write leaves exactly one spelling set")


def test_an_existing_cache_directory_is_kept_rather_than_orphaned():
    """dir_under. A cache under the old name that stops being read does not
    disappear — it sits there, outside the budget that was supposed to bound it,
    while a second one grows beside it."""
    base = tempfile.mkdtemp(prefix="funda-appenv-")

    fresh = appenv.dir_under(base, "geom")
    assert fresh == os.path.join(base, appenv.DIR, "geom"), fresh

    legacy = os.path.join(base, appenv.LEGACY_DIRS[0], "geom")
    os.makedirs(legacy)
    assert appenv.dir_under(base, "geom") == legacy, "an existing old cache was orphaned"

    # ...and the control: once the current directory exists it wins outright,
    # or a machine would be pinned to the old name forever.
    os.makedirs(fresh)
    assert appenv.dir_under(base, "geom") == fresh, "the current name never takes over"
    print(PASS, "an existing cache is kept; the current name wins once it exists")


def test_the_sidecar_reads_no_variable_behind_appenv_s_back():
    """The whole scheme is one module or it is nothing: an os.environ.get for a
    prefixed name somewhere else is a variable that quietly lost its old
    spelling, and nothing would say so."""
    import glob
    import re

    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    pattern = re.compile(r"""environ(?:\.get)?[\[\(]\s*["'](?:FUNDACAD|SINDRI|SINDRICAD)_""")
    stray = []
    for path in glob.glob(os.path.join(here, "*.py")):
        if os.path.basename(path) == "appenv.py":
            continue
        with open(path, encoding="utf-8") as fh:
            for i, line in enumerate(fh, 1):
                if pattern.search(line):
                    stray.append(f"{os.path.basename(path)}:{i}: {line.strip()}")
    assert not stray, "read through appenv instead:\n  " + "\n  ".join(stray)
    print(PASS, "every prefixed variable in sidecar/ is read through appenv")


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            print(f"FAIL {name}")
            failed += 1
        finally:
            _clear()
    print("appenv:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
