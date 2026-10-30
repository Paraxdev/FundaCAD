"""The Items tree works by keys alone: Tab reaches it, arrows walk it, Space selects, F2 renames, Shift+F10 opens the
row menu, and the accessibility tree says each row's name, level and state."""

import pytest
from playwright.sync_api import expect

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

PLATE = "tools/harness/fixtures/plate.json"

FOCUS = """() => {
  const a = document.activeElement;
  return {
    role: a?.getAttribute("role") ?? "",
    level: a?.getAttribute("aria-level") ?? "",
    name: a?.querySelector(".tree-label")?.textContent.trim() ?? "",
    selected: a?.getAttribute("aria-selected") ?? "",
  };
}"""

TAB_STOPS = """() => [...document.querySelectorAll("#browser [role=tree] [tabindex]")]
  .filter((e) => e.tabIndex >= 0).length"""

BODY = """() => ({ name: window.store.bodyName("body1"), visible: window.store.isBodyVisible("body1") })"""

MENU_FOCUS = """() => document.activeElement?.closest("[role=menu]") ? document.activeElement.textContent.trim() : null"""


def focused(s):
    return s.page.evaluate(FOCUS)


def down_to(s, name, presses=12):
    for _ in range(presses):
        if focused(s)["name"] == name:
            return
        s.page.keyboard.press("ArrowDown")
    assert focused(s)["name"] == name, focused(s)


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(PLATE)
    session.page.focus("#browser-filter")
    session.page.keyboard.press("Tab")
    yield session
    session.page.keyboard.press("Escape")


def test_tab_lands_on_one_tree_item_and_the_tree_keeps_one_tab_stop(s):
    assert focused(s)["role"] == "treeitem"
    assert focused(s)["level"] == "1"
    assert s.page.evaluate(TAB_STOPS) == 1
    snap = s.page.locator("#browser").aria_snapshot()
    assert 'tree "Items"' in snap and "[level=2]" in snap, snap


def test_arrows_space_f2_and_the_row_menu_select_rename_and_hide_a_body(s):
    down_to(s, "Box")
    s.page.keyboard.press("Space")
    assert focused(s)["selected"] == "true"
    expect(s.page.locator("#browser")).to_match_aria_snapshot('- treeitem "Box" [level=2] [selected]')

    s.page.keyboard.press("F2")
    field = s.page.locator("#browser .feature-row input")
    expect(field).to_be_focused()
    s.page.keyboard.press("ControlOrMeta+A")
    s.page.keyboard.type("Lid")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function(f"() => ({BODY})().name === 'Lid'")
    s.page.wait_for_function(f"() => ({FOCUS})().name === 'Lid'")
    s.page.wait_for_timeout(100)
    assert focused(s) == {"role": "treeitem", "level": "2", "name": "Lid", "selected": "true"}

    s.page.keyboard.press("Shift+F10")
    s.page.get_by_role("menu").wait_for()
    for _ in range(12):
        if s.page.evaluate(MENU_FOCUS) == "Hide":
            break
        s.page.keyboard.press("ArrowDown")
    assert s.page.evaluate(MENU_FOCUS) == "Hide"
    s.page.keyboard.press("Enter")
    s.page.wait_for_function(f"() => !({BODY})().visible")
    assert s.page.evaluate(BODY) == {"name": "Lid", "visible": False}
    row = s.page.locator('#browser [role=treeitem]:has(.tree-label:text-is("Lid"))')
    expect(row.locator(".tree-eye")).to_have_attribute("aria-label", "Show Lid")
    expect(row.locator(".tree-state")).to_have_text("hidden")
