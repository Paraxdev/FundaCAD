"""A parameter edit rebuilds the features that read the parameter, and no others.

The report this closes: rebuilding takes a while on a machine that should make
it instant. It was not the kernel and it was not threading. Every parameter edit
threw the whole in-process prefix cache away and replayed the document from
feature zero, because the RAM tier gated on one signature over ALL parameters
while the disk tier already scoped them per feature. Dragging a slider is the
edit people make most, and it was the most expensive edit in the app: on a plate
of 122 features whose last feature was the only reader of the only parameter,
0.906 s a tick against 0.016 s for typing the same number in as a literal.

Counting handler calls rather than timing, because a stopwatch on a fast machine
proves nothing repeatable. The count IS the claim: how many features were
rebuilt.

Every case needs its control, because a cache that resumes at the end of every
document would pass case 1 and be catastrophically wrong:

 1. A parameter only the LAST feature reads rebuilds one feature.
 2. A parameter the FIRST feature reads rebuilds everything after it. This is
    the control for case 1: the scoping has to follow the reader, not the end
    of the timeline.
 3. A parameter NOTHING reads rebuilds nothing at all.
 4. A parameter reached through another parameter counts as read, so an
    indirection cannot smuggle a stale feature past the gate.
 5. The geometry after a scoped resume is identical to a full rebuild's. The one
    that matters: every case above is a way of doing LESS work, and doing less
    work is only correct if the answer is the same.
 6. Editing a feature's literal still resumes at that feature, which is what
    worked before this and had to keep working.

Run: uv run python tests/test_param_scope.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import copy
import os
import sys
import traceback

os.environ.setdefault("FUNDACAD_DISK_CACHE", "0")  # the RAM tier is what's under test

import builder

fails = []


def check(label, ok, detail=""):
    print("  %s %s%s" % ("ok  " if ok else "FAIL", label,
                         "" if ok else "  <- %s" % (detail,)))
    if not ok:
        fails.append(label)


N = 5  # holes; small enough to read a call count at a glance


def doc(param_at=None, indirect=False):
    """A plate with N holes. `param_at` is the hole whose extrude distance reads
    the parameter `d` instead of a literal; None gives a document where nothing
    reads it. `indirect` makes `d` reach the feature through a second parameter,
    so the closure walk is exercised rather than a direct name match."""
    params = {"d": 30}
    expr = "d"
    if indirect:
        params = {"base": 30, "d": "base"}
        expr = "d"
    feats = [
        {"id": "s0", "type": "sketch", "plane": "XY", "entities": [
            {"type": "rectangle", "width": 200, "height": 100, "x": 0, "y": 0}]},
        {"id": "e0", "type": "extrude", "sketch": "s0", "distance": 10,
         "operation": "new"},
    ]
    for i in range(N):
        feats.append({"id": "s%d" % (i + 1), "type": "sketch", "plane": "XY",
                      "entities": [{"type": "circle", "radius": 4,
                                    "x": -60 + i * 25, "y": 0}]})
        feats.append({"id": "e%d" % (i + 1), "type": "extrude",
                      "sketch": "s%d" % (i + 1),
                      "distance": expr if i == param_at else 30,
                      "symmetric": True, "operation": "cut"})
    return {"parameters": params, "features": feats}


# --- counting what actually got rebuilt --------------------------------------

_REAL = dict(builder._FEATURE_HANDLERS)
_COUNT = {"n": 0}


def _install_counter():
    for k, fn in _REAL.items():
        def wrap(fn=fn):
            def inner(f, ctx):
                _COUNT["n"] += 1
                return fn(f, ctx)
            return inner
        builder._FEATURE_HANDLERS[k] = wrap()


def rebuilt_by(d, mutate):
    """Settle the cache on `d`, apply `mutate` to a copy, and return how many
    feature handlers ran on the rebuild that follows."""
    builder.reset_cache()
    part, errors, _b = builder.rebuild_cached(copy.deepcopy(d))
    assert not errors, errors
    edited = copy.deepcopy(d)
    mutate(edited)
    _COUNT["n"] = 0
    part, errors, bodies = builder.rebuild_cached(edited)
    assert not errors, errors
    return _COUNT["n"], edited, bodies


def set_param(v):
    return lambda d: d["parameters"].__setitem__("d", v)


def volumes(bodies):
    return sorted(round(b["shape"].volume, 4)
                  for b in bodies if b.get("shape") is not None)


def main():
    _install_counter()
    total = 2 + 2 * N  # every feature in the document

    print("1. a parameter only the LAST feature reads")
    n, _e, _b = rebuilt_by(doc(param_at=N - 1), set_param(26))
    check("one feature rebuilt, not %d" % total, n == 1, "rebuilt %d" % n)

    print("\n2. control: a parameter the FIRST hole reads")
    # The scoping must follow the READER. A cache that simply resumed at the end
    # of the timeline would pass case 1 and silently serve stale geometry here.
    n, _e, _b = rebuilt_by(doc(param_at=0), set_param(26))
    first_reader = 2 + 1  # sketch, extrude, then the first hole's sketch
    check("rebuilt from the reader down (%d of %d)" % (total - first_reader, total),
          n == total - first_reader, "rebuilt %d" % n)

    print("\n3. control: a parameter NOTHING reads")
    n, _e, _b = rebuilt_by(doc(param_at=None), set_param(26))
    check("nothing rebuilt", n == 0, "rebuilt %d" % n)

    print("\n4. a parameter reached through another parameter still counts")
    # Asserted on the chain keys rather than through a rebuild, because the
    # builder cannot evaluate this document: `val` is a flat lookup, the app
    # evaluates expressions before sending them, so a parameter whose value is
    # an expression over other parameters never reaches the kernel as one. The
    # invalidation walk is conservative and must cover it anyway, and the keys
    # are where that decision is actually made.
    from rebuild_cache import _chain_keys_scoped, _feature_sigs

    def keys(dd):
        return _chain_keys_scoped(dd, _feature_sigs(dd["features"]))

    d = doc(param_at=N - 1, indirect=True)
    moved = copy.deepcopy(d)
    moved["parameters"]["base"] = 26
    k0, k1 = keys(d), keys(moved)
    reader = 2 + 2 * (N - 1) + 1  # the extrude whose distance reads `d`
    check("the reader's key changed", k0[reader] != k1[reader])
    check("nothing above it did", k0[:reader] == k1[:reader],
          "%d of %d prefix keys moved"
          % (sum(1 for a, b in zip(k0[:reader], k1[:reader]) if a != b), reader))

    print("\n5. the resumed geometry equals a full rebuild's")
    # Doing less work is only correct if the answer is the same, so every
    # position of the parameter is checked against rebuild() from scratch.
    for at in (0, N // 2, N - 1):
        n, edited, bodies = rebuilt_by(doc(param_at=at), set_param(26))
        _p, errors, full = builder.rebuild(copy.deepcopy(edited))
        assert not errors, errors
        got, want = volumes(bodies), volumes(full)
        check("param at hole %d: %s" % (at, got), got == want,
              "full rebuild says %s" % (want,))

    print("\n6. editing a literal still resumes at that feature")
    d = doc(param_at=None)
    n, _e, _b = rebuilt_by(
        d, lambda dd: dd["features"][-1].__setitem__("distance", 26))
    check("one feature rebuilt", n == 1, "rebuilt %d" % n)

    print("\n%s" % ("ALL PASS" if not fails else "%d FAILED: %s" % (len(fails), fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
