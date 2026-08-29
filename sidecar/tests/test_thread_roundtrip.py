"""The thread the frontend asks for, pinned on the kernel side.

The Thread tool does not add a `thread` feature type. It writes the two features
a thread actually is: the meridian profile as a sketch, and a revolve with a
`pitch` that sweeps it along a helix instead of closing it (builder._screw_revolve).
Everything between "this cylindrical face is an M6 shank" and those two features
is arithmetic in src/features/threadMath.ts, mirrored at the top of this file.

The failure this exists to catch does not raise. A profile whose open side sits
ON the cylinder it cuts is a tangent boolean, and OCCT answers it by handing back
the shank unchanged: no exception, no thread, and (because the no-op guard in
_boolean_into_bodies is doing its job) a "Cut removed nothing" that reads like
the user aimed badly. Measured on a 20mm shank at 2.5mm pitch, a 0.01mm breakout
did exactly that and 0.25mm cut the thread. So these tests assert MATERIAL CAME
OFF, per size, rather than merely that the build reported no error.

Run:  python test_thread_roundtrip.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import traceback

import builder

# ---- mirror of src/features/threadMath.ts -----------------------------------
DEPTH_RATIO = 0.6134  # ISO 68-1 basic thread height, as a fraction of the pitch
HALF_RATIO = DEPTH_RATIO * math.tan(math.pi / 6)  # 60 degrees included
BREAKOUT_RATIO = 0.15
BREAKOUT_FLOOR = 0.02


def profile(radius, pitch, external):
    depth = pitch * DEPTH_RATIO
    half = pitch * HALF_RATIO
    breakout = max(BREAKOUT_FLOOR, depth * BREAKOUT_RATIO)
    apex = radius - depth if external else radius + depth
    base = radius + breakout if external else radius - breakout
    return [(base, -half), (base, half), (apex, 0.0)]


def thread_features(radius, pitch, length, external):
    """The sketch + climbing revolve the tool emits, on a meridian plane whose
    own +X is radial and whose origin sits on the axis at the thread's start."""
    pts = profile(radius, pitch, external)
    lines = [
        {"type": "line", "x1": a[0], "y1": a[1],
         "x2": pts[(i + 1) % len(pts)][0], "y2": pts[(i + 1) % len(pts)][1]}
        for i, a in enumerate(pts)
    ]
    z0 = -length / 2
    return [
        {"id": "fs", "type": "sketch",
         "plane": {"origin": [0, 0, z0], "normal": [0, -1, 0], "xdir": [1, 0, 0]},
         "entities": lines},
        {"id": "ft", "type": "revolve", "sketch": "fs",
         "axis": {"origin": [0, 0, z0], "dir": [0, 0, 1]},
         "angle": (length / pitch) * 360, "pitch": pitch, "operation": "cut"},
    ]


def _volume(features):
    part, errs, bodies = builder.rebuild({"parameters": {}, "features": features})
    assert not errs, f"rebuild reported {errs}"
    assert bodies, "rebuild produced no body"
    return bodies[0]["shape"].volume


def _check(name, blank, radius, pitch, length, external):
    """Assert the thread came off the blank, not that the build merely survived."""
    before = _volume(blank)
    after = _volume(blank + thread_features(radius, pitch, length, external))
    removed = before - after
    assert removed > 0.01 * before, (
        f"{name}: the cut removed {removed:.4f} mm3 of {before:.1f} — a tangent "
        f"boolean silently kept the blank"
    )
    print(f"{name}: {before:.1f} -> {after:.1f} mm3, {removed:.2f} removed OK")
    return removed


def test_external_threads_cut_a_groove():
    """Three sizes across the coarse table: the breakout floor carries the fine
    end, the ratio carries the coarse end."""
    for name, r, p, h in [("M3", 1.5, 0.5, 6), ("M6", 3, 1.0, 12), ("M20", 10, 2.5, 20)]:
        blank = [{"id": "f1", "type": "cylinder", "radius": r, "height": h}]
        _check(f"{name} external", blank, r, p, h, True)


def test_an_internal_thread_cuts_outward():
    """A bore's material is OUTSIDE the cylinder, so the groove has to eat the
    other way. Getting `external` backwards here does not raise either — it
    carves air inside the hole."""
    blank = [
        {"id": "f1", "type": "cylinder", "radius": 8, "height": 10},
        {"id": "f1b", "type": "cylinder", "radius": 3, "height": 15, "operation": "cut"},
    ]
    _check("M6 internal", blank, 3, 1.0, 10, False)


def test_the_profile_is_shorter_than_one_turn():
    """The kernel refuses a climbing revolve whose profile is taller along the
    axis than one turn's climb, because consecutive turns would then intersect.
    The frontend's half-width ratio is what keeps us under that, so pin it."""
    assert 2 * HALF_RATIO < 1, "the profile is taller than the pitch"
    assert 2 * HALF_RATIO > 0.5, "the flanks have collapsed to a slit"
    print(f"profile height {2 * HALF_RATIO:.3f} of the pitch OK")


if __name__ == "__main__":
    try:
        test_the_profile_is_shorter_than_one_turn()
        test_external_threads_cut_a_groove()
        test_an_internal_thread_cuts_outward()
        print("\nall thread round-trip tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
