"""Environment variables this app reads, under both the names it has had.

The project was called something else before it was called FundaCAD, and its
variables were named after that. The names are `FUNDACAD_*` now. The old
`SINDRI_*` and `SINDRICAD_*` spellings still answer, because a variable of this
kind is a thing a PERSON sets — in a shell profile, a launcher script, a CI job,
a docker-compose file — none of which live in this repository and none of which
a rename here can reach. Dropping the old spelling outright would turn those
settings off silently: no error, no warning, just a disk cache that is suddenly
on again or a blob store pointing somewhere else.

Reading both costs one dict lookup. The old names go away when nothing outside
this repository can still be carrying them, which is not a thing this file can
know; until then the compatibility is the point.

The precedence is new-name-first, so someone who sets both is telling us which
one they mean by setting the current one.

Rust sets the spawn-time variables (see src-tauri/src/sidecar.rs) and writes the
CURRENT names only — the old spellings exist for humans, not for our own
processes talking to each other.
"""

import os

#: The spelling in use, and the ones retired. Ordered: first match wins.
PREFIX = "FUNDACAD_"
LEGACY_PREFIXES = ("SINDRI_", "SINDRICAD_")


def name(suffix):
    """The current full variable name for `suffix` ("SIDECAR_PORT")."""
    return PREFIX + suffix


def get(suffix, default=None):
    """The value of `FUNDACAD_<suffix>`, or of a retired spelling, or `default`.

    An empty string is a VALUE, not a miss: `FUNDACAD_EXTRA_ORIGINS=` is how you
    say "none", and falling through to a stale `SINDRI_EXTRA_ORIGINS` there would
    do the opposite of what was asked."""
    for prefix in (PREFIX,) + LEGACY_PREFIXES:
        val = os.environ.get(prefix + suffix)
        if val is not None:
            return val
    return default


def set_(suffix, value):
    """Set the current name and clear the retired ones, so a child cannot be
    handed two spellings that disagree."""
    os.environ[PREFIX + suffix] = value
    for prefix in LEGACY_PREFIXES:
        os.environ.pop(prefix + suffix, None)


def clear(suffix):
    """Unset every spelling. Used where the point is that nothing is set — a
    harness that wants the sidecar to mint its own token cannot leave an old
    name behind for it to find."""
    for prefix in (PREFIX,) + LEGACY_PREFIXES:
        os.environ.pop(prefix + suffix, None)


def apply_to(env, suffix, value):
    """Same as `set_`, on a dict destined for a subprocess rather than on ours."""
    env[PREFIX + suffix] = value
    for prefix in LEGACY_PREFIXES:
        env.pop(prefix + suffix, None)
    return env


#: The directory name this app owns inside a user's data and cache roots, and
#: the one it used to own.
DIR = "fundacad"
LEGACY_DIRS = ("sindricad",)


def dir_under(base, leaf):
    """`<base>/fundacad/<leaf>`, unless a directory under the OLD name is already
    there and the new one is not.

    Both of these hold a CACHE, so a wrong answer here costs a rebuild rather
    than data. But it costs it while leaving the old directory on disk forever,
    unreferenced and un-swept by the budget that was supposed to bound it, which
    is how a machine ends up with two multi-gigabyte geometry caches and only one
    of them shrinking. Keeping the existing directory is the cheap way to avoid
    that; a fresh machine gets the current name and never sees any of this.

    Deliberately NOT a move: an old sidecar from a previous install can still be
    running against that path, and renaming a SQLite-backed store out from under
    a live process is a worse failure than the duplication it avoids.
    """
    current = os.path.join(base, DIR, leaf)
    if os.path.isdir(current):
        return current
    for old in LEGACY_DIRS:
        legacy = os.path.join(base, old, leaf)
        if os.path.isdir(legacy):
            return legacy
    return current
