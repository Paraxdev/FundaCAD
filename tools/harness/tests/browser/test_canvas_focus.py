"""A pointer press on the 3D view leaves focus where it always landed, and only keys put focus on the view."""

import pytest
from playwright.sync_api import expect

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

PLATE = "tools/harness/fixtures/plate.json"

ACTIVE = """() => {
  const a = document.activeElement;
  return a === document.body ? "body" : a?.id || a?.getAttribute("role") || a?.tagName.toLowerCase();
}"""

# A corner of the view with no panel over it, away from the fitted model, so a press there selects nothing.
SKY = """() => {
  const c = document.querySelector("#canvas").getBoundingClientRect();
  for (let f = 0.97; f > 0.55; f -= 0.02) {
    const x = c.left + c.width * f, y = c.top + c.height * 0.72;
    if (document.elementFromPoint(x, y)?.id === "canvas") return { x, y };
  }
  return null;
}"""

RING = """() => {
  const s = getComputedStyle(document.querySelector("#canvas"));
  return { style: s.outlineStyle, offset: parseFloat(s.outlineOffset), width: parseFloat(s.outlineWidth) };
}"""


def active(s):
    return s.page.evaluate(ACTIVE)


def press_sky(s):
    at = s.page.evaluate(SKY)
    assert at, "no bare canvas to press"
    s.page.mouse.click(at["x"], at["y"])


def f6_to_canvas(s):
    for _ in range(8):
        s.page.keyboard.press("F6")
        if active(s) == "canvas":
            return
    raise AssertionError(f"F6 never reached the canvas, focus is on {active(s)}")


@pytest.fixture
def s(session):
    session.open_file(PLATE)
    session.settle()
    return session


def test_a_press_from_a_field_leaves_focus_on_the_body(s):
    field = s.page.locator("#browser-filter")
    field.click()
    expect(field).to_be_focused()
    press_sky(s)
    assert active(s) == "body"


def test_a_press_from_a_tree_row_leaves_focus_on_the_body(s):
    s.page.locator("#browser-filter").click()
    s.page.keyboard.press("Tab")
    assert active(s) == "treeitem"
    press_sky(s)
    assert active(s) == "body"


def test_a_press_with_focus_on_the_body_does_not_focus_the_view(s):
    press_sky(s)
    press_sky(s)
    assert active(s) == "body"


def test_keys_reach_the_view_with_a_ring_and_a_press_keeps_focus_there(s):
    f6_to_canvas(s)
    ring = s.page.evaluate(RING)
    assert ring["style"] == "solid" and ring["width"] > 0
    assert ring["offset"] == -ring["width"]
    press_sky(s)
    assert active(s) == "canvas"
