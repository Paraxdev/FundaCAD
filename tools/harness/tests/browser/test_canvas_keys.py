"""The keys on the focused 3D view, by real key presses: brackets step with words on the readout and in speech, Enter
and Space pick, Shift switches kind, Escape clears, and Single key shortcuts off leaves them on the view alone."""

import pytest
from playwright.sync_api import expect

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

PLATE = "tools/harness/fixtures/plate.json"

ACTIVE = """() => {
  const a = document.activeElement;
  return a === document.body ? "body" : a?.id || a?.getAttribute("role") || a?.tagName.toLowerCase();
}"""

# The polite region holds only its latest sentence, so every text it is given is kept for the test to read.
LISTEN = """() => {
  const polite = document.getElementById("a11y-polite");
  window.__spoken = [];
  if (window.__spokenObserver) window.__spokenObserver.disconnect();
  window.__spokenObserver = new MutationObserver(() => {
    const text = polite.textContent;
    if (text) window.__spoken.push(text);
  });
  window.__spokenObserver.observe(polite, { childList: true, characterData: true, subtree: true });
}"""

READOUT = "[data-testid=selection-readout]"
TILE_SHOWN = "() => window.viewport.scene.originTiles.tiles.XY.fill.visible"
SKETCH_NORMAL = """() => {
  const k = window.sketch;
  return k.active ? k.plane.n.toArray().map((x) => Math.round(x * 1000) / 1000 + 0) : null;
}"""


def heard(s, want):
    s.page.wait_for_function("want => window.__spoken.some((t) => t.includes(want))", arg=want, timeout=15_000)


# The readout speaks what changed between two frames, faster keys than a person's would run together.
def next_frames(s):
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def picked(s):
    v = s.selection(raw=True)
    return {"faces": v["faces"], "edges": v["edges"]}


def active(s):
    return s.page.evaluate(ACTIVE)


def to_canvas(s):
    for _ in range(8):
        s.page.keyboard.press("F6")
        if active(s) == "canvas":
            return
    raise AssertionError(f"F6 never reached the canvas, focus is on {active(s)}")


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(PLATE)
    session.settle()
    to_canvas(session)
    session.page.evaluate(LISTEN)
    yield session
    session.page.keyboard.press("Escape")
    session.page.keyboard.press("Escape")


def test_brackets_light_and_say_a_face_and_select_nothing(s):
    s.page.keyboard.press("]")
    expect(s.page.locator(READOUT)).to_contain_text("face")
    heard(s, "Flat face 1")
    first = s.page.locator(READOUT).inner_text()
    s.page.keyboard.press("]")
    heard(s, "Flat face 2")
    assert s.page.locator(READOUT).inner_text() != first
    s.page.keyboard.press("[")
    expect(s.page.locator(READOUT)).to_have_text(first)
    assert picked(s) == {"faces": [], "edges": []}
    assert active(s) == "canvas"


def test_enter_selects_the_lit_face_space_adds_and_focus_stays_on_the_view(s):
    s.page.keyboard.press("]")
    heard(s, "Flat face 1")
    s.page.keyboard.press("Enter")
    assert picked(s) == {"faces": [["body1", 0]], "edges": []}
    assert active(s) == "canvas"
    next_frames(s)
    s.page.keyboard.press("]")
    s.page.keyboard.press("Space")
    assert picked(s) == {"faces": [["body1", 0], ["body1", 1]], "edges": []}
    assert active(s) == "canvas"
    heard(s, "added, 2 selected")
    s.page.keyboard.press("Space")
    assert picked(s) == {"faces": [["body1", 0]], "edges": []}
    heard(s, "removed, 1 selected")
    s.page.keyboard.press("Escape")
    assert picked(s) == {"faces": [], "edges": []}
    expect(s.page.locator(READOUT)).to_have_count(0)
    heard(s, "Nothing selected")
    assert active(s) == "canvas"


def test_shift_brackets_switch_to_edges_and_planes_and_a_lit_plane_starts_a_sketch(s):
    s.page.keyboard.press("}")
    heard(s, "Edges")
    s.page.keyboard.press("]")
    expect(s.page.locator(READOUT)).to_contain_text("edge")
    s.page.keyboard.press("Enter")
    selection = picked(s)
    assert len(selection["edges"]) == 1 and selection["faces"] == []
    s.page.keyboard.press("Escape")
    s.page.keyboard.press("}")
    heard(s, "Planes")
    s.page.keyboard.press("]")
    expect(s.page.locator(READOUT)).to_contain_text("plane")
    assert s.page.evaluate(TILE_SHOWN)
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => window.sketch.active")
    assert s.page.evaluate(SKETCH_NORMAL) == [0, 0, 1]
    # In a sketch the brackets stand down, Escape leaves the sketch as it does from anywhere.
    s.page.keyboard.press("]")
    assert s.page.locator(READOUT).count() == 0
    s.page.keyboard.press("Escape")
    s.page.keyboard.press("Escape")
    s.page.wait_for_function("() => !window.sketch.active")
    s.page.keyboard.press("{")
    s.page.keyboard.press("{")
    heard(s, "Faces")


def test_a_second_document_starts_at_its_own_first_face(s):
    s.page.keyboard.press("]")
    heard(s, "Flat face 1")
    s.page.keyboard.press("]")
    heard(s, "Flat face 2")
    s.new_document()
    s.settle()
    s.open_file(PLATE)
    s.settle()
    to_canvas(s)
    s.page.evaluate(LISTEN)
    s.page.keyboard.press("]")
    heard(s, "face 1")


def test_with_single_key_shortcuts_off_the_keys_work_on_the_view_and_not_on_the_body(s):
    single_keys = s.page.locator("#prefs-single-keys")
    s.command("Accessibility Settings")
    expect(single_keys).to_be_checked()
    single_keys.click()
    s.page.keyboard.press("Escape")
    expect(single_keys).to_have_count(0)
    try:
        to_canvas(s)
        s.page.evaluate(LISTEN)
        s.page.keyboard.press("]")
        heard(s, "Flat face 1")
        s.page.keyboard.press("Enter")
        assert picked(s) == {"faces": [["body1", 0]], "edges": []}
        s.page.keyboard.press("Escape")
        s.page.evaluate("() => document.activeElement.blur()")
        assert active(s) == "body"
        s.page.keyboard.press("]")
        s.page.wait_for_timeout(300)
        assert s.page.locator(READOUT).count() == 0
    finally:
        s.command("Accessibility Settings")
        single_keys.click()
        s.page.keyboard.press("Escape")
        expect(single_keys).to_have_count(0)
