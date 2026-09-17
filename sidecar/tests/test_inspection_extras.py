"""Interference/clearance and physical-properties coverage for the Inspect
panel's two newer capabilities: the overlap-solid overlay + clearance mode on
`interference`, and the numbers `inspect` feeds into the filament estimate.

Run: uv run python tests/test_inspection_extras.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math

from build123d import Box, Pos

import server
from inspect_model import inspect_bodies

PASS = "ok"


def _box(idx, w, h, depth, x=0, y=0, op="new"):
    """Two features (sketch + extrude) that build a w×h×depth box centered at
    (x, y) in the sketch plane, extruded from z=0."""
    s, e = f"s{idx}", f"e{idx}"
    return s, [
        {"id": s, "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]},
        {"id": e, "type": "extrude", "sketch": s, "distance": depth, "operation": op},
    ]


def _doc(*feature_lists):
    features = []
    for f in feature_lists:
        features += f
    return {"parameters": {}, "features": features}


# --- interference: exact overlap volume + the overlay mesh --------------------


def test_two_overlapping_boxes_give_the_exact_overlap_volume():
    _s1, a = _box(1, 20, 20, 20, 0, 0)
    _s2, b = _box(2, 20, 20, 20, 10, 10)
    res = server._interference_job(_doc(a, b))
    assert "error" not in res, res
    pairs = res["pairs"]
    assert len(pairs) == 1, pairs
    assert abs(pairs[0]["volume"] - 2000.0) < 1e-6, pairs[0]["volume"]
    # the overlay mesh: a real triangulation of the overlap solid, not a stub
    assert len(pairs[0].get("positions") or []) >= 9, "no overlap mesh returned"
    assert len(pairs[0]["indices"]) % 3 == 0 and len(pairs[0]["indices"]) > 0
    print(f"{PASS} overlap volume 2000 exactly, overlay mesh has "
          f"{len(pairs[0]['indices']) // 3} triangles")


def test_touching_boxes_give_zero_overlap():
    _s1, a = _box(1, 20, 20, 20, 0, 0)
    _s2, b = _box(2, 20, 20, 20, 20, 0)  # shares the x=10 face exactly, no volume
    res = server._interference_job(_doc(a, b))
    assert "error" not in res, res
    assert res["pairs"] == [], res["pairs"]
    print(f"{PASS} touching boxes report zero interferences")


# --- clearance mode: a 0.1 mm gap crosses a 0.2 mm threshold, not a 0.05 mm one


def _gapped_boxes(gap):
    """Two 20x20x20 boxes separated by `gap` mm along X, nothing else offset."""
    _s1, a = _box(1, 20, 20, 20, 0, 0)
    cx = 10 + gap + 10  # boxB's min-x = boxA's max-x (10) + gap
    _s2, b = _box(2, 20, 20, 20, cx, 0)
    return _doc(a, b)


def test_a_small_gap_is_reported_at_a_generous_threshold():
    res = server._interference_job(_gapped_boxes(0.1), threshold=0.2)
    assert "error" not in res, res
    assert res["pairs"] == [], "a 0.1mm gap must not read as an overlap"
    clearances = res["clearances"]
    assert len(clearances) == 1, clearances
    c = clearances[0]
    assert abs(c["distance"] - 0.1) < 1e-6, c["distance"]
    assert len(c["pointA"]) == 3 and len(c["pointB"]) == 3
    print(f"{PASS} 0.1mm gap reported at threshold 0.2 (distance {c['distance']:.4f})")


def test_the_same_gap_is_not_reported_at_a_tighter_threshold():
    res = server._interference_job(_gapped_boxes(0.1), threshold=0.05)
    assert "error" not in res, res
    assert res["pairs"] == [], res["pairs"]
    assert res["clearances"] == [], res["clearances"]
    print(f"{PASS} the same 0.1mm gap is silent at threshold 0.05")


def test_clearance_mode_is_off_by_default():
    """No threshold means no clearance pass at all, callers that never asked
    for it must not pay for the extra distance search or see the key."""
    res = server._interference_job(_gapped_boxes(0.1))
    assert "error" not in res, res
    assert "clearances" not in res, res
    print(f"{PASS} clearance mode stays off unless a threshold is given")


# --- the pair cap: a clear message, not a hang ---------------------------------


def test_a_dense_candidate_set_is_capped_with_a_clear_message():
    # 4 boxes stacked so every pair among them overlaps and survives the bbox
    # reject: 6 candidate pairs total.
    feats = []
    for i in range(4):
        _s, f = _box(i, 20, 20, 20, i * 2, 0)  # heavy mutual overlap
        feats.append(f)
    old_cap = server._MAX_INTERFERENCE_OPS
    server._MAX_INTERFERENCE_OPS = 2
    try:
        res = server._interference_job(_doc(*feats))
    finally:
        server._MAX_INTERFERENCE_OPS = old_cap
    assert "error" not in res, res
    assert res.get("truncated") is True, res
    assert "message" in res and res["message"], res
    assert len(res["pairs"]) <= 2, res["pairs"]
    print(f"{PASS} a dense set is capped ({len(res['pairs'])} pairs) with a message")


# --- physical properties: an L-shaped body's center of mass --------------------


def test_center_of_mass_of_an_l_shape_matches_the_analytic_value():
    # Two non-overlapping legs, fused: A spans x[0,20] y[0,10], B spans
    # x[0,10] y[10,20], both extruded z[0,10]. Standard 2D composite centroid.
    leg_a = Pos(10, 5, 5) * Box(20, 10, 10)
    leg_b = Pos(5, 15, 5) * Box(10, 10, 10)
    shape = leg_a + leg_b
    rep = inspect_bodies([{"id": "b1", "name": "L", "shape": shape}])[0]

    area_a, area_b = 200.0, 100.0
    cx = (area_a * 10 + area_b * 5) / (area_a + area_b)
    cy = (area_a * 5 + area_b * 15) / (area_a + area_b)
    cz = 5.0  # uniform cross-section along z, midway through the 10mm depth

    assert abs(rep["volume"] - 3000.0) < 1e-6, rep["volume"]
    com = rep["centerOfMass"]
    assert abs(com[0] - cx) < 1e-6, (com, cx)
    assert abs(com[1] - cy) < 1e-6, (com, cy)
    assert abs(com[2] - cz) < 1e-6, (com, cz)
    print(f"{PASS} L-shape center of mass {com} matches the analytic "
          f"({cx:.4f}, {cy:.4f}, {cz:.4f})")


# --- mass + filament length math, mirroring src/features/filamentEstimate.ts --


def test_mass_for_a_10mm_cube_in_pla():
    rep = inspect_bodies([{"id": "b1", "name": "Cube", "shape": Box(10, 10, 10)}])[0]
    density_pla = 1.24  # g/cm3
    mass_g = rep["volume"] / 1000.0 * density_pla  # mm3 -> cm3 -> g
    assert abs(mass_g - 1.24) < 1e-9, mass_g
    print(f"{PASS} a 10mm PLA cube masses {mass_g} g")


def test_filament_length_math_for_1_75mm():
    rep = inspect_bodies([{"id": "b1", "name": "Cube", "shape": Box(10, 10, 10)}])[0]
    diameter = 1.75
    cross_section = math.pi * (diameter / 2) ** 2  # mm2
    length_mm = rep["volume"] / cross_section  # mm3 / mm2 = mm
    length_m = length_mm / 1000.0
    assert abs(length_mm - 1000.0 / cross_section) < 1e-9
    assert length_m > 0.4 and length_m < 0.5, length_m
    print(f"{PASS} 1000mm3 at 1.75mm filament needs {length_m:.4f} m")


if __name__ == "__main__":
    test_two_overlapping_boxes_give_the_exact_overlap_volume()
    test_touching_boxes_give_zero_overlap()
    test_a_small_gap_is_reported_at_a_generous_threshold()
    test_the_same_gap_is_not_reported_at_a_tighter_threshold()
    test_clearance_mode_is_off_by_default()
    test_a_dense_candidate_set_is_capped_with_a_clear_message()
    test_center_of_mass_of_an_l_shape_matches_the_analytic_value()
    test_mass_for_a_10mm_cube_in_pla()
    test_filament_length_math_for_1_75mm()
    print("all inspection-extras tests passed")
