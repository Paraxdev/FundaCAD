"""German, then Japanese, picked in Preferences: the Parameters panel and the Export dialog read the language, found by
their classes and test ids, never by English text, and a shot of each goes to the size output folder."""

import json
from pathlib import Path

import pytest

from fundacad_harness.screens import close_settings, open_settings, out_dir, pick, settled

pytestmark = [pytest.mark.browser]

PLATE_WIDTH = "tools/harness/fixtures/plate_width.json"
LANGUAGES = {"de": "Deutsch (maschinell übersetzt)", "ja": "日本語 (機械翻訳)"}
LOCALES = Path(__file__).resolve().parents[4] / "src" / "i18n" / "locales"
SET_LANGUAGE = "async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)"

PARAMS = """() => {
  const p = document.querySelector('.params-dialog');
  const title = document.getElementById(p.getAttribute('aria-labelledby'))?.textContent.trim();
  return {
    title,
    sections: [...p.querySelectorAll('.params-section')].map((e) => e.textContent.trim()),
    hint: p.querySelector('.measure-hint').textContent.trim(),
    labels: [...p.querySelectorAll('input')].map((e) => e.getAttribute('aria-label')),
  };
}"""

EXPORT = """() => {
  const d = document.querySelector('.export-dialog');
  return {
    title: document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim(),
    confirm: d.querySelector('[data-testid=export-confirm]').textContent.trim(),
    refinement: d.querySelector('[data-testid=export-refinement] .select-value')?.textContent.trim() ?? null,
  };
}"""


def load(lang: str) -> dict[str, str]:
    return json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf8"))


@pytest.fixture
def s(session):
    session.press("Escape")
    session.new_document()
    session.open_file(PLATE_WIDTH)
    yield session
    session.press("Escape")
    session.page.evaluate(SET_LANGUAGE, "system")


@pytest.mark.parametrize("lang", ["de", "ja"])
def test_parameters_and_export_read_the_picked_language(s, lang):
    line = load(lang)
    open_settings(s, "Appearance")
    pick(s, "#prefs-language", LANGUAGES[lang])
    settled(s)
    close_settings(s)

    s.tool("Parameters")
    s.page.locator(".params-dialog").wait_for()
    params = s.page.evaluate(PARAMS)
    s.screenshot(out_dir() / f"params-{lang}.png")
    s.press("Escape")
    assert params["title"] == line["tool.parameters"], params
    assert params["sections"][0] == line["params.user"], params
    assert params["hint"] == line["params.hint"], params
    assert line["params.nameOf"].replace("{name}", "width") in params["labels"], params

    s.page.evaluate("() => window.__fundacad.handleAction('export')")
    s.page.locator(".export-dialog").wait_for()
    shown = s.page.evaluate(EXPORT)
    s.screenshot(out_dir() / f"export-{lang}.png")
    s.press("Escape")
    assert shown["title"] == line["export.title"], shown
    assert shown["confirm"] == line["export.confirm"], shown
