"""Next and Previous Face and Edge and Browse Faces and Edges from the command search and the Edit menu, by real keys:
each selects and speaks, a sketch or a waiting pick stays and is refused in words, and Browse lands focus on a row."""

import pytest
from playwright.sync_api import expect

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

PLATE = "tools/harness/fixtures/plate.json"

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

ROLE_IS_OPTION = "() => document.activeElement?.getAttribute('role') === 'option'"


def heard(s, want):
    s.page.wait_for_function("want => window.__spoken.some((t) => t.includes(want))", arg=want, timeout=15_000)


# The readout speaks what changed between two frames, faster commands than a person's would run together.
def next_frames(s):
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def picked(s):
    v = s.selection(raw=True)
    return {"faces": v["faces"], "edges": v["edges"]}


def row(s, name):
    return s.page.get_by_role("option", name=name)


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(PLATE)
    session.settle()
    session.page.evaluate(LISTEN)
    yield session
    session.page.evaluate("() => document.activeElement?.blur()")
    session.page.keyboard.press("Escape")
    session.page.keyboard.press("Escape")


def test_next_and_previous_face_select_the_row_and_speak_it(s):
    s.command("Next Face")
    s.page.wait_for_function("() => window.viewport.getSelectedFaceIds().length === 1")
    assert picked(s) == {"faces": [["body1", 0]], "edges": []}
    heard(s, "Flat face 1")
    next_frames(s)
    s.command("Next Face")
    assert picked(s) == {"faces": [["body1", 1]], "edges": []}
    heard(s, "Flat face 2")
    next_frames(s)
    s.command("Previous Face")
    assert picked(s) == {"faces": [["body1", 0]], "edges": []}


def test_previous_edge_selects_the_last_edge_alone_and_next_wraps_it_to_the_first(s):
    s.command("Previous Edge")
    s.page.wait_for_function("() => window.viewport.selectedEdgeLines().length === 1")
    last = s.page.evaluate("() => window.viewport.selectedEdgeLines()[0].slot")
    assert picked(s)["faces"] == []
    assert last > 0
    heard(s, f"edge {last + 1}")
    next_frames(s)
    s.command("Next Edge")
    assert s.page.evaluate("() => window.viewport.selectedEdgeLines().map((e) => e.slot)") == [0]


def test_an_open_sketch_stays_open_and_refuses_in_words(s):
    s.page.get_by_role("tab", name="Geometry").click()
    s.page.get_by_role("radio", name="Planes").click()
    row(s, "XZ plane").focus()
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => window.sketch.active")
    s.command("Next Face")
    heard(s, "Finish the sketch first")
    assert s.page.evaluate("() => window.sketch.active")
    assert picked(s) == {"faces": [], "edges": []}
    expect(s.page.get_by_role("radio", name="Planes")).to_be_checked()
    s.page.keyboard.press("Control+Z")
    s.page.keyboard.press("Escape")
    s.page.get_by_role("radio", name="Faces").click()
    s.page.get_by_role("tab", name="Items", exact=True).click()


def test_a_waiting_plane_pick_survives_a_refused_command_and_browse(s):
    s.tool("Sketch")
    s.command("Next Edge")
    heard(s, "waiting for a pick")
    s.command("Browse Faces and Edges")
    expect(s.page.get_by_role("tab", name="Geometry")).to_have_attribute("aria-selected", "true")
    s.page.get_by_role("radio", name="Planes").click()
    row(s, "YZ plane").focus()
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => window.sketch.active")
    s.page.get_by_role("radio", name="Faces").click()
    s.page.get_by_role("tab", name="Items", exact=True).click()


def test_browse_from_the_command_search_lands_on_a_row_with_the_tab_open(s):
    s.command("Browse Faces and Edges")
    s.page.wait_for_function(ROLE_IS_OPTION)
    expect(s.page.get_by_role("tab", name="Geometry")).to_have_attribute("aria-selected", "true")
    assert "Flat face 1" in s.page.evaluate("() => document.activeElement.getAttribute('aria-label')")
    s.page.keyboard.press("ArrowDown")
    assert "Flat face 2" in s.page.evaluate("() => document.activeElement.getAttribute('aria-label')")
    s.page.get_by_role("tab", name="Items", exact=True).click()


def test_browse_from_the_edit_menu_lands_on_a_row(s):
    s.page.locator("#menubar .menu-btn", has_text="Edit").click()
    s.page.get_by_role("menuitem", name="Browse Faces and Edges").focus()
    s.page.keyboard.press("Enter")
    s.page.wait_for_function(ROLE_IS_OPTION)
    s.page.get_by_role("tab", name="Items", exact=True).click()
