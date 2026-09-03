"""A datum plane made from a face follows that face.

A datum used to store the face's plane as three frozen vectors, which is a note
about where a face used to be rather than a construction plane. Raise the box it
was made from and the datum stays behind, taking every sketch placed on it with
it, and nothing reports anything: the datum still resolves, the sketch still
builds, and the geometry is in the wrong place.

So the feature carries the face SELECTOR now and `plane` is a cache. What has to
be true, and is not obvious from the code:

 1. The datum MOVES when its face moves. That is the feature.
 2. It does not move when nothing moved. A datum that drifted by float noise on
    every rebuild would move every coordinate in every sketch on it.
 3. It survives its face becoming unresolvable, by falling back to the cache. A
    datum that failed would take every downstream sketch with it, which is a
    worse answer than a plane that stopped following.
 4. It keeps the direction the user accepted. A B-rep face's normal can come
    back reversed with the geometry unmoved, and the normal is the direction the
    datum's `offset` runs along, so a silent flip turns "5mm above this face"
    into "5mm inside the part".

Run:  uv run python test_datum_face.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from builder import rebuild


# A box is centred on the origin, so its top face sits at height/2. Everything
# below is written against PICK_TOP: the datum was made when the box was 10 tall,
# so both the cached plane and the recorded selector point are at z=5 and stay
# there however the box is rebuilt. That staleness is the point. A datum that
# followed only because its stored point happened to be right would pass a test
# that moved the point along with the box, and fail for a real user.
PICK_HEIGHT = 10.0
PICK_TOP = PICK_HEIGHT / 2


def _doc(height, *, face=True, at=None, plane=None, offset=0.0):
    """A box, and a datum on the face at its top, picked when it was 10 tall."""
    cached = plane or {"origin": [0, 0, PICK_TOP], "normal": [0, 0, 1], "xdir": [1, 0, 0]}
    datum = {"id": "d1", "type": "datumPlane", "plane": cached, "offset": offset}
    if face:
        # Deliberately the OLD point. The top face of the taller box is still the
        # nearest face to it (7.5 away, against 15 for the nearest side), which
        # is the ordinary case; a change large enough to beat that is a
        # reference that has genuinely lost its face, covered below.
        datum["face"] = {"kind": "face", "by": "nearest", "point": [0, 0, PICK_TOP]}
    if at:
        datum["at"] = at
    return {
        "parameters": {},
        "features": [
            {"id": "b1", "type": "box", "length": 40, "width": 30, "height": height},
            datum,
        ],
    }


def _datum_plane(doc):
    datums = {}
    _part, errors, _bodies = rebuild(doc, datums_out=datums)
    assert not errors, errors
    d = datums.get("d1")
    assert d is not None, f"no datum registered: {datums}"
    return d


def test_it_follows_the_face_up():
    # Picked at 10 tall, rebuilt at 25. A datum that froze its numbers reports
    # z=5; one that resolves its face reports 12.5.
    p = _datum_plane(_doc(25))
    assert abs(p["origin"][2] - 12.5) < 1e-6, (
        f"the datum did not follow its face: origin {p['origin']}, expected z=12.5"
    )
    assert abs(p["normal"][2] - 1) < 1e-6, f"normal turned: {p['normal']}"
    print(f"follows the face: z={p['origin'][2]:.3f} OK")


def test_it_does_not_drift_when_nothing_moved():
    # Property 2. Byte-for-byte would be too strong across a resolve, but a
    # datum that moves at all on an unchanged document moves every coordinate
    # stored in every sketch on it.
    a = _datum_plane(_doc(PICK_HEIGHT))
    b = _datum_plane(_doc(PICK_HEIGHT))
    for k in ("origin", "normal", "xdir"):
        for x, y in zip(a[k], b[k]):
            assert abs(x - y) < 1e-12, f"{k} drifted between identical rebuilds: {a} vs {b}"
    assert abs(a["origin"][2] - PICK_TOP) < 1e-9, a["origin"]
    print("stable across identical rebuilds OK")


def test_the_offset_still_runs_from_the_followed_face():
    # The offset is what makes a datum useful, and it has to be measured from
    # where the face IS, not from where it was.
    p = _datum_plane(_doc(25, offset=5))
    assert abs(p["origin"][2] - 17.5) < 1e-6, (
        f"offset applied to the stale plane: {p['origin']}, expected z=17.5"
    )
    print("offset runs from the resolved face OK")


def test_a_datum_with_no_face_is_untouched():
    # Every datum in every existing document takes this path.
    p = _datum_plane(_doc(25, face=False))
    assert abs(p["origin"][2] - PICK_TOP) < 1e-9, f"a frozen datum moved: {p['origin']}"
    print("a datum with no face reference still uses its plane OK")


def test_an_unresolvable_face_falls_back_to_the_cache():
    # Property 3. The point is nowhere near the part, so nothing sensible
    # resolves; the datum must still register, at the cached plane, rather than
    # raising and taking every sketch on it down.
    doc = _doc(PICK_HEIGHT)
    doc["features"][1]["face"] = {"kind": "face", "by": "match", "fp": {"nope": 1}}
    p = _datum_plane(doc)
    assert abs(p["origin"][2] - PICK_TOP) < 1e-9, f"fallback did not use the cache: {p}"
    print("an unresolvable face falls back to the cached plane OK")


def test_it_keeps_the_direction_the_user_accepted():
    # Property 4. The datum reports the direction the document stored, not the
    # one the freshly resolved face happens to carry, because the normal is the
    # direction `offset` runs along.
    #
    # THE PREMISE IS THE OUTWARD NORMAL, and it used to be the inward one: the
    # fixture faced the cached plane DOWN on the box's TOP face, on the story
    # that the pick had been made from below. The app cannot author that
    # document — sketchView.faceSketchPlane runs every pick through
    # outwardNormal, so a face pick always stores the normal pointing out of the
    # solid — and once candidates are filtered by the cached normal (see
    # geom_select.resolve_face_on_plane) that fixture asks for the top face
    # while naming the bottom one, which is exactly the far-side confusion the
    # filter exists to remove. Read as written, the answer it now gets is the
    # right one. The reachable version of "the face's normal disagrees with the
    # cache" is an orientation FLIP under a boolean, where no same-facing face
    # is left at all, and that is tested against the resolver directly in
    # test_sketch_on_face.py.
    doc = _doc(25, offset=5.0)
    p = _datum_plane(doc)
    assert abs(p["origin"][2] - 17.5) < 1e-6, f"did not follow: {p['origin']}"
    assert p["normal"][2] > 0, f"normal flipped out from under the offset: {p['normal']}"
    print("keeps the accepted direction OK")


def test_a_cylinder_gives_its_tangent_plane_at_the_stored_point():
    # A cylinder has no plane of its own, so the pick point is part of the
    # definition. A 20-radius cylinder touched at +X gives a plane at x=20
    # facing +X, and it has to come off the analytic surface rather than a
    # tessellation.
    doc = {
        "parameters": {},
        "features": [
            {"id": "c1", "type": "cylinder", "radius": 20, "height": 30},
            {
                "id": "d1",
                "type": "datumPlane",
                "plane": {"origin": [20, 0, 0], "normal": [1, 0, 0], "xdir": [0, 0, 1]},
                "face": {"kind": "face", "by": "nearest", "point": [20, 0, 0]},
                "at": [20, 0, 0],
            },
        ],
    }
    p = _datum_plane(doc)
    assert abs(p["origin"][0] - 20) < 1e-6 and abs(p["origin"][1]) < 1e-6, p["origin"]
    assert abs(p["normal"][0] - 1) < 1e-6, f"not facing out of the shaft: {p['normal']}"
    # x along the shaft, which is the only in-plane frame the geometry supplies.
    assert abs(abs(p["xdir"][2]) - 1) < 1e-6, f"x axis is not the cylinder's: {p['xdir']}"
    print("a cylinder gives its tangent plane at the stored point OK")


if __name__ == "__main__":
    try:
        test_it_follows_the_face_up()
        test_it_does_not_drift_when_nothing_moved()
        test_the_offset_still_runs_from_the_followed_face()
        test_a_datum_with_no_face_is_untouched()
        test_an_unresolvable_face_falls_back_to_the_cache()
        test_it_keeps_the_direction_the_user_accepted()
        test_a_cylinder_gives_its_tangent_plane_at_the_stored_point()
        print("\nall datum-face tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
