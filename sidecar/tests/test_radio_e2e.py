"""End-to-end: a whole parametric radio cabinet, built the way a real session
builds one, exercising most of the suite in one document.

Run:  python test_radio_e2e.py

The point is COVERAGE THROUGH A REAL PART, not a unit of one operator: a driving
parameter table, a leaning side profile sketched and extruded into a wedge, that
wedge softened with a multi-edge fillet, hollowed with a CLOSED shell (the case),
a grid of speaker holes cut through the front wall, a recessed dial cut into it,
two knobs raised as a separate body, and the cabinet split into a front and a
back half for printing. If any one of those regresses, the radio comes out wrong
here in a way the picture (and these asserts) can see.

It doubles as the regression guard for the closed-shell fix: the cabinet is only
a cabinet if the shell actually hollowed it, so the volume check below fails
loudly if a closed shell ever goes back to shrinking the solid.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from builder import rebuild
from shape_util import _as_compound

FRONT = {"origin": [8.054, 0, 50.111], "normal": [-0.9873, 0, 0.1587], "xdir": [0, -1, 0]}
PASS = "  ok"


def _match_edge(mid, direction, length):
    return {"kind": "edge", "by": "match", "body": "body1",
            "fp": {"mid": mid, "dir": direction, "length": length, "curve": "line"}}


def _grille(cols=8, rows=7, pitch=7.6, r=2.4, cx=27.0, cy=0.0):
    ents, k = [], 0
    for j in range(rows):
        for i in range(cols):
            x = round(cx + (i - (cols - 1) / 2) * pitch, 2)
            y = round(cy + (j - (rows - 1) / 2) * pitch, 2)
            ents.append({"type": "circle", "id": f"h{k}", "x": x, "y": y, "radius": r})
            k += 1
    return ents


def _doc():
    params = {"W": 178.0, "H": 112.0, "D": 66.0, "frontLean": 18.0,
              "halfW": 89.0, "soft": 14.0, "wall": 2.5}
    feats = [
        # leaning side profile -> wedge cabinet
        {"id": "sk1", "type": "sketch", "plane": "XZ", "entities": [
            {"type": "line", "id": "a", "x1": 0, "y1": 0, "x2": "D", "y2": 0},
            {"type": "line", "id": "b", "x1": "D", "y1": 0, "x2": "D", "y2": "H"},
            {"type": "line", "id": "c", "x1": "D", "y1": "H", "x2": "frontLean", "y2": "H"},
            {"type": "line", "id": "d", "x1": "frontLean", "y1": "H", "x2": 0, "y2": 0}]},
        {"id": "ex1", "type": "extrude", "sketch": "sk1", "distance": "halfW",
         "symmetric": True, "operation": "new"},
        # soften the top and vertical corners
        {"id": "fil1", "type": "fillet", "radius": "soft", "edges": [
            _match_edge([9, 89, 56], [0.1587, 0, 0.9873], 113.44),
            _match_edge([9, -89, 56], [0.1587, 0, 0.9873], 113.44),
            _match_edge([66, -89, 56], [0, 0, 1], 112),
            _match_edge([66, 89, 56], [0, 0, 1], 112),
            _match_edge([18, 0, 112], [0, 1, 0], 178),
            _match_edge([66, 0, 112], [0, 1, 0], 178),
            _match_edge([42, 89, 112], [1, 0, 0], 48),
            _match_edge([42, -89, 112], [1, 0, 0], 48)]},
        # hollow to a case (CLOSED shell)
        {"id": "sh1", "type": "shell", "thickness": "wall"},
        # speaker grille through the front wall
        {"id": "sk2", "type": "sketch", "plane": FRONT, "entities": _grille()},
        {"id": "ex2", "type": "extrude", "sketch": "sk2", "distance": -8,
         "operation": "cut", "targets": ["body1"]},
        # recessed tuning dial
        {"id": "sk4", "type": "sketch", "plane": FRONT,
         "entities": [{"type": "circle", "id": "df", "x": -40, "y": 8, "radius": 19}]},
        {"id": "ex4", "type": "extrude", "sketch": "sk4", "distance": -2,
         "operation": "cut", "targets": ["body1"]},
        # two knobs, raised as their own body
        {"id": "sk5", "type": "sketch", "plane": FRONT, "entities": [
            {"type": "circle", "id": "kv", "x": -40, "y": -30, "radius": 9},
            {"type": "circle", "id": "kt", "x": -13, "y": -33, "radius": 6.5}]},
        {"id": "ex5", "type": "extrude", "sketch": "sk5", "distance": 12, "operation": "new"},
        # split the cabinet into a printable front and back
        {"id": "spl1", "type": "split", "body": "body1", "keep": "both",
         "plane": {"origin": [40, 0, 56], "normal": [1, 0, 0], "xdir": [0, 1, 0]}},
    ]
    return {"parameters": params, "paramDefs": {}, "version": 9, "features": feats}


def test_the_radio_builds_end_to_end():
    diag = []
    _part, errs, bodies = rebuild(_doc(), diagnostics=diag)
    assert errs == [], errs  # every feature built
    shapes = {b["id"]: _as_compound(b["shape"]) for b in bodies}

    # THREE bodies: two cabinet halves from the split, plus the knobs.
    assert len(bodies) == 3, [b["id"] for b in bodies]

    # tell the knobs (small) from the two cabinet halves (large).
    vols = sorted((b["id"], shapes[b["id"]].volume) for b in bodies)
    vols.sort(key=lambda kv: kv[1])
    knob_id, knob_vol = vols[0]
    case_ids = [kv[0] for kv in vols[1:]]
    assert knob_vol < 20000, ("knobs too big", knob_vol)
    assert all(v > 40000 for _, v in vols[1:]), ("a cabinet half is missing", vols)
    print(PASS, "three bodies: two cabinet halves and the knobs")

    # the cabinet is HOLLOW: the two halves together are a 2.5mm-walled case, far
    # less than the ~1.1e6 mm3 the solid wedge would be. This is the closed-shell
    # fix, if it regressed to a shrunk solid the halves would be ~5x heavier.
    case_vol = sum(v for _, v in vols[1:])
    assert case_vol < 260000, ("the shell did not hollow the cabinet", case_vol)
    assert case_vol > 90000, ("the cabinet lost its walls", case_vol)
    print(PASS, f"the cabinet is a hollow case ({case_vol:.0f} mm3 of wall, not a solid block)")

    # the grille + dial punched real openings: the front half carries many faces
    # (56 holes + dial + body), far more than a plain half-shell's handful.
    front = max(case_ids, key=lambda i: len(shapes[i].faces()))
    assert len(shapes[front].faces()) > 100, ("grille holes missing", len(shapes[front].faces()))
    print(PASS, f"the front half carries the grille and dial ({len(shapes[front].faces())} faces)")

    # the split parted the cabinet across X: the two halves' depths sum to the
    # 66mm envelope (40 + 26), neither is the whole thing.
    depths = sorted(round(shapes[i].bounding_box().size.X) for i in case_ids)
    assert depths == [26, 40], depths
    print(PASS, "the cabinet is split into a 40mm front and a 26mm back")


if __name__ == "__main__":
    try:
        test_the_radio_builds_end_to_end()
        print("\nradio end-to-end test passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
