"""An `up to` face reference recovers when the sketch under it moves.

A `by:"nearest"` face pick stores a point on the face. When the sketch that
face sits over is edited, the face can slide sideways out from under that point
so the point lands beyond the face's own edge, in the seam it shares with the
wall beside it. Point-to-face distance then reads the SAME shared edge point for
both faces, so both are byte-for-byte equidistant and `_nearest_one` refuses the
pick as ambiguous, the feature comes untied from its up-to plane and silently
becomes a no-op.

The two faces differ on their UNBOUNDED surfaces though: the point is still dead
in the face's own plane while the wall it ties with is millimetres off it. The
resolver re-scores such a tie on that metric and keeps the face the point is
still ON, flagged lossy so the timeline shows the reference drifted and offers a
re-pick. It fires ONLY when exactly one tied face still carries the point in its
surface, so a genuine ambiguity (off both, or on both) still refuses. This
mirrors test_selector_ambiguity.py, which pins the refusals this must not weaken.

Run: uv run python tests/test_slid_out_face.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from build123d import Box
from geom_select import resolve_faces

PASS = "  ok"

BOX = Box(20, 20, 20)  # centred at the origin: faces at +/-10 on each axis


def face_sel(point, **kw):
    return {"kind": "face", "by": "nearest", "point": point, **kw}


def test_a_face_slid_off_its_point_is_recovered():
    """(11, 0, 10) is in the top face's plane (z=10) but 1mm past its +x edge,
    so its nearest point on the top face AND on the +x wall is the shared edge
    point (10, 0, 10), a dead tie. The point is still ON the top plane and 1mm
    off the wall's plane, so the top face is the one it belongs to."""
    got = resolve_faces(BOX, face_sel([11.0, 0.0, 10.0]))
    assert len(got) == 1, got
    c = got[0].center()
    assert abs(c.Z - 10.0) < 1e-6 and abs(c.X) < 1e-6 and abs(c.Y) < 1e-6, \
        f"expected the top face at z=10, got ({c.X}, {c.Y}, {c.Z})"
    # stable, not order-of-iteration luck
    again = resolve_faces(BOX, face_sel([11.0, 0.0, 10.0]))[0].center()
    assert (again.X, again.Y, again.Z) == (c.X, c.Y, c.Z)
    print(PASS, "a face that slid off its point is recovered by the surface it lies in")


def test_the_recovery_is_flagged_lossy_and_repairable():
    """The reference DID drift, even though we recovered it, so the feature must
    carry an amber diagnostic that lights the Re-pick button (repairableDiagFor
    gates on the code, not on resolved==0)."""
    diag = []
    resolve_faces(BOX, face_sel([11.0, 0.0, 10.0]), diag=diag, feature_id="fS")
    assert diag and diag[-1]["feature_id"] == "fS", diag
    d = diag[-1]
    assert d["resolved"] == 1 and d["lossy"] is True, d
    assert d.get("code") == "ambiguousReference", d
    assert d.get("at") == [11.0, 0.0, 10.0], d
    print(PASS, "the recovery emits a lossy, repairable diagnostic")


def test_a_point_off_both_surfaces_still_refuses():
    """CONTROL: (11, 11, 0) sits on the shared VERTICAL edge's seam, nearest
    point (10, 10, 0) on both the +x and +y walls, a real tie, but it is 1mm off
    BOTH planes. Belonging to neither, it must still refuse, the recovery is not
    a licence to guess."""
    try:
        resolve_faces(BOX, face_sel([11.0, 11.0, 0.0]))
    except ValueError as ex:
        assert "ambiguous face reference" in str(ex), str(ex)
        print(PASS, "a point off both tied surfaces still refuses")
        return
    raise AssertionError("a point belonging to neither tied face did not refuse")


def test_a_point_on_both_surfaces_still_refuses():
    """CONTROL: (10, 10, 0) is dead on the shared edge and IN both planes (x=10
    and y=10), so it belongs to both equally. Exactly the coincidence the gate
    exists to refuse, unchanged by the recovery."""
    try:
        resolve_faces(BOX, face_sel([10.0, 10.0, 0.0]))
    except ValueError as ex:
        assert "ambiguous" in str(ex), str(ex)
        print(PASS, "a point on both tied surfaces still refuses")
        return
    raise AssertionError("a point on both tied faces did not refuse")


def test_a_clear_winner_is_untouched():
    """CONTROL: an unambiguous pick never reaches the tie-break and resolves
    exactly as before, recording nothing."""
    diag = []
    got = resolve_faces(BOX, face_sel([15.0, 0.0, 0.0]), diag=diag, feature_id="fW")
    c = got[0].center()
    assert abs(c.X - 10.0) < 1e-6 and abs(c.Y) < 1e-6 and abs(c.Z) < 1e-6, (c.X, c.Y, c.Z)
    assert diag == [], f"a clear winner must record nothing, got {diag}"
    print(PASS, "a clear winner resolves unchanged and records nothing")


def main():
    test_a_face_slid_off_its_point_is_recovered()
    test_the_recovery_is_flagged_lossy_and_repairable()
    test_a_point_off_both_surfaces_still_refuses()
    test_a_point_on_both_surfaces_still_refuses()
    test_a_clear_winner_is_untouched()
    print("ALL PASS")


if __name__ == "__main__":
    main()
