"""The Language card under Deutsch says only some parts are translated and links the manual's list, under English it
says nothing about it. Shots of the card in both languages and both themes."""

import pytest

from fundacad_harness import Session
from fundacad_harness.screens import THEMES, close_settings, open_settings, out_dir, pick, settled

pytestmark = [pytest.mark.browser]

CARD = ".pref-card:has(#prefs-language)"
GERMAN = "Deutsch (maschinell übersetzt)"

READ = """() => {
  const p = document.querySelector('.prefs-language-parts');
  const link = p?.querySelector('.prefs-language-parts-link');
  const card = document.querySelector('.pref-card:has(#prefs-language)');
  const r = link?.getBoundingClientRect();
  return {
    line: p ? p.textContent.replace(link?.textContent ?? '', '').trim() : null,
    link: link?.textContent.trim() ?? null,
    visible: !!r && r.width > 0 && r.right <= card.getBoundingClientRect().right,
    lang: document.documentElement.lang,
  };
}"""


@pytest.fixture(scope="module")
def card():
    s = Session()
    try:
        open_settings(s, "Appearance")
        seen = {}
        for theme in ("light", "dark"):
            pick(s, "#prefs-theme", THEMES[theme])
            settled(s)
            for name, language in (("en", "English"), ("de", GERMAN)):
                pick(s, "#prefs-language", language)
                settled(s)
                seen[theme, name] = s.page.evaluate(READ)
                s.page.locator(CARD).screenshot(path=str(out_dir() / f"language_card_{name}_{theme}.png"))
        pick(s, "#prefs-language", GERMAN)
        settled(s)
        s.page.evaluate("() => { window.__opened = []; window.open = (u) => window.__opened.push(u); }")
        s.page.locator(".prefs-language-parts-link").click()
        seen["opened"] = s.page.evaluate("() => window.__opened")
        close_settings(s)
        yield seen
    finally:
        s.close()


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_german_says_only_some_parts_are_translated(card, theme):
    found = card[theme, "de"]
    assert found["lang"] == "de", found
    assert found["line"] == "Bisher ist nur ein Teil übersetzt.", found
    assert found["link"] == "Im Handbuch nachlesen, welche", found
    assert found["visible"], found


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_english_says_nothing_about_it(card, theme):
    found = card[theme, "en"]
    assert found["lang"] == "en", found
    assert found["line"] is None and found["link"] is None, found


def test_the_link_opens_the_manuals_language_section(card):
    assert len(card["opened"]) == 1, card["opened"]
    assert card["opened"][0].endswith("/reference/preferences/#language"), card["opened"]
