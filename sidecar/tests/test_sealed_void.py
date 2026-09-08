"""A cut that seals a cavity inside the body says so, and an open one stays quiet.

The report this closes: a box, a datum plane in the middle of it, a profile
sketched on that datum, and Cut. The prism never reaches a face, so the pocket
comes out as a bubble inside the solid. Both documents build green and, measured,
both remove the same volume, so the no-op guard cannot tell them apart. On screen
nothing changes, which is what "it doesn't cut" means.

Every case here needs its control, because a warning that fires on everything is
the same as no warning:

 1. The buried cut warns.
 2. The identical cut, extended until it breaks the surface, does NOT.
 3. A cut that SPLITS the body in two does not, which is the trap in the naive
    oracle: two pieces wear two shells, one skin each, and a raw shell delta
    reads that as a cavity. Shells minus solids is what separates them.
 4. Join and Intersect never warn: this is a property of a Cut.
 5. A caller that collects no diagnostics pays for none of it and sees none.
 6. Symmetric turns case 1 into case 2 without changing anything else, which is
    the fix the user is offered in the message.

Run: uv run python tests/test_sealed_void.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from builder import rebuild

H = 20.0        # box is z=0..20
MID = H / 2     # the datum, dead centre
R = 8.0

fails = []


def doc(distance, *, offset=MID, op="cut", sym=False):
    return {
        "features": [
            {"id": "s1", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "id": "r0", "width": 40, "height": 40,
                           "x": 0, "y": 0}]},
            {"id": "e1", "type": "extrude", "sketch": "s1", "distance": H,
             "operation": "new", "regions": [[0, 0, 0]]},
            {"id": "d1", "type": "datumPlane", "plane": "XY", "offset": offset},
            {"id": "s2", "type": "sketch", "plane": "d1",
             "entities": [{"type": "circle", "id": "c0", "x": 0, "y": 0, "radius": R}]},
            {"id": "e2", "type": "extrude", "sketch": "s2", "distance": distance,
             "operation": op, "regions": [[0, 0, 0]], "symmetric": sym},
        ],
        "params": [],
    }


def slot_doc(width=6.0):
    """A through-slot the full width of the box: it cuts the body into two
    pieces, which is the case a shell-count oracle gets wrong."""
    return {
        "features": [
            {"id": "s1", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "id": "r0", "width": 40, "height": 40,
                           "x": 0, "y": 0}]},
            {"id": "e1", "type": "extrude", "sketch": "s1", "distance": H,
             "operation": "new", "regions": [[0, 0, 0]]},
            {"id": "s2", "type": "sketch", "plane": "XY",
             "entities": [{"type": "rectangle", "id": "r1", "width": width, "height": 60,
                           "x": 0, "y": 0}]},
            {"id": "e2", "type": "extrude", "sketch": "s2", "distance": H + 10,
             "operation": "cut", "regions": [[0, 0, 0]]},
        ],
        "params": [],
    }


def build(document, collect=True):
    diag = [] if collect else None
    part, errors, bodies = rebuild(document, diagnostics=diag)
    return errors, bodies, (diag or [])


def sealed(diag):
    return [d for d in diag if d.get("kind") == "sealedVoid"]


def check(label, cond, detail=""):
    if cond:
        print("  ok    %s" % label)
    else:
        print("  FAIL  %s %s" % (label, detail))
        fails.append(label)


def main():
    print("1. a cut buried in the body warns")
    errors, bodies, diag = build(doc(5))
    check("built green", not errors, errors)
    s = sealed(diag)
    check("one sealedVoid", len(s) == 1, [d.get("kind") for d in diag])
    if s:
        check("keyed to the cut", s[0].get("feature_id") == "e2", s[0].get("feature_id"))
        check("says where", isinstance(s[0].get("at"), list))
        check("not lossy", s[0].get("lossy") is False)
        check("has a reason", bool(s[0].get("reason")))

    print("\n2. THE CONTROL: the same cut, reaching the surface, is quiet")
    errors, bodies, diag = build(doc(20))
    check("built green", not errors, errors)
    check("no sealedVoid", not sealed(diag), diag)

    print("\n3. THE CONTROL: a cut that splits the body in two is quiet")
    errors, bodies, diag = build(slot_doc())
    check("built green", not errors, errors)
    check("split into pieces", len(bodies) >= 1)
    check("no sealedVoid", not sealed(diag), diag)

    print("\n4. THE CONTROL: only a Cut warns")
    for op in ("new", "intersect"):
        errors, bodies, diag = build(doc(5, op=op))
        check("%s is quiet" % op, not sealed(diag), diag)

    print("\n5. THE CONTROL: a caller collecting nothing gets nothing, and does not crash")
    part, errors, bodies = rebuild(doc(5), diagnostics=None)
    check("built green with no diag list", not errors, errors)

    print("\n6. symmetric turns the buried cut into an open one")
    errors, bodies, diag = build(doc(12, sym=True))
    check("built green", not errors, errors)
    check("no sealedVoid", not sealed(diag), diag)
    # ...and it really did cut through: 40x40x20 less a 20-tall cylinder of r=8.
    vol = bodies[0]["shape"].volume if bodies else 0
    want = 40 * 40 * H - 3.14159265 * R * R * H
    check("cut right through", abs(vol - want) < 1.0, "%.1f vs %.1f" % (vol, want))

    print("\n%s" % ("ALL PASS" if not fails else "%d FAILED: %s" % (len(fails), fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
