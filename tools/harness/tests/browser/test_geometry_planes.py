"""The Planes list works by keys alone: Enter starts a sketch on an origin plane or a datum off the origin, a waiting
plane pick takes the row, and Space selects the same rows Items does."""

import pytest
from playwright.sync_api import expect

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

PLATE = "tools/harness/fixtures/plate.json"

LID = """() => window.store.addFeature({ id: "dp9", type: "datumPlane", name: "Lid",
  plane: { origin: [113.5, -41.25, 37], normal: [0, 0.6, 0.8], xdir: [1, 0, 0] } })"""

SKETCH = """() => {
  const k = window.sketch;
  const round = (v) => v.toArray().map((x) => Math.round(x * 1000) / 1000 + 0);
  return k.active ? { origin: round(k.plane.origin), normal: round(k.plane.n), datum: k.planeId } : null;
}"""


def open_sketch(s):
    return s.page.evaluate(SKETCH)


def row(s, name):
    return s.page.get_by_role("option", name=name)


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(PLATE)
    session.page.evaluate(LID)
    session.settle()
    session.page.get_by_role("tab", name="Geometry").click()
    session.page.get_by_role("radio", name="Planes").click()
    session.page.get_by_role("option").first.focus()
    yield session
    session.page.evaluate("() => document.activeElement?.blur()")
    session.page.keyboard.press("Escape")
    session.page.keyboard.press("Escape")
    session.page.get_by_role("radio", name="Faces").click()
    session.page.get_by_role("tab", name="Items", exact=True).click()


def test_enter_starts_a_sketch_on_an_origin_plane_and_a_second_enter_keeps_it(s):
    s.page.keyboard.press("Enter")
    xy = {"origin": [0, 0, 0], "normal": [0, 0, 1], "datum": None}
    assert open_sketch(s) == xy
    s.page.keyboard.press("ArrowDown")
    s.page.keyboard.press("Enter")
    assert open_sketch(s) == xy


def test_enter_starts_a_sketch_on_a_slanted_datum_off_the_origin_linked_to_it(s):
    for _ in range(3):
        s.page.keyboard.press("ArrowDown")
    s.page.keyboard.press("Enter")
    assert open_sketch(s) == {"origin": [113.5, -41.25, 37], "normal": [0, 0.6, 0.8], "datum": "dp9"}


def test_a_waiting_plane_pick_takes_the_row(s):
    s.tool("Sketch")
    row(s, "YZ plane").focus()
    assert open_sketch(s) is None
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => window.sketch.active")
    assert open_sketch(s) == {"origin": [0, 0, 0], "normal": [1, 0, 0], "datum": None}


def test_space_selects_the_rows_items_shows_and_escape_clears_them(s):
    s.page.keyboard.press(" ")
    s.page.keyboard.press("ArrowDown")
    s.page.keyboard.press("ArrowDown")
    s.page.keyboard.press("ArrowDown")
    s.page.keyboard.press(" ")
    assert open_sketch(s) is None
    expect(row(s, "XY plane")).to_have_attribute("aria-selected", "true")
    expect(row(s, "Lid")).to_have_attribute("aria-selected", "true")
    s.page.get_by_role("tab", name="Items", exact=True).click()
    tree = s.page.locator("#browser [role=tree]")
    expect(tree.get_by_role("treeitem", name="XY plane")).to_have_attribute("aria-selected", "true")
    expect(tree.get_by_role("treeitem", name="XZ plane")).to_have_attribute("aria-selected", "false")
    expect(tree.get_by_role("treeitem", name="Lid")).to_have_attribute("aria-selected", "true")
    s.page.get_by_role("tab", name="Geometry").click()
    row(s, "Lid").focus()
    s.page.keyboard.press("Escape")
    expect(row(s, "Lid")).to_have_attribute("aria-selected", "false")
    expect(row(s, "XY plane")).to_have_attribute("aria-selected", "false")
