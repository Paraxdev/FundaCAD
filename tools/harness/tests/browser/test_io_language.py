"""German, then Japanese, picked in Preferences: the Export dialog's unit picker reads the language, found by its test
id, never by English text."""

import json
from pathlib import Path

import pytest

from fundacad_harness.screens import close_settings, open_settings, pick, settled

pytestmark = [pytest.mark.browser]

PLATE_WIDTH = "tools/harness/fixtures/plate_width.json"
LANGUAGES = {"de": "Deutsch (maschinell übersetzt)", "ja": "日本語 (機械翻訳)"}
LOCALES = Path(__file__).resolve().parents[4] / "src" / "i18n" / "locales"
SET_LANGUAGE = "async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)"
UNITS = ["mm", "cm", "m", "in", "ft"]

UNIT_SHOWN = """() => document.querySelector('.export-dialog [data-testid=export-unit] .select-value')?.textContent.trim()
  ?? null"""


def unit_names(lang: str) -> set[str]:
    line = json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf8"))
    return {line[f"export.unitName.{u}"] for u in UNITS}


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    session.open_file(PLATE_WIDTH)
    yield session
    session.press("Escape")
    session.page.evaluate(SET_LANGUAGE, "system")


@pytest.mark.parametrize("lang", ["de", "ja"])
def test_export_unit_picker_reads_the_picked_language(s, lang):
    open_settings(s, "Appearance")
    pick(s, "#prefs-language", LANGUAGES[lang])
    settled(s)
    close_settings(s)

    s.page.evaluate("() => window.__fundacad.handleAction('export')")
    s.page.locator(".export-dialog").wait_for()
    shown = s.page.evaluate(UNIT_SHOWN)
    s.press("Escape")
    assert shown in unit_names(lang), shown
    if lang == "ja":
        assert shown not in unit_names("en"), shown
