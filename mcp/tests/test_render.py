"""The picture, checked by counting pixels.

A renderer is easy to test badly: draw something, see that it is not blank,
declare victory. Every test here therefore names a specific thing that must be
TRUE of the image and pairs it with the arrangement where it must be FALSE — a
depth test that ignores depth still paints, an upside-down projection still
fills the frame, and a section that clips nothing still looks like a model.

Run: uv run python mcp/tests/test_render.py
"""

import _bootstrap  # noqa: F401
import _run

import numpy as np

import render as R

BG = np.array(R.BACKGROUND)


def box_mesh(sx=20, sy=20, sz=20, cx=0, cy=0, cz=0, ident="b1"):
    """A closed box with outward winding, in the shape the sidecar sends."""
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [(cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz),
         (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
         (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz),
         (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz)]
    faces = [(0, 3, 2), (0, 2, 1), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
             (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return {"id": ident,
            "positions": [c for p in v for c in p],
            "indices": [i for f in faces for i in f],
            "faceIds": [k // 2 for k in range(12)],
            "edges": []}


def painted(img):
    """How many pixels are not the background."""
    return int((np.abs(img.astype(int) - BG).sum(axis=2) > 12).sum())


# --- the camera ---------------------------------------------------------------


def test_the_basis_is_orthonormal_for_every_named_view():
    for name in R.NAMED_VIEWS:
        b = R.view_basis(R.direction_for(name))
        assert np.allclose(b @ b.T, np.eye(3), atol=1e-9), name


def test_looking_straight_down_does_not_collapse():
    """The control for the up-vector fallback. World up is +Z, so a top view has
    it parallel to the view direction and the obvious cross product is zero —
    without the fallback the whole image is one pixel wide."""
    for name in ("top", "bottom"):
        b = R.view_basis(R.direction_for(name))
        assert np.allclose(b @ b.T, np.eye(3), atol=1e-9), name
        img = R.render([box_mesh()], 120, 120, view=name)
        assert painted(img) > 5000, f"{name} view painted {painted(img)} pixels"


def test_world_UP_lands_in_the_upper_half_of_the_image():
    """Screen y runs down and world up runs up, so the projection negates. Get
    that wrong and every render is upside down, which nothing else here would
    notice: a box looks the same either way."""
    tall = box_mesh(sx=20, sy=20, sz=6, cz=30)
    flat = box_mesh(sx=20, sy=20, sz=6, cz=-30, ident="b2")
    img = R.render([tall, flat], 200, 200, view="front")
    top_half = painted(img[:100])
    bottom_half = painted(img[100:])
    # the two boxes are identical, so the only asymmetry is which is drawn where
    assert top_half > 0 and bottom_half > 0
    reds_top = int(img[:100, :, 0].sum())
    reds_bottom = int(img[100:, :, 0].sum())
    # BODY_COLORS[0] is bluish and [1] is reddish, so the second body being in
    # the LOWER half is what a correct projection produces
    assert reds_bottom > reds_top, "the body at z = -30 was not drawn at the bottom"


def test_the_fit_puts_everything_on_screen_with_a_margin():
    pts = np.array([[-50, -30, 10], [50, 30, -10], [0, 0, 0]], dtype=float)
    for name in R.NAMED_VIEWS:
        basis = R.view_basis(R.direction_for(name))
        v = pts @ basis.T
        centre, scale = R.fit_scale(v, 400, 300)
        scr = R.project(pts, basis, centre, scale, 400, 300)
        assert scr[:, 0].min() > 0 and scr[:, 0].max() < 400, name
        assert scr[:, 1].min() > 0 and scr[:, 1].max() < 300, name


def test_focus_frames_the_size_it_was_asked_for():
    """A window `size` mm across on the shorter side, so a 1.5mm thread on a
    200mm part is actually visible."""
    big = box_mesh(200, 200, 200)
    wide = R.render([big], 200, 200, view="front")
    close = R.render([big], 200, 200, view="front", focus={"at": [0, 0, 0], "size": 20})
    assert painted(wide) < 200 * 200, "the fitted view should leave a margin"
    assert painted(close) == 200 * 200, "a 20mm window on a 200mm box must fill the frame"


# --- the raster ---------------------------------------------------------------


def test_nothing_in_gives_a_clean_background():
    img = R.render([], 40, 30)
    assert painted(img) == 0
    assert img.shape == (30, 40, 3)


def test_a_box_covers_the_expected_share_of_a_front_view():
    """A cube seen square on fills the fitted frame edge to edge in one axis.
    The margin is 6% each side, so the painted width is 88% of the image."""
    img = R.render([box_mesh(20, 20, 20)], 200, 200, view="front")
    row = img[100]
    lit = np.where(np.abs(row.astype(int) - BG).sum(axis=1) > 12)[0]
    assert len(lit) >= 170, f"painted {len(lit)} of 200 px across the middle"


def test_the_nearer_surface_wins():
    """Two boxes, one behind the other, with the FAR one drawn second. Without a
    depth test the far one paints over the near one and the colours swap."""
    near = box_mesh(20, 20, 20, cy=-40, ident="b1")
    far = box_mesh(20, 20, 20, cy=40, ident="b2")
    img = R.render([near, far], 200, 200, view="front")
    mid = img[100, 100]
    # BODY_COLORS[0] is the bluish one: blue channel above red
    assert int(mid[2]) > int(mid[0]), f"the far body painted over the near one: {mid}"


def test_the_control_for_the_depth_test():
    """Swap which body is nearer and the answer must swap too, or the test above
    is passing on the draw order rather than on the depth."""
    far = box_mesh(20, 20, 20, cy=40, ident="b1")
    near = box_mesh(20, 20, 20, cy=-40, ident="b2")
    img = R.render([far, near], 200, 200, view="front")
    mid = img[100, 100]
    assert int(mid[0]) > int(mid[2]), f"the near body (reddish) did not win: {mid}"


def test_a_highlighted_face_is_painted_and_only_that_face():
    box = box_mesh(20, 20, 20)
    plain = R.render([box], 200, 200, view="front")
    lit = R.render([box], 200, 200, view="front", highlight={"b1": {2}})

    def orange(img):
        r, g, b = img[:, :, 0].astype(int), img[:, :, 1].astype(int), img[:, :, 2].astype(int)
        return int(((r > 120) & (r > b + 40) & (g < r)).sum())

    assert orange(plain) == 0, "nothing should be orange without a highlight"
    assert orange(lit) > 1000, f"the highlighted face painted {orange(lit)} pixels"
    assert orange(R.render([box], 200, 200, view="front", highlight={"b1": {5}})) == 0, \
        "a face pointing away from the camera must not show through the body"


def test_the_inside_of_a_surface_is_drawn_darker():
    """What makes a cutaway readable. With both sides shaded alike a bore and a
    boss look identical, which is the one thing a section is for."""
    n_out = np.array([0.0, 0.0, 1.0])
    n_in = np.array([0.0, 0.0, -1.0])
    base = (200, 200, 200)
    assert sum(R.shade(base, n_in)) < sum(R.shade(base, n_out)) * 0.8


# --- sections -----------------------------------------------------------------


def test_a_section_removes_the_half_it_was_told_to():
    box = box_mesh(20, 20, 20)
    whole = R.render([box], 200, 200, view="front")
    cut = R.render([box], 200, 200, view="front", section={"axis": "Z", "keep": "below"})
    # A front view of a box cut on Z shows half the height, and the fit then
    # scales that half back up — so the test is on the SHAPE, not the area.
    assert painted(whole) > 0 and painted(cut) > 0
    rows_whole = int((np.abs(whole.astype(int) - BG).sum(axis=2) > 12).any(axis=1).sum())
    rows_cut = int((np.abs(cut.astype(int) - BG).sum(axis=2) > 12).any(axis=1).sum())
    cols_cut = int((np.abs(cut.astype(int) - BG).sum(axis=2) > 12).any(axis=0).sum())
    assert rows_whole > rows_cut * 1.4, (rows_whole, rows_cut)
    assert cols_cut > rows_cut * 1.5, "the remaining half should be wider than it is tall"


def test_a_section_that_misses_the_model_removes_nothing():
    """The control. `at` far outside the model must leave the render untouched,
    or the test above could be passing on any change at all."""
    box = box_mesh(20, 20, 20)
    whole = R.render([box], 200, 200, view="front")
    missed = R.render([box], 200, 200, view="front",
                      section={"axis": "Z", "at": 500, "keep": "below"})
    assert np.array_equal(whole, missed)


def test_the_default_cut_is_through_the_middle_wherever_the_part_sits():
    box = box_mesh(20, 20, 20, cz=137)
    plane = R.section_plane({"axis": "Z"}, R.model_bounds([box]))
    assert plane is not None
    normal, offset = plane
    assert np.allclose(normal, [0, 0, 1]) and abs(offset - 137) < 1e-9, plane


def test_the_two_sides_of_a_cut_are_different_pictures():
    """The half that survives has to depend on which half was asked for.

    The vocabulary was "above"/"over"/"+" against everything else, so `max` —
    the word `at`, `min` and `max` elsewhere in this module invite — silently
    meant `below`. Both sides rendered byte-identical images and the reply said
    "keeping max" over a picture of the other half. Asserting on the PAIR is
    what catches that; a test of one side alone passes either way.
    """
    box = box_mesh(20, 20, 20)
    shots = {}
    for word in ("below", "min", "near", "-", "above", "max", "far", "+"):
        shots[word] = R.render([box], 160, 160, view="front",
                               section={"axis": "Y", "at": 0, "keep": word})
    low = [shots[w] for w in ("below", "min", "near", "-")]
    high = [shots[w] for w in ("above", "max", "far", "+")]
    for group, name in ((low, "low"), (high, "high")):
        for other in group[1:]:
            assert np.array_equal(group[0], other), f"{name} synonyms disagree"
    assert not np.array_equal(low[0], high[0]), "both sides drew the same half"
    print("the two sides of a cut are different pictures OK")


def test_a_keep_word_that_is_not_a_side_is_refused():
    """Guessing is what made the bug above invisible: the picture was wrong and
    nothing said so. A word this does not know has no safe reading, so it has to
    stop rather than pick one."""
    box = box_mesh(20, 20, 20)
    try:
        R.render([box], 80, 80, view="front", section={"axis": "Y", "keep": "middle"})
    except ValueError as ex:
        assert "middle" in str(ex) and "max" in str(ex), str(ex)
        print("an unknown keep word is refused OK:", ex)
        return
    raise AssertionError("keep='middle' was accepted and quietly given a meaning")


def test_clipping_a_triangle_keeps_the_right_area():
    a, b, c = np.array([0.0, 0, 0]), np.array([10.0, 0, 0]), np.array([0.0, 10, 0])
    n, d = np.array([1.0, 0, 0]), 5.0
    parts = R.clip_triangle(a, b, c, n, d)
    area = sum(0.5 * np.linalg.norm(np.cross(p1 - p0, p2 - p0)) for p0, p1, p2 in parts)
    # the kept region is the triangle minus the corner beyond x = 5
    assert abs(area - (50 - 12.5)) < 1e-9, area
    assert R.clip_triangle(a, b, c, n, -1.0) == [], "nothing should survive a plane before it"
    assert len(R.clip_triangle(a, b, c, n, 50.0)) == 1, "everything should survive a plane past it"


def test_clipping_a_segment():
    a, b = np.array([0.0, 0, 0]), np.array([10.0, 0, 0])
    kept = R.clip_segment(a, b, np.array([1.0, 0, 0]), 4.0)
    assert kept is not None and abs(kept[1][0] - 4.0) < 1e-9
    assert R.clip_segment(a, b, np.array([1.0, 0, 0]), -1.0) is None


# --- input shapes -------------------------------------------------------------


def test_a_polyline_is_read_flat_nested_or_wrapped():
    flat = R.polyline_points([0, 0, 0, 1, 1, 1])
    nested = R.polyline_points([[0, 0, 0], [1, 1, 1]])
    wrapped = R.polyline_points({"points": [0, 0, 0, 1, 1, 1], "body": "b1"})
    assert np.array_equal(flat, nested) and np.array_equal(flat, wrapped)
    assert R.polyline_points(None).shape == (0, 3)
    assert R.polyline_points([1, 2]).shape == (0, 3)


def test_only_the_named_bodies_are_drawn():
    a = box_mesh(20, 20, 20, cx=-30, ident="b1")
    b = box_mesh(20, 20, 20, cx=30, ident="b2")
    def reddish(img):
        r, bl = img[:, :, 0].astype(int), img[:, :, 2].astype(int)
        return int(((r > bl + 15) & (r > 60)).sum())

    both = R.render([a, b], 200, 200, view="front")
    one = R.render([a, b], 200, 200, view="front", bodies=["b1"])
    # BODY_COLORS[1] is the reddish one, and b2 is the only body wearing it
    assert reddish(both) > 1000, "the second body should be visible when both are drawn"
    assert reddish(one) == 0, "the filtered-out body was drawn anyway"
    assert painted(one) > 1000, "the kept body was not drawn"
    mid = one[100, 100]
    assert int(mid[2]) > int(mid[0]), "the kept body should keep its own colour"


if __name__ == "__main__":
    _run.run(globals(), "render")
