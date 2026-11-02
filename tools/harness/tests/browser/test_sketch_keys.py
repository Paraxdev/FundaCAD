"""A sketch is drawn with keys alone: Items to a plane, the X and Y box for each point, @ for a relative point, Tab for
a snap, arrows for the cursor, then Extrude's Tab walk, with no pointer event reaching the page."""

import math

import pytest
from fundacad_harness import Session
from test_announcer import heard, listen

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

COUNT_POINTERS = """() => {
  window.__pointers = [];
  if (window.__pointerCounter) return;
  window.__pointerCounter = true;
  for (const t of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "click", "wheel"]) {
    window.addEventListener(t, (e) => { if (t !== "click" || e.detail > 0) window.__pointers.push(t); }, true);
  }
}"""

ENTITIES = "() => JSON.parse(JSON.stringify(window.sketch.entities))"
CONSTRAINTS = "() => JSON.parse(JSON.stringify(window.sketch.constraints))"
LABEL = "() => document.activeElement?.getAttribute('aria-label')"
POSE = "() => window.viewport.rig.poseVersion()"
SPOKEN = "() => window.__spoken"
VOLUME = "() => window.viewport.bodyProperties(null).volume"
PROFILES = "() => window.__spoken.filter((t) => t.startsWith('Profile')).length"
PLACE = """(c) => {
  const v = window.viewport;
  const V = v.camera.position.constructor;
  v.rig.setLookAt(new V(c[0], c[1], c[2]), new V(c[3], c[4], c[5]), false);
}"""


def to_items_plane(s, name="XY plane"):
    """F6 to the Items panel, then to the plane's row by arrows, and Enter."""
    kb = s.page.keyboard
    for _ in range(8):
        kb.press("F6")
        if s.page.evaluate("() => !!document.activeElement?.closest('#browser')"):
            break
    for _ in range(4):
        if s.page.evaluate("() => document.activeElement?.getAttribute('role') === 'treeitem'"):
            break
        kb.press("Tab")
    kb.press("Home")
    for _ in range(6):
        if s.page.evaluate(LABEL) == name:
            break
        kb.press("ArrowDown")
    assert s.page.evaluate(LABEL) == name
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.active", timeout=15_000)
    s.settle()


def in_field(s, label):
    s.page.wait_for_function("l => document.activeElement?.getAttribute('aria-label') === l", arg=label, timeout=10_000)


def tool(s, key, name):
    s.page.keyboard.press(key)
    s.page.wait_for_function("n => window.sketch.tool === n", arg=name, timeout=10_000)


def point(s, x, y):
    kb = s.page.keyboard
    kb.type(str(x))
    kb.press("Tab")
    kb.type(str(y))
    kb.press("Enter")


def spoke(s, want):
    return heard(s, want)


def walk_to(s, want, limit=6):
    """Tab through Extrude's profiles until one is spoken with `want` in it."""
    for _ in range(limit):
        seen = s.page.evaluate(PROFILES)
        s.page.keyboard.press("Tab")
        s.page.wait_for_function(f"n => ({PROFILES})() > n", arg=seen, timeout=10_000)
        said = [t for t in s.page.evaluate(SPOKEN) if t.startswith("Profile")][-1]
        if want in said:
            return said
    raise AssertionError(f"no profile said {want!r}")


def tab_to_snap(s, want, limit=5):
    for _ in range(limit):
        seen = len(s.page.evaluate(SPOKEN))
        s.page.keyboard.press("Tab")
        s.page.wait_for_function("n => window.__spoken.length > n", arg=seen)
        if want in s.page.evaluate(SPOKEN)[-1]:
            return
    raise AssertionError(f"no snap said {want!r}")


def new_document_by_keys(s):
    """Ctrl+N and the unsaved changes question answered with Enter on Discard, so no pointer is used."""
    kb = s.page.keyboard
    kb.press("Control+N")
    s.page.wait_for_timeout(200)
    discard = s.page.locator("[role=dialog] button, [role=alertdialog] button").filter(has_text="Discard")
    if discard.count():
        discard.first.focus()
        kb.press("Enter")
        s.page.locator("[role=dialog], [role=alertdialog]").first.wait_for(state="detached")
    s.settle()


def shapes(s):
    return [{k: v for k, v in e.items() if k != "id"} for e in s.page.evaluate(ENTITIES)]


def no_pointer(s):
    assert s.page.evaluate("() => window.__pointers") == []


@pytest.fixture(scope="module", params=["navigator", "classic"])
def rig(request):
    session = Session()
    try:
        if request.param == "classic":
            session.page.goto(session.url + "&nav=legacy", wait_until="domcontentloaded", timeout=60_000)
            session._ensure_page()
        yield session
    finally:
        session.close()


@pytest.fixture
def s(rig):
    rig.press("Escape")
    new_document_by_keys(rig)
    listen(rig)
    rig.page.evaluate(COUNT_POINTERS)
    yield rig
    rig.page.keyboard.press("Escape")
    rig.page.keyboard.press("Escape")


def test_a_40_by_20_plate_with_a_10_mm_hole_is_drawn_and_extruded_by_keys_alone(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "r", "rectangle")
    point(s, 5, -7)
    spoke(s, "Point at 5, minus 7")
    kb.type("40")
    kb.press("Tab")
    kb.type("20")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 1")
    tool(s, "c", "circle")
    point(s, 25, 3)
    spoke(s, "Point at 25, 3")
    kb.type("10")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 2")
    assert shapes(s) == [
        {"type": "rectangle", "width": 40, "height": 20, "x": 25, "y": 3},
        {"type": "circle", "radius": 5, "x": 25, "y": 3},
    ]
    kb.press("e")
    spoke(s, "Extrude, Click a profile")
    assert "area 721.59" in walk_to(s, "1 hole")
    kb.press("Enter")
    kb.type("8")
    kb.press("Enter")
    s.settle()
    assert s.bodies(raw=True) == [
        {"id": "body1", "name": "Body1", "faces": 7, "visible": True, "material": None, "slot": None, "fault": None}
    ]
    # The mesh volume of a polygon disc, a little over the exact (800 - 25 pi) * 8 = 5771.68.
    assert s.page.evaluate(VOLUME) == pytest.approx((800 - 25 * math.pi) * 8, abs=1.5)
    spoke(s, "Built, 1 body")
    no_pointer(s)


def test_a_sketch_opened_by_keys_says_its_keys_and_takes_them_at_once(s):
    to_items_plane(s)
    spoke(s, "Enter or a digit types X and Y")
    assert s.page.evaluate("() => !!document.activeElement?.closest('[data-key-surface]')")
    s.page.keyboard.press("Enter")
    in_field(s, "X")
    no_pointer(s)


def test_a_chain_goes_on_from_a_typed_length_and_angle_and_at_in_y_keeps_x(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "l", "line")
    point(s, 5, -7)
    spoke(s, "Point at 5, minus 7")
    kb.type("40")
    kb.press("Tab")
    kb.type("30")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 1")
    kb.press("Enter")
    in_field(s, "X")
    assert len(shapes(s)) == 1
    kb.type("@5")
    kb.press("Tab")
    kb.type("@-3")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 2")
    second = shapes(s)[1]
    assert [second["x1"], second["y1"], second["x2"], second["y2"]] == pytest.approx(
        [5 + 40 * math.cos(math.pi / 6), 13, 10 + 40 * math.cos(math.pi / 6), 10], abs=1e-6
    )
    no_pointer(s)


def test_tab_to_the_origin_and_the_boxs_enter_pins_it_and_the_next_at_starts_from_there(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "r", "rectangle")
    point(s, 7, -3)
    spoke(s, "Point at 7, minus 3")
    kb.press("ArrowRight")
    tab_to_snap(s, "snapped to the origin")
    kb.press("Enter")
    # The pin is a fixed point entity beside the rectangle, as a click on the origin makes.
    s.page.wait_for_function("() => window.sketch.constraints.length > 0")
    spoke(s, "Point at 0, 0, snapped to the origin. Rectangle 1")
    drawn = shapes(s)
    assert drawn[0] == {"type": "rectangle", "width": 7, "height": 3, "x": 3.5, "y": -1.5}
    assert [e["type"] for e in drawn[1:]] == ["point"]
    kb.press("Enter")
    in_field(s, "X")
    assert shapes(s) == drawn
    kb.type("@5,3")
    kb.press("Enter")
    spoke(s, "Point at 5, 3")
    no_pointer(s)


def test_extrudes_pick_leaves_tab_enter_and_space_to_a_focused_text_field(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "r", "rectangle")
    point(s, 7, -3)
    spoke(s, "Point at 7, minus 3")
    kb.type("40")
    kb.press("Tab")
    kb.type("20")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 1")
    kb.press("e")
    spoke(s, "Extrude, Click a profile")
    walk_to(s, "Profile 1 of 1")
    profiles = s.page.evaluate(PROFILES)
    s.page.evaluate("""() => {
      const i = document.createElement("input");
      i.id = "probe";
      window.__enters = 0;
      i.addEventListener("keydown", (e) => { if (e.key === "Enter") window.__enters++; });
      document.body.append(i);
      i.focus();
    }""")
    try:
        kb.type("a b")
        kb.press("Enter")
        assert s.page.evaluate("() => [document.getElementById('probe').value, window.__enters]") == ["a b", 1]
        kb.press("Tab")
        assert s.page.evaluate("() => document.activeElement?.id") != "probe"
        assert s.page.evaluate(PROFILES) == profiles
        assert s.bodies(raw=True) == []
    finally:
        s.page.evaluate("() => document.getElementById('probe')?.remove()")
    no_pointer(s)


def test_a_refused_size_is_spoken_and_stays_on_its_field(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "r", "rectangle")
    point(s, 7, -3)
    spoke(s, "Point at 7, minus 3")
    kb.type("30")
    kb.press("Tab")
    kb.type("0")
    kb.press("Enter")
    s.page.wait_for_function("() => document.getElementById('a11y-assertive').textContent.includes('more than 0')")
    in_field(s, "H")
    assert shapes(s) == []
    no_pointer(s)


def test_a_slanted_line_chain_by_relative_points_closes_and_a_second_document_starts_clean(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "l", "line")
    point(s, 10, -5)
    for n, (dx, dy) in enumerate([(24, 3), (-6, 18), (-21, -7), (3, -14)], 1):
        kb.type(f"@{dx},{dy}")
        kb.press("Enter")
        s.page.wait_for_function("n => window.sketch.entities.length === n", arg=n)
    assert shapes(s) == [
        {"type": "line", "x1": 10, "y1": -5, "x2": 34, "y2": -2},
        {"type": "line", "x1": 34, "y1": -2, "x2": 28, "y2": 16},
        {"type": "line", "x1": 28, "y1": 16, "x2": 7, "y2": 9},
        {"type": "line", "x1": 7, "y1": 9, "x2": 10, "y2": -5},
    ]
    ids = [e["id"] for e in s.page.evaluate(ENTITIES)]
    joins = [(c["e1"], c["p1"], c["e2"], c["p2"]) for c in s.page.evaluate(CONSTRAINTS) if c["type"] == "coincident"]
    assert joins == [(ids[1], 0, ids[0], 1), (ids[2], 0, ids[1], 1), (ids[3], 0, ids[2], 1), (ids[3], 1, ids[0], 0)]
    spoke(s, "Line 4, length 14.318, loop closed")
    spoke(s, "snapped to the start of Line 1")

    kb.press("Escape")
    kb.press("Escape")
    new_document_by_keys(s)
    listen(s)
    to_items_plane(s)
    assert shapes(s) == []
    assert s.page.evaluate(CONSTRAINTS) == []
    tool(s, "l", "line")
    point(s, 4, 6)
    kb.type("@5,2")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 1")
    assert shapes(s) == [{"type": "line", "x1": 4, "y1": 6, "x2": 9, "y2": 8}]
    assert s.page.evaluate(CONSTRAINTS) == []
    spoken = spoke(s, "Line 1, length 5.385")
    assert not any("loop closed" in t or "snapped" in t for t in spoken), spoken
    no_pointer(s)


def test_tab_picks_a_midpoint_for_a_line_end_and_says_whose_it_is(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "l", "line")
    point(s, 10, -5)
    kb.type("@20,10")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 1")
    kb.press("Escape")
    point(s, 35, 20)
    for key, at in [("ArrowLeft", "30, 20"), ("ArrowLeft", "20, 20"), ("ArrowLeft", "10, 20"), ("ArrowDown", "10, 10"), ("ArrowDown", "10, 0")]:
        kb.press(key)
        spoke(s, f"Cursor at {at}")
    tab_to_snap(s, "midpoint of Line 1")
    assert s.page.evaluate(SPOKEN)[-1] == "Cursor at 20, 0, snapped to the midpoint of Line 1"
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 2")
    assert shapes(s)[1] == {"type": "line", "x1": 35, "y1": 20, "x2": 20, "y2": 0}
    spoke(s, "Point at 20, 0, snapped to the midpoint of Line 1")
    ids = [e["id"] for e in s.page.evaluate(ENTITIES)]
    assert s.page.evaluate(CONSTRAINTS) == [{"type": "midpoint", "e": ids[1], "p": 1, "line": ids[0]}]
    no_pointer(s)


def test_enter_in_the_size_box_after_arrows_says_the_end_and_its_snap(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "l", "line")
    point(s, 10, -5)
    kb.type("@20,10")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 1")
    kb.press("Escape")
    point(s, 35, 20)
    s.page.evaluate("() => document.querySelector('.dim-field[data-field=length] input').focus()")
    for key, at in [("ArrowLeft", "30, 20"), ("ArrowLeft", "20, 20"), ("ArrowLeft", "10, 20"), ("ArrowDown", "10, 10"), ("ArrowDown", "10, 0")]:
        kb.press(key)
        spoke(s, f"Cursor at {at}")
    tab_to_snap(s, "midpoint of Line 1")
    kb.press("Enter")
    s.page.wait_for_function("() => window.sketch.entities.length === 2")
    spoke(s, "Point at 20, 0, snapped to the midpoint of Line 1. Line 2, length 25")
    no_pointer(s)


def test_arrows_move_the_cursor_with_a_draw_tool_and_turn_the_view_with_select(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "r", "rectangle")
    pose = s.page.evaluate(POSE)
    kb.press("ArrowRight")
    spoke(s, "Cursor at")
    s.page.wait_for_timeout(400)
    assert s.page.evaluate(POSE) == pose

    kb.press("Escape")
    s.page.wait_for_function("() => window.sketch.tool === 'select'")
    kb.press("ArrowRight")
    s.page.wait_for_function("p => window.viewport.rig.poseVersion() !== p", arg=pose)
    no_pointer(s)


def test_arrows_turn_the_view_when_the_sketch_plane_is_edge_on(s):
    kb = s.page.keyboard
    to_items_plane(s)
    tool(s, "r", "rectangle")
    s.page.evaluate(PLACE, [300, -1500, 0, 0, 0, 0])
    s.settle()
    pose = s.page.evaluate(POSE)
    kb.press("ArrowRight")
    s.page.wait_for_function("p => window.viewport.rig.poseVersion() !== p", arg=pose)
    assert not any("Cursor at" in t for t in s.page.evaluate(SPOKEN))
    no_pointer(s)
