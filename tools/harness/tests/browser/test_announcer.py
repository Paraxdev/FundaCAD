import pytest
from playwright.sync_api import TimeoutError as PlaywrightTimeout

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

PLATE = "tools/harness/fixtures/plate.json"
SKETCH_EXTRUDE = "tools/harness/fixtures/whole_sketch_extrude.json"

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


def test_reopening_an_extrude_speaks_the_extrude_prompt(s):
    s.open_file(SKETCH_EXTRUDE)
    s.view("fit")
    listen(s)
    s.click("feature:e", double=True)
    spoken = heard(s, "Extrude, New body, Ctrl-click areas")
    assert not any("·" in t for t in spoken), spoken
    s.press("Escape")
    s.press("Escape")
