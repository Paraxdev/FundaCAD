"""A feature whose `activeWhen` resolves to 0 is left out of the build.

This is the format half of conditional modelling: a parameter decides whether a
feature exists, so one document can be a hexagon fidget with an open centre or
a solid core without two copies of the timeline. The build is the one place the
rule lives, so the app, the MCP server, export and projection all agree.

What each case guards:

 1. Off means not built, on means built, absent means built. The third is every
    document saved before the field existed.
 2. A dependent that fails because its input is switched off says WHY. Without
    that the row reads "sketch not found", which sends someone hunting for a
    broken sketch that is fine.
 3. A condition that does not resolve, or resolves to NaN, is a red row and the
    feature is not built. Reading a broken condition as "off" would quietly
    delete geometry.
 4. The incremental cache follows the parameter. Flipping it off and back on
    through rebuild_cached gives the full rebuild's answer each time; a cache
    that ignored the field would hand back the previous state.

Run: uv run python tests/test_active_when.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import os
import sys
import traceback

os.environ.setdefault("FUNDACAD_DISK_CACHE", "0")

import builder


def box(fid, size, **extra):
    f = {"id": fid, "type": "box", "length": size, "width": size, "height": size}
    f.update(extra)
    return f


def build(features, params=None, cached=False):
    doc = {"parameters": params or {}, "features": features}
    fn = builder.rebuild_cached if cached else builder.rebuild
    _part, errors, bodies = fn(doc)
    return errors, [b for b in bodies if b.get("shape") is not None]


def test_off_is_not_built_on_and_absent_are():
    errors, bodies = build([box("a", 10, activeWhen="flag")], {"flag": 0})
    assert not errors and not bodies, (errors, bodies)
    errors, bodies = build([box("a", 10, activeWhen="flag")], {"flag": 1})
    assert not errors and len(bodies) == 1, (errors, bodies)
    errors, bodies = build([box("a", 10, activeWhen=-2.5)])
    assert not errors and len(bodies) == 1, "any non-zero value is on"
    errors, bodies = build([box("a", 10)])
    assert not errors and len(bodies) == 1, "a feature with no condition always builds"
    print("off / on / absent OK")


def test_a_dependent_of_a_switched_off_feature_says_why():
    sketch = {"id": "sk", "type": "sketch", "plane": "XY", "activeWhen": "flag",
              "entities": [{"id": "c", "type": "circle", "radius": 5, "x": 0, "y": 0}]}
    extrude = {"id": "ex", "type": "extrude", "sketch": "sk", "distance": 4, "operation": "new"}
    errors, bodies = build([sketch, extrude], {"flag": 0})
    assert not bodies, bodies
    assert len(errors) == 1 and errors[0]["feature_id"] == "ex", errors
    message = errors[0]["message"]
    assert "sk is switched off by its activeWhen" in message, message
    # control: on, the same pair builds clean, so the message above is not a
    # sentence that gets appended to every error
    errors, bodies = build([sketch, extrude], {"flag": 1})
    assert not errors and len(bodies) == 1, (errors, bodies)
    print("dependent message OK:", message)


def test_a_body_id_that_shifted_names_the_switched_off_feature():
    """The hexagon fidget found this one: switching off the core extrude left a
    trim naming body2, which no longer existed, and the message only said so.
    A body id carries no feature id, so the hint has to come from position."""
    feats = [box("a", 10), box("b", 4, activeWhen="flag"),
             box("bo", 3, operation="intersect", targets=["body2"])]
    errors, _ = build(feats, {"flag": 0})
    assert len(errors) == 1 and errors[0]["feature_id"] == "bo", errors
    assert "b is switched off" in errors[0]["message"], errors[0]["message"]
    # control: the same broken reference with nothing switched off gets no hint
    errors, _ = build([box("a", 10), feats[2]])
    assert len(errors) == 1 and "switched off" not in errors[0]["message"], errors
    print("shifted body id hint OK")


def test_a_broken_condition_is_an_error_and_builds_nothing():
    errors, bodies = build([box("a", 10, activeWhen="missing")])
    assert not bodies and len(errors) == 1 and errors[0]["feature_id"] == "a", (errors, bodies)
    errors, bodies = build([box("a", 10, activeWhen="bad")], {"bad": float("nan")})
    assert not bodies and len(errors) == 1 and "activeWhen" in errors[0]["message"], errors
    print("broken condition OK:", errors[0]["message"])


def test_the_cache_follows_the_parameter():
    feats = [box("a", 10), box("b", 4, activeWhen="flag")]
    seen = []
    for flag in (1, 0, 1, 0):
        errors, bodies = build(feats, {"flag": flag}, cached=True)
        assert not errors, errors
        seen.append(len(bodies))
    assert seen == [2, 1, 2, 1], f"cached body counts {seen}, expected [2, 1, 2, 1]"
    print("cache follows the flag OK:", seen)


if __name__ == "__main__":
    try:
        test_off_is_not_built_on_and_absent_are()
        test_a_dependent_of_a_switched_off_feature_says_why()
        test_a_body_id_that_shifted_names_the_switched_off_feature()
        test_a_broken_condition_is_an_error_and_builds_nothing()
        test_the_cache_follows_the_parameter()
        print("\nall activeWhen tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
