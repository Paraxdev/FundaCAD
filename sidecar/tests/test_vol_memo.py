"""The volume memo answers what the integral would have answered.

`_try_vol` is the measurement every boolean guard rests on: whether a cut removed
anything, whether a join added anything, whether an intersect emptied a body. It
was also the largest single line in a rebuild profile, because a timeline asks
for the same number over and over: each cut measures the body before and after,
and the `after` of one feature is the `before` of the next, over a shape object
nothing touched in between. On a 400x300 plate with 100 holes that was 0.51 s of
a 1.48 s rebuild.

So it is memoized on shape identity, which is only safe if two things hold, and
each of them is a way this could be silently wrong rather than visibly broken:

 1. A cached answer equals the uncached one. Otherwise every guard in the module
    is now reading a number that came from somewhere else.
 2. Distinct shapes get distinct answers, even when one is built to look exactly
    like another. An id-keyed cache that collided would report the wrong body's
    volume, and a no-op guard reading the wrong body's volume passes a cut that
    did nothing.

Run: uv run python tests/test_vol_memo.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Box, Cylinder, Pos

import booleans

fails = []


def check(label, ok, detail=""):
    print("  %s %s%s" % ("ok  " if ok else "FAIL", label,
                         "" if ok else "  <- %s" % (detail,)))
    if not ok:
        fails.append(label)


def main():
    print("1. the memo agrees with the integral")
    b = Box(40, 30, 20)
    want = booleans._measure_vol(b)
    check("first ask", abs(booleans._try_vol(b) - want) < 1e-9)
    check("second ask, from the memo", abs(booleans._try_vol(b) - want) < 1e-9)
    check("it really is memoized", id(b) in booleans._VOL_MEMO)

    print("\n2. control: a DIFFERENT shape is not served the first one's answer")
    # Same dimensions, different object. If the key were anything but identity
    # (or if the entry did not pin its shape) this is where a collision shows.
    b2 = Box(40, 30, 20)
    c = Cylinder(5, 20)
    check("an identical-looking box measures the same, honestly",
          abs(booleans._try_vol(b2) - want) < 1e-9)
    check("a different shape measures differently",
          abs(booleans._try_vol(c) - want) > 1.0,
          "cylinder read %.3f, box %.3f" % (booleans._try_vol(c), want))

    print("\n3. a cut result is measured, not inherited from its input")
    # The exact sequence the guards run: measure a body, cut it, measure the
    # result. The second number must be smaller. Serving the memoized `before`
    # for the `after` would make every cut look like a no-op.
    before = booleans._try_vol(b)
    after_shape = booleans._serial_bool(b, Pos(0, 0, 0) * Cylinder(4, 40), "cut")
    after = booleans._try_vol(after_shape)
    check("the cut is visible in the numbers", after < before - 100,
          "before %.1f, after %.1f" % (before, after))
    check("and it matches the integral",
          abs(after - booleans._measure_vol(after_shape)) < 1e-9)

    print("\n4. an empty shape still reads as zero, not as a failure")
    # The guards distinguish 0.0 (nothing there, fire the no-op error) from None
    # (could not measure, stay quiet). Caching must not blur the two.
    from build123d import Compound
    empty = Compound([])
    check("empty is 0.0", booleans._try_vol(empty) == 0.0,
          repr(booleans._try_vol(empty)))
    check("and stays 0.0 on the second ask", booleans._try_vol(empty) == 0.0)

    print("\n5. the memo is bounded")
    check("cap is set", booleans._VOL_MEMO_CAP > 0)
    booleans._VOL_MEMO.clear()
    check("clearing it costs nothing but a recompute",
          abs(booleans._try_vol(b) - want) < 1e-9)

    print("\n%s" % ("ALL PASS" if not fails else "%d FAILED: %s" % (len(fails), fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
