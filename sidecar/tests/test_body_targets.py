"""Which body does a join or a cut actually touch?

Without `targets` the answer is "every visible body the new shape overlaps".
That is deliberate and it is right for the gesture it was written for: dragging
a face across two parts that sit against each other merges both. It is wrong,
and silently wrong, for the other common case, which is building a second part
beside a first one. Measured while an agent built a two-half spool through MCP:
a deliberately oversized cut tool reached across and took material out of a body
that was never selected, and nothing anywhere said so.

So `targets` names the bodies an operation may touch. The tests below come in
pairs, the same feature with and without it, so each one shows the narrowing
actually happening rather than just showing a build that succeeded.

Run:  python test_body_targets.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from builder import rebuild


def vols(doc):
    """{body id: volume} after a rebuild, plus the errors, so a test can assert
    on what each body ended up as rather than on a total that hides a swap."""
    _part, errors, bodies = rebuild(doc)
    out = {}
    for b in bodies:
        try:
            out[b["id"]] = abs(b["shape"].volume)
        except Exception:
            out[b["id"]] = None
    return out, errors


def doc(*features, params=None):
    return {"version": 9, "parameters": params or {}, "features": list(features)}


def two_cubes():
    """Two 10mm cubes 30mm apart along X, as body1 and body2."""
    return [
        {"id": "a", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "am", "type": "move", "dx": -15},
        {"id": "b", "type": "box", "length": 10, "width": 10, "height": 10},
        {"id": "bm", "type": "move", "dx": 15},
    ]


def test_a_cut_without_targets_reaches_every_body_it_overlaps():
    """The control. A slab spanning both cubes takes material out of both, which
    is the existing behaviour and is what makes the next test worth having."""
    d = doc(*two_cubes(), {
        "id": "c", "type": "box", "length": 60, "width": 20, "height": 2,
        "operation": "cut"})
    v, errors = vols(d)
    assert not errors, errors
    assert len(v) == 2, v
    for bid, vol in v.items():
        assert vol < 1000 - 1, f"{bid} was not cut at all: {vol}"
    print("a cut with no targets hits both bodies OK", {k: round(x, 1) for k, x in v.items()})


def test_targets_keeps_the_cut_off_the_body_it_does_not_name():
    d = doc(*two_cubes(), {
        "id": "c", "type": "box", "length": 60, "width": 20, "height": 2,
        "operation": "cut", "targets": ["body1"]})
    v, errors = vols(d)
    assert not errors, errors
    assert v["body1"] < 1000 - 1, f"body1 should have been cut: {v}"
    assert abs(v["body2"] - 1000) < 1e-6, f"body2 was named nowhere and must be whole: {v}"
    print("targets kept the cut off body2 OK", {k: round(x, 1) for k, x in v.items()})


def test_targets_keeps_a_join_from_swallowing_a_second_body():
    """A join with no targets fuses every body the new solid touches, so a bar
    laid across two parts turns two bodies into one. Naming a target leaves the
    other alone: the bar merges into body1 and body2 stays a separate body."""
    bar = {"id": "j", "type": "box", "length": 60, "width": 4, "height": 4,
           "operation": "join"}
    loose, err1 = vols(doc(*two_cubes(), bar))
    assert not err1, err1
    assert len(loose) == 1, f"a join with no targets should merge them: {loose}"

    narrowed, err2 = vols(doc(*two_cubes(), dict(bar, targets=["body1"])))
    assert not err2, err2
    assert len(narrowed) == 2, f"body2 was not named and must survive: {narrowed}"
    assert abs(min(narrowed.values()) - 1000) < 1e-6, narrowed
    print(f"join left {len(loose)} body without targets, {len(narrowed)} with OK")


def test_a_join_that_reaches_none_of_its_targets_is_an_error():
    """Without targets this is how a separate body gets added, so it cannot
    raise. With them the caller has said which body to merge into, and quietly
    making a different one instead answers a question nobody asked."""
    far = {"id": "j", "type": "box", "length": 4, "width": 4, "height": 4,
           "operation": "join", "targets": ["body2"]}
    v, errors = vols(doc(*two_cubes(), far))
    assert errors, f"a join that reaches nothing it named must say so: {v}"
    assert "nothing to join to" in errors[0]["message"], errors
    assert "body2" in errors[0]["message"], errors
    print("a join that misses its target says so OK:", errors[0]["message"])


def test_naming_a_body_that_does_not_exist_says_which_one():
    d = doc(*two_cubes(), {
        "id": "c", "type": "box", "length": 60, "width": 20, "height": 2,
        "operation": "cut", "targets": ["body7"]})
    _v, errors = vols(d)
    assert errors, "a target that does not exist must be reported"
    assert "body7" in errors[0]["message"], errors
    print("an unknown target names itself OK:", errors[0]["message"])


def test_a_primitive_honours_operation_instead_of_ignoring_it():
    """box/cylinder/sphere used to call new_body directly, so `operation` on one
    of them was a field the builder read past without a word: a separate body
    appeared, nothing was raised, and the only way to find out was to measure."""
    d = doc(
        {"id": "a", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "b", "type": "cylinder", "radius": 4, "height": 40,
         "operation": "cut"},
    )
    v, errors = vols(d)
    assert not errors, errors
    assert len(v) == 1, f"a cut must not leave the tool behind as a body: {v}"
    bored = v["body1"]
    # r4 through a 20mm box: pi*16*20 = 1005 mm3 gone.
    assert 8000 - 1060 < bored < 8000 - 950, f"no bore was taken out: {bored}"
    print(f"a cylinder with operation cut bored the box OK ({bored:.1f} mm3)")


def test_a_primitive_with_no_operation_still_makes_its_own_body():
    """The default has to stay "new". Every document ever saved omits the field,
    and a box that suddenly fused into its neighbour would rewrite them all."""
    v, errors = vols(doc(
        {"id": "a", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "b", "type": "cylinder", "radius": 4, "height": 40},
    ))
    assert not errors, errors
    assert len(v) == 2, f"two primitives, two bodies: {v}"
    print("a primitive with no operation is still its own body OK")


def test_a_primitive_keeps_its_name():
    """Routing through the shared combine path must not turn "Cylinder" into
    "Body2". The name is what the timeline and the body list show."""
    _part, errors, bodies = rebuild(doc(
        {"id": "a", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "b", "type": "cylinder", "radius": 4, "height": 40},
        {"id": "c", "type": "sphere", "radius": 3},
    ))
    assert not errors, errors
    names = [b["name"] for b in bodies]
    assert names == ["Box", "Cylinder", "Sphere"], names
    print("primitives keep their names OK", names)


def test_a_missing_field_names_the_field():
    """`box` without `length` used to come back as "box failed (KeyError)", the
    one word that would have helped left out."""
    _part, errors, _bodies = rebuild(doc(
        {"id": "a", "type": "box", "depth": 10, "width": 10, "height": 10}))
    assert errors, "a box with no length must fail"
    msg = errors[0]["message"]
    assert "length" in msg, msg
    assert "KeyError" not in msg, msg
    print("a missing field names itself OK:", msg)


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
    print("body targets:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
