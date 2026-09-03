"""Saying "work is still happening", from anywhere in the sidecar.

The supervisor reaps a worker on a heartbeat that STOPS MOVING, not on one that
is slow. That distinction is the whole reason this exists: a phase that runs for
a minute without a word looks exactly like a wedged one, so every long stretch of
work — a feature build, an import, export meshing, a checkpoint write, the
interference sweep — publishes as it goes.

ONE owner, so the hook is a live global rather than a copy. It used to live in
builder.py and be read through `globals()` on every call, which was a way of
saying "this module is where the variable really is"; splitting builder.py made
that no longer true, and a `from builder import on_feature_tick` bound at import
time would have captured None forever. Set it through this module and read it
through this module, and the indirection goes away.
"""

# Installed by the worker at startup (server.py) and by the tests. None until
# then, and None is a normal state: a rebuild run from a script has nobody
# listening.
on_feature_tick = None


def _publish(code):
    """Hand `code` to the hook, and never let a listener's failure reach the
    work. A dropped progress frame is a cosmetic loss; an exception raised out of
    here would fail the very build it was reporting on."""
    cb = on_feature_tick
    if cb is None:
        return
    try:
        cb(code)
    except Exception:
        pass


def feature_tick(i):
    """Publish "feature `i` of the tree is done". The index is what the server
    shows as progress, so it is the one code that carries real information."""
    _publish(i)


def import_phase(code):
    """Publish an import phase (the IMPORT_PHASE_* codes in mesh_import)."""
    _publish(code)


def progress_tick():
    """Publish one unit of progress from a phase that is not a feature build.

    `-1` is the server's documented "not a feature" heartbeat index, so this
    advances the counter without claiming some feature is building."""
    _publish(-1)
