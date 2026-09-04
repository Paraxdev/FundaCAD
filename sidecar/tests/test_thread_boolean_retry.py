"""A long thread against the bore it belongs in, which OCCT cannot do in one go.

A swept tool that runs a long way nearly parallel to the face it meets can defeat
the kernel outright. It does not raise and it does not return an invalid shape:
BRepAlgoAPI reports IsDone, BRepCheck calls both solids valid, each solid
classifies points inside the other as IN, and the boolean hands the argument
straight back untouched. Measured here: a three turn thread that should take
505.7 mm3 out of its bore took 0.0000, and the same thread fused to its shank
came back either as two separate lumps wearing one body's name or, at five turns,
11336 mm3 SMALLER than the shank alone.

Cutting the tool into slabs fixes it, and that is what booleans._retried_in_slices
does. The tests below pin the repaired answer against a SECOND, independent way of
getting it — the same thread swept one turn at a time and applied turn by turn —
so a wrong repair fails rather than a merely different one passing.

The two turn thread is the control that matters most: it never needed the repair
and must keep giving exactly the answer it always gave.

Run:  python test_thread_boolean_retry.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from booleans import _in_slices
from builder import rebuild

PITCH = 3.0
DEPTH = 1.0
FLAT = 0.4


def doc(*groups):
    feats = []
    for g in groups:
        feats += g
    return {"version": 9, "parameters": {}, "features": feats}


def tube():
    """A barrel bored to r=20.5 from z=2 up, outside r=30, z 0..12."""
    return [
        {"id": "skA", "type": "sketch", "plane": "XZ", "entities": [
            {"id": "a1", "type": "line", "x1": 17.5, "y1": 0, "x2": 30, "y2": 0},
            {"id": "a2", "type": "line", "x1": 30, "y1": 0, "x2": 30, "y2": 12},
            {"id": "a3", "type": "line", "x1": 30, "y1": 12, "x2": 20.5, "y2": 12},
            {"id": "a4", "type": "line", "x1": 20.5, "y1": 12, "x2": 20.5, "y2": 2},
            {"id": "a5", "type": "line", "x1": 20.5, "y1": 2, "x2": 17.5, "y2": 2},
            {"id": "a6", "type": "line", "x1": 17.5, "y1": 2, "x2": 17.5, "y2": 0}]},
        {"id": "revA", "type": "revolve", "sketch": "skA", "axis": "Z",
         "angle": 360, "operation": "new"},
    ]


def shank():
    """The spigot the external thread is wound onto: r=20.2, z 3..12."""
    return [
        {"id": "skS", "type": "sketch", "plane": "XZ", "entities": [
            {"id": "s1", "type": "line", "x1": 0, "y1": 3, "x2": 20.2, "y2": 3},
            {"id": "s2", "type": "line", "x1": 20.2, "y1": 3, "x2": 20.2, "y2": 12},
            {"id": "s3", "type": "line", "x1": 20.2, "y1": 12, "x2": 0, "y2": 12},
            {"id": "s4", "type": "line", "x1": 0, "y1": 12, "x2": 0, "y2": 3}]},
        {"id": "revS", "type": "revolve", "sketch": "skS", "axis": "Z",
         "angle": 360, "operation": "new"},
    ]


def thread(x0, x1, z0, turns, op, fid="revT"):
    """One trapezoidal thread feature, `turns` long, starting its profile at z0."""
    sid = "sk" + fid
    return [
        {"id": sid, "type": "sketch", "plane": "XZ", "entities": [
            {"id": "t1", "type": "line", "x1": x0, "y1": z0,
             "x2": x1, "y2": z0 + DEPTH},
            {"id": "t2", "type": "line", "x1": x1, "y1": z0 + DEPTH,
             "x2": x1, "y2": z0 + DEPTH + FLAT},
            {"id": "t3", "type": "line", "x1": x1, "y1": z0 + DEPTH + FLAT,
             "x2": x0, "y2": z0 + 2 * DEPTH + FLAT},
            {"id": "t4", "type": "line", "x1": x0, "y1": z0 + 2 * DEPTH + FLAT,
             "x2": x0, "y2": z0}]},
        {"id": fid, "type": "revolve", "sketch": sid, "axis": "Z",
         "angle": 360 * turns, "pitch": PITCH, "operation": op,
         "targets": ["body1"]},
    ]


def internal(turns, op="cut", z0=2.85, fid="revT"):
    return thread(20.1, 21.75, z0, turns, op, fid)


def external(turns, op="join", z0=3.0, fid="revT"):
    return thread(19.8, 21.45, z0, turns, op, fid)


def built(*groups):
    """(volume, solid count, bodies) after a clean rebuild."""
    _part, errors, bodies = rebuild(doc(*groups))
    assert not errors, errors
    shape = bodies[0]["shape"]
    return shape.volume, len(shape.solids()), bodies


def turn_by_turn(base, make, turns, z0):
    """The same thread applied ONE TURN AT A TIME, which the kernel manages.

    This is the independent answer the repaired one is held against. Each turn is
    its own feature at its own height, so nothing about the long sweep is reused.

    `targets` comes off every turn because a Join renumbers the body it merges
    into, so the second turn would name a body that no longer answers to body1.
    There is one body in these documents, which is what makes dropping it safe
    here and nowhere near a general answer.
    """
    groups = [base]
    for k in range(turns):
        g = make(1, z0=z0 + PITCH * k, fid=f"revT{k}")
        for f in g:
            f.pop("targets", None)
        groups.append(g)
    return built(*groups)[0]


def test_a_three_turn_thread_cuts_the_bore_it_is_drawn_in():
    """The failing case. Without the repair this comes back as the bore untouched
    and the feature errors with "Cut removed nothing"."""
    plain = built(tube())[0]
    after, solids, _ = built(tube(), internal(3))
    removed = plain - after
    assert removed > 1.0, f"the thread cut nothing at all: {removed}"
    reference = plain - turn_by_turn(tube(), internal, 3, 2.85)
    assert abs(removed - reference) < 0.5, (
        f"repaired cut removed {removed:.3f}, one turn at a time removed "
        f"{reference:.3f} — those must be the same thread")
    assert solids == 1, f"a cut must not leave the bore in pieces: {solids}"
    print(f"three turn cut removed {removed:.2f} mm3, "
          f"turn by turn {reference:.2f} OK")


def test_the_two_turn_thread_that_never_needed_the_repair_is_unchanged():
    """The control. Two turns cut correctly before any of this existed, so the
    repair must be invisible here: same number, to the last decimal that a
    boolean is worth trusting."""
    plain = built(tube())[0]
    removed = plain - built(tube(), internal(2))[0]
    reference = plain - turn_by_turn(tube(), internal, 2, 2.85)
    assert abs(removed - reference) < 0.5, (removed, reference)
    assert 300 < removed < 460, f"two turns should take about 380 mm3: {removed}"
    print(f"two turn cut still removes {removed:.2f} mm3 OK")


def test_a_three_turn_thread_fuses_into_one_solid():
    """The join failure is quieter than the cut one: the fuse "succeeds", the
    whole tool volume is reported as added, and the result is two loose lumps
    sharing a body id. Counting solids is what catches it."""
    plain, plain_solids, _ = built(shank())
    assert plain_solids == 1
    after, solids, bodies = built(shank(), external(3))
    assert solids == 1, f"the thread did not merge, it sits alongside: {solids}"
    assert len(bodies) == 1, bodies
    added = after - plain
    reference = turn_by_turn(shank(), external, 3, 3.0) - plain
    assert abs(added - reference) < 0.5, (
        f"repaired join added {added:.3f}, one turn at a time added "
        f"{reference:.3f}")
    print(f"three turn join added {added:.2f} mm3 as one solid OK")


def test_five_turns_does_not_come_back_smaller_than_the_shank():
    """The worst of the failures: the plain fuse of a five turn thread onto this
    shank returned 11336 mm3 LESS than the shank on its own."""
    plain = built(shank())[0]
    after, solids, _ = built(shank(), external(5))
    assert after > plain, f"a union removed material: {plain} -> {after}"
    assert solids == 1, solids
    print(f"five turn join: {plain:.1f} -> {after:.1f} mm3, one solid OK")


def test_a_cut_that_really_misses_still_says_so():
    """The control that keeps the repair honest. Slicing a tool that genuinely
    reaches nothing must not turn silence into a phantom success — the feature
    still has to fail, with the message that was always right."""
    _part, errors, _bodies = rebuild(doc(
        tube(),
        # inside the bore, sunk past the far side: nothing to take material from
        thread(2.0, 4.0, 2.85, 3, "cut")))
    assert errors, "a thread floating in the bore must still fail"
    assert "removed nothing" in errors[0]["message"], errors
    print("a thread that reaches nothing still fails OK:", errors[0]["message"])


def test_slicing_a_tool_hands_back_the_same_material():
    """_in_slices underpins both repairs, so its own promise gets a test: the
    slabs are the tool, no more and no less."""
    _part, errors, bodies = rebuild(doc(internal(3, op="new")))
    assert not errors, errors
    whole = bodies[0]["shape"]
    for n in (2, 4):
        pieces = _in_slices(whole, n)
        assert len(pieces) > 1, f"n={n} did not slice at all"
        total = sum(p.volume for p in pieces)
        assert abs(total - whole.volume) < 1e-6 * max(1.0, whole.volume), (
            f"n={n}: slabs total {total}, tool is {whole.volume}")
    print(f"slicing a {whole.volume:.2f} mm3 thread conserves it OK")


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
    print("thread boolean retry:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
