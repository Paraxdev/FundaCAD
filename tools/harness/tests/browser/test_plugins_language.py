"""The Plugins pane of Preferences with Deutsch, then Japanese picked from the Appearance tab: the section titles, the
offered plugins' Install button and the consent lists read in the language, and the pane keeps its
controls reachable. The pane is found by tab id and its parts by data attributes, so no selector reads text."""

import json
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import BASE, CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import PREFS_DIALOG, close_settings, open_settings, out_dir, pick, settled, settings_tab

pytestmark = [pytest.mark.browser]

LANGUAGES = {"de": "Deutsch (maschinell übersetzt)", "ja": "日本語 (機械翻訳)"}
SIZES = [(800, 600), (1280, 800)]
PANE = f'{PREFS_DIALOG} [data-pane="plugins"]'
LOCALES = Path(__file__).resolve().parents[4] / "src" / "i18n" / "locales"

EXPECTED = {
    "de": {
        "lines": ["Installierte Plug-ins", "Plug-in hinzufügen", "Von FundaCAD erstellt"],
        "install": "Installieren",
        "consent": ["Es kann nicht"],
    },
    "ja": {
        "lines": ["インストール済みのプラグイン", "プラグインを追加"],
        "install": "インストール",
        "consent": ["次のことはできません", "次のことができます"],
    },
}

READ = """(root) => {
  const pane = document.querySelector(root);
  if (!pane) return null;
  const shown = (e) => e.getClientRects().length > 0;
  const lines = new Set();
  for (const el of pane.querySelectorAll('*')) {
    if (!shown(el)) continue;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) lines.add(n.textContent.trim());
    for (const a of ['aria-label', 'title', 'placeholder']) {
      if (el.getAttribute(a)) lines.add(el.getAttribute(a).trim());
    }
  }
  return { lang: document.documentElement.lang, lines: [...lines] };
}"""


def english_lines(lang: str) -> set[str]:
    """The English text of each plain Plugins line the language translated, so a line still showing it was missed."""
    en = json.loads((LOCALES / "en.json").read_text(encoding="utf8"))
    tr = json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf8"))
    own = {k: v for k, v in en.items() if k.startswith("plugins.") and "{" not in v}
    return {v for k, v in own.items() if tr.get(k) != v} - set(tr.values())


def inside(root: str, selectors: str) -> str:
    return ", ".join(f"{root} {c.strip()}" for c in selectors.split(","))


def read(s: Session) -> dict:
    s.page.locator(f'{PREFS_DIALOG} [role=tab][data-tab="plugins"][aria-selected=true]').wait_for()
    settled(s)
    return s.page.evaluate(READ, PANE)


@pytest.fixture(scope="module")
def seen():
    out: dict = {}
    for size in SIZES:
        s = Session(viewport=size)
        out[size] = {}
        try:
            open_settings(s, "Appearance")
            for lang, name in LANGUAGES.items():
                settings_tab(s, "appearance").click()
                pick(s, "#prefs-language", name)
                settled(s)
                settings_tab(s, "plugins").click()
                got = read(s)
                offer = s.page.locator(f"{PANE} [data-plugin] .btn-primary").first
                got["install"] = offer.text_content().strip()
                offer.click()
                settled(s)
                got["consent"] = s.page.locator(f"{PANE} .plug-consent .plug-listhead").all_text_contents()
                got["after"] = s.page.evaluate(READ, PANE)
                got["cut"] = cut_labels(s.page, inside(PANE, BASE)) + clipped_controls(
                    s.page, controls=inside(PANE, CONTROLS)
                )
                s.page.locator(PREFS_DIALOG).screenshot(
                    path=str(out_dir() / f"plugins_{lang}_{size[0]}x{size[1]}.png")
                )
                out[size][lang] = got
            close_settings(s)
        finally:
            s.close()
    return out


@pytest.mark.parametrize("lang", list(LANGUAGES))
@pytest.mark.parametrize("size", SIZES)
def test_plugins_pane_reads_the_language(seen, size, lang):
    got, want = seen[size][lang], EXPECTED[lang]
    assert got["lang"] == lang, got
    for line in want["lines"]:
        assert line in got["lines"], (line, got["lines"])
    assert got["install"] == want["install"], got
    for head in want["consent"]:
        assert any(head in h for h in got["consent"]), (head, got["consent"])


@pytest.mark.parametrize("lang", list(LANGUAGES))
@pytest.mark.parametrize("size", SIZES)
def test_plugins_pane_leaves_no_english_line(seen, size, lang):
    english = english_lines(lang)
    got = seen[size][lang]
    assert sorted(english & (set(got["lines"]) | set(got["after"]["lines"]))) == [], got["after"]["lines"]


@pytest.mark.parametrize("lang", list(LANGUAGES))
@pytest.mark.parametrize("size", SIZES)
def test_plugins_pane_cuts_nothing(seen, size, lang):
    assert seen[size][lang]["cut"] == [], seen[size][lang]["cut"]
