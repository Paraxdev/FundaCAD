import re

import pytest
from playwright.sync_api import TimeoutError as PlaywrightTimeout

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

PLATE = "tools/harness/fixtures/plate.json"
SKETCH_EXTRUDE = "tools/harness/fixtures/whole_sketch_extrude.json"
NEAR = "tools/harness/fixtures/near_boxes.json"

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


def listen(s):
    s.page.evaluate(LISTEN)


def heard(s, want, timeout=15_000):
    try:
        s.page.wait_for_function(
            "want => window.__spoken.some((t) => t.includes(want))", arg=want, timeout=timeout
        )
    except PlaywrightTimeout:
        pass
    spoken = s.page.evaluate("() => window.__spoken")
    assert any(want in t for t in spoken), f"never said {want!r}, said {spoken}"
    return spoken


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    yield session


def test_the_announcer_sits_outside_the_app_with_a_polite_and_an_assertive_region(s):
    where = s.page.evaluate(
        """() => {
          const root = document.getElementById("a11y-announcer");
          const app = document.getElementById("app");
          return {
            count: document.querySelectorAll("#a11y-announcer").length,
            underBody: root?.parentElement === document.body,
            insideApp: !!app && app.contains(root),
            polite: document.getElementById("a11y-polite")?.getAttribute("aria-live"),
            assertive: document.getElementById("a11y-assertive")?.getAttribute("aria-live"),
          };
        }"""
    )
    assert where == {"count": 1, "underBody": True, "insideApp": False, "polite": "polite", "assertive": "assertive"}
    tree = s.page.locator("#a11y-announcer").aria_snapshot()
    assert "status" in tree and "alert" in tree, tree


def test_opening_a_file_speaks_that_it_opened_and_its_build_result(s):
    listen(s)
    s.open_file(PLATE)
    heard(s, "Opened plate")
    spoken = heard(s, "Built, 1 body")
    assert s.page.locator("#a11y-polite").text_content(), spoken
    assert s.page.locator("#a11y-assertive").text_content() == "", "a clean build interrupts nobody"


def test_picking_a_tool_speaks_its_name_and_prompt_with_commas_for_the_dots(s):
    s.open_file(PLATE)
    s.view("iso")
    s.pick_face("top")
    listen(s)
    s.tool("Press/Pull")
    spoken = heard(s, "Press/Pull, Drag or type a value")
    assert not any("·" in t for t in spoken), spoken
    s.press("Escape")


def test_a_picked_face_speaks_words_the_readout_keeps_symbols_and_escape_says_nothing_selected(s):
    s.open_file(PLATE)
    s.view("iso")
    listen(s)
    s.pick_face("top")
    # Only the engine's answer knows the face's size, the mesh does not.
    s.page.wait_for_function(
        "() => document.querySelector('[data-testid=selection-readout]')?.textContent.includes(' by ')",
        timeout=15_000,
    )
    readout = s.selection(raw=True)["readout"]
    assert re.match(r"1 face · flat · [\d.]+ by [\d.]+ mm · facing up$", readout), readout
    spoken = heard(s, "Flat face")
    lines = [t for t in spoken if "Flat face" in t]
    assert len(lines) == 1, spoken
    assert "facing up" in lines[0] and "millimetres" in lines[0], spoken
    assert not re.search(r"\bmm\b|·|⌀|²", lines[0]), spoken

    s.pick_face("front", add=True)
    spoken = heard(s, "added, 2 selected")
    assert s.selection(raw=True)["readout"] == "2 faces"

    s.press("Escape")
    heard(s, "Nothing selected")
    assert s.selection(raw=True)["readout"] == ""


def test_reopening_an_extrude_speaks_the_extrude_prompt(s):
    s.open_file(SKETCH_EXTRUDE)
    s.view("fit")
    listen(s)
    s.click("feature:e", double=True)
    spoken = heard(s, "Extrude, New body, Ctrl-click areas")
    assert not any("·" in t for t in spoken), spoken
    s.press("Escape")
    s.press("Escape")


def test_typing_in_the_palette_speaks_the_result_count_once_and_closing_drops_a_pending_one(s):
    s.open_file(SKETCH_EXTRUDE)
    listen(s)
    s.page.keyboard.press("Control+F")
    s.page.locator(".cmdk-list").wait_for()
    try:
        s.page.keyboard.type("fil", delay=60)
        heard(s, "command")
        s.page.wait_for_timeout(600)
        counts = [t for t in s.page.evaluate("() => window.__spoken") if "command" in t]
        assert len(counts) == 1 and re.fullmatch(r"\d+ commands\. Fillet\W+(Modify|MODIFY)\W+F", counts[0]), counts
        s.page.keyboard.type("l")
        s.page.keyboard.press("Escape")
        s.page.locator(".cmdk-list").wait_for(state="detached")
        s.page.wait_for_timeout(600)
        after = [t for t in s.page.evaluate("() => window.__spoken") if "command" in t]
        assert after == counts, after
    finally:
        if s.page.locator(".cmdk-list").count():
            s.page.keyboard.press("Escape")


def test_deleting_a_step_then_ctrl_z_and_ctrl_y_speak_the_step_by_name(s):
    s.open_file(NEAR)
    listen(s)
    s.click("feature:b")
    s.press("Delete")
    heard(s, "Deleted Box 2")
    assert s.page.locator(".toast", has_text="Deleted Box 2").count() == 1

    s.press("Ctrl+Z")
    heard(s, "Undid Delete Box 2")
    s.press("Ctrl+Y")
    heard(s, "Redid Delete Box 2")

    listen(s)
    s.menu("Edit/Undo")
    heard(s, "Undid Delete Box 2")


def test_ctrl_z_on_a_new_document_says_there_is_nothing_to_undo(s):
    listen(s)
    s.press("Ctrl+Z")
    heard(s, "Nothing to undo")
    s.press("Ctrl+Y")
    heard(s, "Nothing to redo")


def test_a_message_outlasts_the_normal_five_seconds_only_at_until_dismissed(s):
    set_time = """async (time) => {
      const prefs = await import("/src/ui/a11yPrefs.ts");
      prefs.setA11yPref("noticeTime", time);
    }"""
    say = """async (text) => {
      const m = await import("/src/ui/toast.ts");
      m.toast(text);
    }"""
    row = lambda text: s.page.locator(".toast", has_text=text)
    s.page.evaluate(set_time, "until-dismissed")
    try:
        s.page.evaluate(say, "Stays until dismissed")
        row("Stays until dismissed").wait_for()
        s.page.wait_for_timeout(7_000)
        assert row("Stays until dismissed").count() == 1
    finally:
        s.page.evaluate(set_time, "normal")
    s.page.evaluate(say, "Gone after five seconds")
    row("Gone after five seconds").wait_for()
    row("Gone after five seconds").wait_for(state="detached", timeout=9_000)
    s.page.locator(".toast", has_text="Stays until dismissed").get_by_role("button", name="Dismiss").click()
