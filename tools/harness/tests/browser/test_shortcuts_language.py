"""The Keyboard Shortcuts window in German and Pseudo at 1024x600, Comfortable text: every page, and a conflict line
open, cut nothing and leave nothing outside the window."""

import pytest

from test_plugin_panels_rest_a11y import FAKE_NATIVE, plugin_settings

from fundacad_harness import Session
from fundacad_harness.layout import clipped_controls, cut_labels
from fundacad_harness.screens import close_settings, open_settings, pick, settled

pytestmark = [pytest.mark.browser]

# A fixed width, no wrap button inside the dialog, as a language longer than German could make.
OFFSET = "tools/harness/fixtures/offset_box.json"
LANGS = ("Deutsch (maschinell übersetzt)", "Pseudo")

BAIT = """() => {
  const b = document.createElement('button');
  b.className = 'btn';
  b.id = 'sc-bait';
  b.style.cssText = 'width:40px;overflow:hidden;white-space:nowrap';
  b.textContent = 'A label far too long';
  document.querySelector('.shortcuts-panel .prefs-panes').append(b);
}"""

GROUPS = """() => ({
  dialog: !!document.querySelector('.shortcuts-panel'),
  cards: document.querySelectorAll('.shortcuts-panel .pref-card').length,
  rows: document.querySelectorAll('.shortcuts-panel .sc-row').length,
  title: document.querySelector('.shortcuts-panel .modal-title, .shortcuts-panel h2')?.textContent ?? '',
})"""


def frames(s):
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def read(s) -> dict:
    frames(s)
    found = s.page.evaluate(GROUPS)
    found["cut"] = cut_labels(s.page) + clipped_controls(s.page)
    return found


def open_window(s):
    s.menu("Help/Keyboard Shortcuts")
    s.page.locator(".shortcuts-panel").wait_for()
    settled(s)


def close_window(s):
    # Escape closes the open conflict line first, then the window.
    for _ in range(2):
        s.page.keyboard.press("Escape")
        s.page.wait_for_timeout(200)
    s.page.locator(".shortcuts-panel").wait_for(state="hidden")
    settled(s)


def walk(language: str) -> dict:
    s = Session(viewport=(1024, 600))
    try:
        s.open_file(OFFSET)
        s.settle()
        s.page.evaluate(FAKE_NATIVE)
        sel = plugin_settings("FundaCAD.Navigation")[0](s)
        radial = s.page.get_by_role("checkbox", name="Radial menu", exact=True)
        if not radial.is_checked():
            radial.click()
        s.page.locator(f"{sel} [data-nav-key]").first.wait_for()
        close_settings(s)
        open_settings(s, "Accessibility")
        s.page.locator("#prefs-comfortable-text").click()
        s.page.get_by_role("tab", name="Appearance", exact=True).click()
        pick(s, "#prefs-language", language)
        settled(s)
        close_settings(s)
        found = {"lang": s.page.evaluate("() => document.documentElement.lang")}
        open_window(s)
        found["pages"] = {}
        ids = s.page.evaluate("() => [...document.querySelectorAll('.shortcuts-panel [data-category]')].map((e) => e.dataset.category)")
        for pid in ids:
            s.page.locator(f".shortcuts-panel [data-category='{pid}']").click()
            frames(s)
            found["pages"][pid] = read(s)
        s.page.locator(f".shortcuts-panel [data-category='{ids[0]}']").click()
        found["search"] = s.page.evaluate(
            "() => document.querySelector('.shortcuts-panel [data-shortcut-search]') !== null"
        )
        s.page.locator(".shortcuts-panel .sc-key").first.click()
        s.page.locator(".key-capture-pad").wait_for()
        s.page.keyboard.press("e")
        s.page.locator(".shortcuts-panel .sc-problem").wait_for()
        found["conflict"] = read(s)
        found["conflict_text"] = s.page.locator(".shortcuts-panel .sc-problem").first.inner_text()
        s.page.evaluate(BAIT)
        found["bait"] = read(s)
        s.page.evaluate("() => document.getElementById('sc-bait').remove()")
        close_window(s)
        return found
    finally:
        s.close()


@pytest.fixture(scope="module")
def walks():
    return {lang: walk(lang) for lang in LANGS}


@pytest.mark.parametrize("language", LANGS)
def test_no_page_of_the_window_cuts_anything(walks, language):
    w = walks[language]
    assert len(w["pages"]) >= 2, list(w["pages"])
    for pid, r in w["pages"].items():
        assert r["dialog"] and r["cards"] > 0 and r["rows"] > 0, (language, pid, r)
        assert r["cut"] == [], (language, pid)


@pytest.mark.parametrize("language", LANGS)
def test_a_conflict_line_cuts_nothing(walks, language):
    w = walks[language]
    assert w["conflict_text"].strip(), w
    assert w["conflict"]["cut"] == [], (language, w["conflict"]["cut"])


def test_the_pages_are_read_in_the_picked_language(walks):
    assert walks[LANGS[0]]["lang"] == "de"
    assert walks[LANGS[1]]["lang"] == "en-XA"
    assert walks[LANGS[0]]["pages"].keys() == walks[LANGS[1]]["pages"].keys()
    assert walks[LANGS[0]]["conflict_text"] != walks[LANGS[1]]["conflict_text"]


@pytest.mark.parametrize("language", LANGS)
def test_the_detector_finds_a_control_that_cuts_its_label(walks, language):
    assert any("A label far too long" in b for b in walks[language]["bait"]["cut"]), walks[language]["bait"]
