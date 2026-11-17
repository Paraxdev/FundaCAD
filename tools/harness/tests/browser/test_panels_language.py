"""The Properties, Overhang and Interference panels in German and Japanese on two boxes: each reads in the language,
its rows and title too, and no label or control in it is cut or pushed out of the window by the longer lines."""

import pytest

from fundacad_harness.layout import CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import out_dir, settled

pytestmark = [pytest.mark.browser]

FIXTURE = "tools/harness/fixtures/two_boxes.json"
LANGS = ["de", "ja"]
WORDS = {
    "de": {
        "properties": "Eigenschaften",
        "infill": "Füllung",
        "volume": "Volumen",
        "box": "Begrenzungsquader",
        "overhang": "Überhanganalyse",
        "legend": [
            "Überhang, braucht Stützstruktur",
            "Wand oder steile Unterseite, druckt ohne Stützen",
            "Zeigt nach oben",
        ],
        "clashes": "Kollisionen",
        "interference": "Kollision",
    },
    "ja": {
        "properties": "のプロパティ",
        "infill": "インフィル",
        "volume": "体積",
        "box": "バウンディングボックス",
        "overhang": "オーバーハング解析",
        "legend": ["オーバーハング、サポートが必要", "壁または急な下面、そのまま印刷できます", "上向き"],
        "clashes": "干渉",
        "interference": "干渉",
    },
}

READ = """(panel) => {
  const root = document.querySelector(panel);
  const text = (e) => e?.textContent.replace(/\\s+/g, ' ').trim() ?? null;
  return {
    title: text(root.querySelector('.ui-panel-title')),
    keys: [...root.querySelectorAll('.measure-k')].map(text),
    legend: [...root.querySelectorAll('.overhang-legend')].map(text),
    lists: [...root.querySelectorAll('.clash-list')].map((e) => e.getAttribute('aria-label')),
  };
}"""


def act(s, action: str) -> None:
    s.page.evaluate("(a) => window.__fundacad.handleAction(a)", action)


def read(s, panel: str) -> dict:
    s.page.locator(panel).wait_for()
    settled(s)
    found = s.page.evaluate(READ, panel)
    inside = ", ".join(f"{panel} {c.strip()}" for c in CONTROLS.split(", "))
    found["layout"] = cut_labels(s.page, panel) + clipped_controls(s.page, controls=inside)
    return found


@pytest.fixture(scope="module")
def seen(session):
    s = session
    s.open_file(FIXTURE)
    s.view("fit")
    s.settle()
    found = {}
    for lang in LANGS:
        s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
        settled(s)
        act(s, "properties")
        found[(lang, "properties")] = read(s, ".properties-panel")
        s.screenshot(out_dir() / f"panels_properties_{lang}.png")
        s.press("Escape")
        s.page.locator(".properties-panel").wait_for(state="detached")
        act(s, "draft-analysis")
        found[(lang, "overhang")] = read(s, ".overhang-panel")
        act(s, "draft-analysis")
        s.page.locator(".overhang-panel").wait_for(state="detached")
        act(s, "interference")
        # An empty list has no size, so it is only ever attached.
        s.page.locator(".clash-list").first.wait_for(state="attached")
        found[(lang, "interference")] = read(s, ".measure-panel:has(.clash-list)")
        s.press("Escape")
        s.page.locator(".clash-list").first.wait_for(state="detached")
    return found


@pytest.mark.parametrize("lang", LANGS)
def test_properties_reads_in_the_language(seen, lang):
    got = seen[(lang, "properties")]
    assert WORDS[lang]["properties"] in got["title"], got
    assert WORDS[lang]["infill"] in got["keys"], got
    assert WORDS[lang]["volume"] in got["keys"] and WORDS[lang]["box"] in got["keys"], got


@pytest.mark.parametrize("lang", LANGS)
def test_overhang_reads_in_the_language(seen, lang):
    got = seen[(lang, "overhang")]
    assert [got["title"], got["legend"]] == [WORDS[lang]["overhang"], WORDS[lang]["legend"]], got


@pytest.mark.parametrize("lang", LANGS)
def test_interference_names_its_list_in_the_language(seen, lang):
    got = seen[(lang, "interference")]
    assert got["lists"][0] == WORDS[lang]["clashes"], got
    assert WORDS[lang]["interference"] in got["title"], got


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("panel", ["properties", "overhang", "interference"])
def test_nothing_in_the_panel_is_cut(seen, lang, panel):
    assert seen[(lang, panel)]["layout"] == [], seen[(lang, panel)]
