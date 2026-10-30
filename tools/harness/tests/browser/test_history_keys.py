"""History works by keys alone: the Rollback slider rolls the model back and names the step, Tab reaches one step,
arrows walk the steps, Enter opens a step's values, Alt and an arrow move a step, and the accessibility tree reads
each step's name, state and place."""

import pytest
from playwright.sync_api import expect

pytestmark = [pytest.mark.browser, pytest.mark.smoke, pytest.mark.a11y]

STEPS = "tools/harness/fixtures/steps.json"

FOCUS = """() => {
  const a = document.activeElement;
  return {
    role: a?.getAttribute("role") ?? "",
    name: a?.getAttribute("aria-label") ?? "",
    current: a?.getAttribute("aria-current") ?? "",
  };
}"""

TAB_STOPS = """() => [...document.querySelectorAll("#timeline [role=list] [tabindex]")]
  .filter((e) => e.tabIndex >= 0).length"""

ORDER = "() => window.store.document.features.map((f) => f.name)"

# The polite region keeps only its latest text, and a rebuild's sentence can join the move's in one.
LISTEN = """() => {
  const polite = document.getElementById("a11y-polite");
  window.__spoken = [];
  if (window.__spokenObserver) window.__spokenObserver.disconnect();
  window.__spokenObserver = new MutationObserver(() => polite.textContent && window.__spoken.push(polite.textContent));
  window.__spokenObserver.observe(polite, { childList: true, characterData: true, subtree: true });
}"""


SAID = "((want) => window.__spoken.some((t) => t.includes(want)))"


def focused(s):
    return s.page.evaluate(FOCUS)


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(STEPS)
    session.page.focus("#timeline .tl-rollback input")
    yield session
    session.page.keyboard.press("Escape")


def test_the_rollback_slider_rolls_back_by_keys_and_says_the_step_it_sits_after(s):
    rollback = s.page.locator("#timeline .tl-rollback input")
    expect(rollback).to_have_attribute("aria-valuetext", "after Ball, step 3 of 3")
    s.page.keyboard.press("ArrowLeft")
    s.page.wait_for_function("() => window.store.rollbackIndex === 2")
    expect(rollback).to_have_attribute("aria-valuetext", "after Post, step 2 of 3")
    expect(s.page.locator("#timeline")).to_match_aria_snapshot(
        '- button "Ball": Ball Sphere, step 3 of 3, rolled back'
    )

    s.page.keyboard.press("Tab")
    assert focused(s) == {"role": "button", "name": "Post", "current": "step"}
    assert s.page.evaluate(TAB_STOPS) == 1
    s.page.keyboard.press("Shift+Tab")
    s.page.keyboard.press("End")
    s.page.wait_for_function("() => window.store.rollbackIndex === 3")


def test_arrows_walk_the_steps_and_alt_left_moves_one_before_its_neighbour(s):
    s.page.keyboard.press("Tab")
    assert focused(s) == {"role": "button", "name": "Ball", "current": "step"}
    s.page.keyboard.press("Home")
    assert focused(s)["name"] == "Base"
    s.page.keyboard.press("ArrowRight")
    s.page.keyboard.press("ArrowRight")
    assert focused(s)["name"] == "Ball"

    s.page.evaluate(LISTEN)
    s.page.keyboard.press("Alt+ArrowLeft")
    s.page.wait_for_function(f"() => ({ORDER})().join() === 'Base,Ball,Post'")
    s.page.wait_for_function(f"() => {SAID}('Moved Ball before Post')")
    s.page.wait_for_function(f"() => ({FOCUS})().name === 'Ball'")
    s.page.keyboard.press("Home")
    s.page.keyboard.press("Alt+ArrowLeft")
    s.page.wait_for_function(f"() => {SAID}('Base is already the first step')")
    assert s.page.evaluate(ORDER) == ["Base", "Ball", "Post"]


def test_enter_opens_a_steps_values_and_a_typed_length_rebuilds_it(s):
    s.page.keyboard.press("Tab")
    s.page.keyboard.press("Home")
    s.page.keyboard.press("Enter")
    expect(s.page.locator("#timeline")).to_match_aria_snapshot('- button "Base": Base Box, step 1 of 3, selected')
    s.page.keyboard.press("Tab")
    length = s.page.get_by_role("textbox", name="Length", exact=True)
    expect(length).to_be_focused()
    s.page.keyboard.press("ControlOrMeta+A")
    s.page.keyboard.type("50")
    s.page.keyboard.press("Enter")
    s.page.wait_for_function("() => window.store.document.features.find((f) => f.id === 'base').length === 50")


def test_shift_f10_opens_a_steps_menu_and_escape_hands_focus_back(s):
    s.page.keyboard.press("Tab")
    s.page.keyboard.press("Shift+F10")
    menu = s.page.get_by_role("menu")
    menu.wait_for()
    expect(menu.get_by_role("menuitem", name="Rename")).to_be_visible()
    s.page.keyboard.press("Escape")
    expect(menu).to_be_hidden()
    s.page.wait_for_function(f"() => ({FOCUS})().name === 'Ball'")
