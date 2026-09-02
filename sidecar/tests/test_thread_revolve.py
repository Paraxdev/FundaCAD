"""A revolve that climbs while it turns, which is how a thread gets made.

Draw the thread's cross section in a plane through the axis, give the revolve a
pitch, and wind the angle past 360 for as many turns as the thread is long. The
same feature still does everything it did: with no pitch it is the flat revolve
it always was, and past a full turn it stops at one, because a flat revolve has
already covered that ground.

What is actually being checked here is that the section stays a MERIDIAN
section, the way a revolve's does, rather than tipping to stay square to the
helix. Those two are easy to confuse by eye and differ by a factor of two at a
steep pitch, so the volume identity below is the real subject of this file:

    a section of area A, centroid at radius r, swept through angle t radians,
    encloses A * r * t, whatever the pitch is.

The axial climb shears the section inside its own plane, and a shear adds no
volume. A tipped (Frenet-framed) sweep obeys a different identity entirely,
A * path-length, and test_the_section_stays_in_the_meridian_plane asserts the
measurement is the first number and not the second.

Run: uv run python tests/test_thread_revolve.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import traceback

from builder import rebuild

PASS = "  ok"

# The thread section: 2mm wide, 1mm tall, centred 8mm out from the axis. In an
# XZ sketch u is X and v is Z, so this is a meridian section of the Z axis.
W, T, RC = 2.0, 1.0, 8.0
AREA = W * T

SKETCH = {
    "id": "f1", "type": "sketch", "plane": "XZ",
    "entities": [{"type": "rectangle", "id": "e0", "width": W, "height": T, "x": RC, "y": 0}],
}
PROFILE = [RC, 0, 0]


def rev(angle, pitch=None, operation="new", sketch="f1", regions=None):
    f = {"id": "fr", "type": "revolve", "sketch": sketch, "axis": "Z",
         "angle": angle, "operation": operation,
         "regions": [PROFILE] if regions is None else regions}
    if pitch is not None:
        f["pitch"] = pitch
    return f


def build(*features, base=(SKETCH,)):
    doc = {"parameters": {}, "paramDefs": {}, "version": 8,
           "features": [*base, *features]}
    part, errs, bodies = rebuild(doc, diagnostics=[])
    return errs, bodies


def swept(angle, pitch=None):
    errs, bodies = build(rev(angle, pitch))
    assert errs == [], errs
    return bodies[-1]["shape"]


def pappus(angle):
    """What a meridian section of this profile must enclose over `angle`."""
    return AREA * RC * math.radians(abs(angle))


def test_a_pitch_makes_the_revolve_climb():
    """Two turns at 1.5mm a turn rise 3mm, and the flat one rises not at all."""
    flat = swept(360).bounding_box()
    assert abs((flat.max.Z - flat.min.Z) - T) < 1e-6, flat.max.Z - flat.min.Z

    climbed = swept(720, 1.5).bounding_box()
    # the section is T tall and its own top rides 3mm higher at the end
    assert abs(climbed.min.Z - (-T / 2)) < 1e-6, climbed.min.Z
    assert abs(climbed.max.Z - (T / 2 + 3.0)) < 1e-6, climbed.max.Z
    print(PASS, "a pitch lifts the sweep by pitch x turns, and no pitch lifts nothing")


def test_the_volume_is_the_screw_pappus_identity():
    """Pitch changes the shape but never the volume: the climb is a shear."""
    # Every pitch here clears the section's own height, so nothing is trimmed;
    # the touching case has its own test below, and its own arithmetic.
    for angle, pitch in [(360, 1.5), (1080, 1.5), (180, 1.5), (655, 1.2), (3600, 1.4)]:
        v = swept(angle, pitch).volume
        want = pappus(angle)
        assert abs(v - want) / want < 1e-5, (angle, pitch, v, want)
    # and the same angle with no pitch at all encloses the same amount
    assert abs(swept(180).volume - pappus(180)) / pappus(180) < 1e-5
    print(PASS, "volume is area x radius x angle, at every pitch tried")


def test_the_section_stays_in_the_meridian_plane():
    """THE CONTROL that distinguishes a revolve from a pipe sweep.

    At this pitch the helix is twice as long as the circle it wraps, so a section
    tipped square to the helix (Frenet framing, which is what a plain sweep along
    a helix does) would enclose twice as much. Both numbers are computed here so
    the test fails if the measurement ever drifts onto the other one.
    """
    pitch = 90.0
    v = swept(360, pitch).volume
    meridian = pappus(360)
    frenet = AREA * math.hypot(2 * math.pi * RC, pitch)
    assert frenet / meridian > 2.0, frenet / meridian  # the two really are far apart
    assert abs(v - meridian) / meridian < 1e-5, (v, meridian)
    assert abs(v - frenet) / frenet > 0.45, (v, frenet)
    print(PASS, f"section stays meridian: {v:.2f} = {meridian:.2f}, not {frenet:.2f}")


def test_turning_and_climbing_have_independent_signs():
    """Four sign pairs, four different solids. The angle decides which way it
    goes round, the pitch decides which way it goes up, and neither one may
    quietly flip the other."""
    for angle, pitch, want_y, want_z in [
        (90, 1.5, +1, +1),   # anticlockwise, rising
        (-90, 1.5, -1, -1),  # clockwise, so it falls: rise = turns x pitch
        (90, -1.5, +1, -1),
        (-90, -1.5, -1, +1),
    ]:
        bb = swept(angle, pitch).bounding_box()
        # a quarter turn from +X sweeps into +Y or -Y and nowhere else
        got_y = 1 if bb.max.Y > 1e-6 and bb.min.Y > -1e-6 else -1
        assert got_y == want_y, (angle, pitch, "Y", bb.min.Y, bb.max.Y)
        rise = (bb.max.Z - T / 2) if want_z > 0 else (bb.min.Z + T / 2)
        assert abs(abs(rise) - abs(pitch) / 4) < 1e-6, (angle, pitch, "Z", rise)
        assert (rise > 0) == (want_z > 0), (angle, pitch, "Z sign", rise)
    print(PASS, "angle sets the direction of turn, pitch sets the direction of climb")


def test_past_one_turn_a_flat_revolve_is_still_one_turn():
    """A flat revolve has already covered the whole circle at 360, so winding on
    can only re-sweep ground it has swept. Measured, not assumed: OCCT wraps a
    1080 arc back onto the same solid by itself, so clamping is saying out loud
    what it does silently, not propping it up.

    The control is the pitch: with one, those same extra turns are real, and
    three turns enclose three times what one does. If the clamp ever escaped the
    no-pitch branch this is the assertion that would catch it.
    """
    a, b = swept(1080), swept(360)
    assert abs(a.volume - b.volume) < 1e-9, (a.volume, b.volume)

    from build123d import Axis, revolve as bd_revolve
    from builder import _build_sketch

    sk = _build_sketch(SKETCH, float)["sketch"]
    raw = bd_revolve(sk, axis=Axis.Z, revolution_arc=1080)
    assert abs(raw.volume - b.volume) < 1e-6, (raw.volume, b.volume)

    wound = swept(1080, 1.5)
    assert abs(wound.volume - 3 * b.volume) / (3 * b.volume) < 1e-5, wound.volume
    print(PASS, "over a full turn is a full turn with no pitch, and three with one")


def test_a_profile_taller_than_its_climb_is_refused():
    """Each turn would eat the one before, and OCCT would hand back a
    self-intersecting solid that measures as if it were fine. One turn has no
    neighbour to run into, so the same profile and pitch must still be allowed
    there, which is the control."""
    errs, _ = build(rev(720, T / 2))
    assert len(errs) == 1, errs
    assert "run into the one before" in errs[0].get("message", ""), errs

    errs, bodies = build(rev(360, T / 2))
    assert errs == [], errs
    assert abs(bodies[-1]["shape"].volume - pappus(360)) / pappus(360) < 1e-5
    print(PASS, "overlapping turns are refused, a single turn at the same pitch is not")


def test_a_profile_sitting_on_the_axis_is_refused():
    """Nothing to start from: a climbing revolve needs a meridian to begin on."""
    on_axis = {**SKETCH, "entities": [
        {"type": "rectangle", "id": "e0", "width": W, "height": T, "x": 0, "y": 0}]}
    errs, _ = build(rev(360, 1.0, regions=[[0, 0, 0]]), base=(on_axis,))
    assert len(errs) == 1, errs
    assert "centred on it" in errs[0].get("message", ""), errs
    print(PASS, "a profile centred on the axis is refused, with a reason")


def test_a_thread_joins_to_its_shank():
    """End to end, the way it is actually used: a shank, then a thread wound up
    it.

    The section straddles the shank's surface on purpose, half in and half out.
    A section that merely TOUCHED that surface would meet it tangentially, and a
    tangential fuse is the one OCCT quietly makes a mess of: measured, a thread
    whose inner edge sits exactly on the shank fuses to LESS than the bare shank.
    That failure is caught by the existing no-op guard rather than here, but it
    is the reason this profile is drawn to overlap.

    The thread is placed so all ten turns of it stay inside the shank's length,
    which makes the material it adds exactly the outer half of the section, swept
    all the way round: a number, not an inequality.
    """
    shank = [
        {"id": "b1", "type": "cylinder", "radius": 7.5, "height": 12,
         "x": 0, "y": 0, "z": 0, "operation": "new"},
    ]
    prof = {
        "id": "f1", "type": "sketch", "plane": "XZ",
        "entities": [{"type": "rectangle", "id": "e0", "width": 2.0, "height": 0.8,
                      "x": 7.5, "y": -5.0}],
    }
    # No region: the shank's own silhouette cuts the profile into an inside cell
    # and an outside one, and a thread wants the whole section.
    errs, bodies = build(rev(3600, 1.0, operation="join", regions=[]),
                         base=(*shank, prof))
    assert errs == [], errs
    assert len(bodies) == 1, [b["name"] for b in bodies]
    body = bodies[-1]["shape"]
    added = body.volume - math.pi * 7.5 ** 2 * 12
    outside = 1.0 * 0.8 * 8.0 * math.radians(3600)  # the proud half, by Pappus
    assert abs(added - outside) / outside < 0.005, (added, outside)
    assert body.is_valid, "the fused thread is not a valid solid"
    print(PASS, f"a ten turn thread joins its shank, adding {added:.1f} mm3")


def test_a_thread_whose_root_sits_on_the_shank_still_joins():
    """A section whose root sits EXACTLY on the shank, so the two meet along a
    surface instead of crossing one another.

    This used to come back as 56mm3 where the shank alone was 942, and was
    refused. The tangency was never the cause: the same thread was ALSO wound at
    a pitch equal to its own section height, so its turns met in a line, and it
    is that pinch the fuse choked on (see the clearance test below). With the
    turns given their hair of room the tangential join is ordinary work, and both
    threads below now land within a per cent of the material they carry.

    The control is 0.3mm: a root reaching that far INTO the shank is the case
    that always worked, and it must still measure the same way.
    """
    def thread_at(root):
        prof = {"id": "f1", "type": "sketch", "plane": "XZ", "entities": [
            {"type": "line", "id": "l1", "x1": root, "y1": -5.5, "x2": 6.0, "y2": -5.0},
            {"type": "line", "id": "l2", "x1": 6.0, "y1": -5.0, "x2": root, "y2": -4.5},
            {"type": "line", "id": "l3", "x1": root, "y1": -4.5, "x2": root, "y2": -5.5}]}
        shank = {"id": "b1", "type": "cylinder", "radius": 5.0, "height": 12,
                 "x": 0, "y": 0, "z": 0, "operation": "new"}
        return build(rev(3600, 1.0, operation="join", regions=[]), base=(shank, prof))

    bare = math.pi * 25 * 12
    for root, added in ((5.0, 167.0), (4.7, 128.0)):
        errs, bodies = thread_at(root)
        assert errs == [], (root, errs)
        got = bodies[-1]["shape"].volume - bare
        assert abs(got - added) / added < 0.01, (root, got, added)
        assert bodies[-1]["shape"].is_valid, root
    print(PASS, "a thread rooted exactly on its shank joins, and so does one that bites in")


def test_turns_that_meet_exactly_are_given_a_hair_of_clearance():
    """The thread everyone actually draws: crest landing on root, no flat left
    between one turn and the next.

    It is also the one section a B-rep kernel cannot use. Two crests meeting
    touch along a LINE, so the solid is non-manifold; BRepCheck calls it valid
    and every boolean against it then quietly does nothing. Measured on the
    document that reported this, a cut that should have taken 610.4 mm3 out of a
    block took 0.410.

    So the crest is stopped a hair short of the root, and the measurement is the
    thing that was broken: the thread is subtracted from a cylinder that swallows
    it whole, and what comes off is the thread.

    Two controls. The clearance is BOUNDED — the section may lose the hair and
    nothing more, which is what fails if the trim is ever applied twice or in the
    wrong direction. And the refusal above still stands: a section genuinely
    taller than its climb is refused, not quietly shrunk to fit.
    """
    clear = 1e-3  # _turn_clearance(1.0)

    errs, bodies = build(rev(1080, T))
    assert errs == [], errs
    thread = bodies[-1]["shape"]
    assert thread.is_valid, "a thread with touching turns is not a valid solid"

    # the section lost the clearance along the axis and NOTHING across it
    want = pappus(1080) * (T - clear) / T
    assert abs(thread.volume - want) / want < 1e-4, (thread.volume, want)
    assert thread.volume < pappus(1080), (thread.volume, pappus(1080))

    # ...and the whole point: it can be cut with
    block = {"id": "b1", "type": "cylinder", "radius": 12.0, "height": 10.0,
             "x": 0, "y": 0, "z": 0, "operation": "new"}
    cut = {"id": "fb", "type": "boolean", "operation": "subtract",
           "target": "body1", "tools": ["body2"]}
    errs, bodies = build(rev(1080, T), cut, base=(block, SKETCH))
    assert errs == [], errs
    bare = math.pi * 144 * 10
    removed = bare - bodies[-1]["shape"].volume
    assert abs(removed - thread.volume) / thread.volume < 0.01, (removed, thread.volume)
    print(PASS, f"turns that meet are cleared by {clear}mm, and {removed:.1f} mm3 cuts")


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            failed += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print("thread revolve:", "OK" if not failed else f"{failed} FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
