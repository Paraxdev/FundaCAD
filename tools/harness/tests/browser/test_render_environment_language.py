"""The Render dock's Environment tab with Deutsch and then Japanese picked in Preferences: the headings and the backdrop,
floor, denoise and tracer choices read the language, keep their data attributes, and no label is cut. The dock and its
tab are found by id and position, never by their text."""

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import BASE, CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import close_settings, open_settings, pick, settled

pytestmark = [pytest.mark.browser]

DOCK = "#renderdock"
PANEL = f"{DOCK} [role=tabpanel]"
ENVIRONMENT_TAB = f"{DOCK} [role=tab] >> nth=1"

EXPECTED = {
    "de": {
        "language": "Deutsch (maschinell übersetzt)",
        "heads": ["Hauptlicht", "Schatten", "Rauschunterdrückung", "Kartoffelmodus"],
        "background": ["Design", "Dunkel", "Mittelgrau", "Hell"],
        "ground": ["Keiner", "Schattenfänger"],
        "denoise": ["Aus", "Standard", "Hohe Qualität"],
        "tracer": ["Automatisch", "Nativ", "WebGPU"],
    },
    "ja": {
        "language": "日本語 (機械翻訳)",
        "heads": ["キーライト", "影", "ノイズ除去", "ポテトモード"],
        "background": ["テーマ", "ダーク", "ミディアムグレー", "ライト"],
        "ground": ["なし", "シャドウキャッチャー"],
        "denoise": ["オフ", "標準", "高品質"],
        "tracer": ["自動", "ネイティブ", "WebGPU"],
    },
}

READ = """() => {
  const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\\s+/g, " ").trim());
  return {
    lang: document.documentElement.lang,
    heads: text("#renderdock .rd-head"),
    background: text("#renderdock [role=radio][data-background]"),
    ground: text("#renderdock [role=radio][data-ground]"),
    denoise: text("#renderdock [role=radio][data-denoise]"),
    tracer: text("#renderdock [role=radio][data-tracer]"),
  };
}"""


@pytest.fixture(scope="module")
def seen():
    s = Session(viewport=(1280, 800))
    found = {}
    try:
        s.press("Escape")
        s.new_document()
        for lang, want in EXPECTED.items():
            open_settings(s, "Appearance")
            pick(s, "#prefs-language", want["language"])
            settled(s)
            close_settings(s)
            if not s.page.locator(DOCK).count():
                s.page.click('[data-workspace="render"]')
                s.page.locator(DOCK).wait_for()
            s.page.locator(ENVIRONMENT_TAB).click()
            s.page.locator(f"{DOCK} [data-denoise]").first.wait_for()
            settled(s)
            got = s.page.evaluate(READ)
            got["cut"] = cut_labels(s.page, f"{PANEL} {BASE.replace(', ', f', {PANEL} ')}") + clipped_controls(
                s.page, controls=f"{PANEL} {CONTROLS.replace(', ', f', {PANEL} ')}"
            )
            found[lang] = got
    finally:
        s.close()
    return found


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_the_environment_tab_reads_the_language(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    assert got["lang"] == lang, got
    for key in ("background", "ground", "denoise", "tracer"):
        assert got[key] == want[key], (key, got[key])
    for head in want["heads"]:
        assert head in got["heads"], (head, got["heads"])


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_the_environment_tab_cuts_nothing(seen, lang):
    assert seen[lang]["cut"] == []
