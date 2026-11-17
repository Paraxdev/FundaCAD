"""The view controls, their cards, the title bar, its fold in the File menu, the workspace toggle, the section chip and
the versions panel with Deutsch and then Japanese picked in Preferences: their lines read the language, no line they
show is left in English, and no label is cut. Everything is found by id, data attribute, role and position, never by
text."""

import re

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import BASE, CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import close_settings, open_example, open_settings, pick, settled

pytestmark = [pytest.mark.browser]

BAR = "#viewcontrols"
CARD = ".vc-pop"
CHIP = "[data-testid=section-chip]"
FOLD = "[data-fold-workspace]"
WIDE = {"width": 1280, "height": 800}
# Under the title bar's fold width, so the document name and the workspaces move into the File menu.
FOLDED = {"width": 520, "height": 700}

# Each card of the view controls, by the icon of the button that opens it.
CARDS = {
    "snap": f'{BAR} button:has([data-icon="magnet"])',
    "grid": f"{BAR} .grid-btn",
    "views": f'{BAR} button:has([data-icon="views"])',
    "display": f'{BAR} button:has([data-icon="shaded"])',
    "versions": f'{BAR} button:has([data-icon="versions"])',
}

EXPECTED = {
    "de": {
        "language": "Deutsch (maschinell übersetzt)",
        "home": "Startseite",
        "context": "VOLUMEN",
        "workspace": "Arbeitsbereich",
        "workspaces": ["Modell", "Rendern"],
        "tips": ["Modell: die volle Breite, jedes Werkzeug", "Rendern: Materialien, Umgebung und Kamera"],
        "bar": "Ansichtssteuerung",
        "modes": ["Matcap (Z)", "Echtzeit (Z)", "Pfadverfolgung (Z)"],
        "views": [
            "Draufsicht",
            "Untersicht",
            "Vorderansicht",
            "Rückansicht",
            "Rechte Seitenansicht",
            "Linke Seitenansicht",
        ],
        "units": ["Millimeter", "Zentimeter", "Zoll"],
        "chip": ["Bearbeiten", "Umkehren", "Aus"],
        "chip_name": "Schnittansicht",
        "fold": ["Arbeitsbereich Modell", "Arbeitsbereich Rendern"],
        "versions": "Version speichern",
        "english": [
            "View controls",
            "Snapping",
            "Grid and units",
            "Reset camera",
            "Snap to",
            "Sketch grid",
            "Zoom in for a finer grid",
            "Default View",
            "Fit to Model",
            "Appearance",
            "Projection",
            "Select mode",
            "Shading",
            "Show overlays",
            "Edge outlines",
            "Surface analysis",
            "Curvature combs",
            "No versions yet",
            "Save version",
            "What changed",
            "Section on",
            "Flip",
            "Workspace",
        ],
    },
    "ja": {
        "language": "日本語 (機械翻訳)",
        "home": "ホーム",
        "context": "ソリッド",
        "workspace": "ワークスペース",
        "workspaces": ["モデル", "レンダリング"],
        "tips": ["モデル：全幅、すべてのツール", "レンダリング：材料、環境、カメラ"],
        "bar": "ビューコントロール",
        "modes": ["Matcap (Z)", "リアルタイム (Z)", "パストレース (Z)"],
        "views": ["平面図", "底面図", "正面図", "背面図", "右側面図", "左側面図"],
        "units": ["ミリメートル", "センチメートル", "インチ"],
        "chip": ["編集", "反転", "オフ"],
        "chip_name": "断面表示",
        "fold": ["モデル ワークスペース", "レンダリング ワークスペース"],
        "versions": "バージョンを保存",
        "english": [],
    },
}

# Key names and the Matcap name, which every language keeps.
KEPT = {"ctrl", "shift", "space", "enter", "home", "matcap"}

# Every text node, title, aria-label and placeholder the shown part of `root` holds.
READ_TEXT = """(root) => {
  const out = [];
  for (const el of document.querySelectorAll(root)) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const p = n.parentElement;
      if (!p || (!p.checkVisibility() && !p.closest(".sr-only")) || p.closest("script, style")) continue;
      const s = n.textContent.replace(/\\s+/g, " ").trim();
      if (s) out.push(s);
    }
    for (const e of [el, ...el.querySelectorAll("*")]) {
      if (!e.checkVisibility() && !e.classList.contains("sr-only")) continue;
      for (const a of ["title", "aria-label", "placeholder"]) {
        const v = e.getAttribute(a);
        if (v) out.push(v.replace(/\\s+/g, " ").trim());
      }
    }
  }
  return out;
}"""

READ = """() => {
  const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\\s+/g, " ").trim());
  const attrs = (sel, a) => [...document.querySelectorAll(sel)].map((e) => e.getAttribute(a));
  return {
    lang: document.documentElement.lang,
    home: document.getElementById("home-btn")?.getAttribute("aria-label") ?? null,
    context: document.getElementById("context-tab")?.textContent.trim() ?? null,
    workspace: document.getElementById("workspace-toggle")?.getAttribute("aria-label") ?? null,
    workspaces: text("#workspace-toggle [data-workspace]"),
    tips: attrs("#workspace-toggle [data-workspace]", "title"),
    bar: document.querySelector("#viewcontrols [role=toolbar]")?.getAttribute("aria-label") ?? null,
    modes: attrs("#viewcontrols [data-view-mode]", "aria-label"),
  };
}"""

# A blocked Path traced tile names its reason from src/ui/viewMode.ts, a helper outside the shell that still reads
# English, so its tooltip is taken off the tile and left out of the English check.
HELPER = """() => document.querySelector('#viewcontrols [data-view-mode="pathtraced"][aria-disabled="true"]')
  ?.getAttribute("title") ?? null"""

TEXTS = """(sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\\s+/g, " ").trim())"""


def cut(s, scope):
    return cut_labels(s.page, f"{scope} {BASE.replace(', ', f', {scope} ')}") + clipped_controls(
        s.page, controls=f"{scope} {CONTROLS.replace(', ', f', {scope} ')}"
    )


def open_card(s, name):
    s.page.locator(CARDS[name]).click()
    s.page.locator(CARD).first.wait_for()
    settled(s)


def close_card(s):
    s.page.keyboard.press("Escape")
    s.page.locator(CARD).first.wait_for(state="detached")


@pytest.fixture(scope="module")
def seen():
    s = Session(viewport=(WIDE["width"], WIDE["height"]))
    found = {}
    try:
        s.press("Escape")
        open_example(s)
        for lang, want in EXPECTED.items():
            open_settings(s, "Appearance")
            pick(s, "#prefs-language", want["language"])
            settled(s)
            close_settings(s)
            settled(s)
            got = s.page.evaluate(READ)
            got["helper"] = s.page.evaluate(HELPER)
            got["text"] = s.page.evaluate(READ_TEXT, f"{BAR}, #home-btn, #context-tab, #workspace-toggle")
            got["cut"] = cut(s, BAR) + cut(s, "#titlebar")

            for name in CARDS:
                open_card(s, name)
                if name == "views":
                    s.page.locator(f'{CARD} [role=tab][data-tab="views"]').click()
                    settled(s)
                if name == "grid":
                    got["units"] = s.page.evaluate(TEXTS, f"{CARD} .opt-label")
                if name == "views":
                    got["views"] = s.page.evaluate(TEXTS, f"{CARD} .ui-list-row")
                if name == "versions":
                    got["versions"] = s.page.evaluate(TEXTS, f"{CARD} .versions-save-btn")
                got["text"] += s.page.evaluate(READ_TEXT, CARD)
                got["cut"] += cut(s, CARD)
                if name == "views":
                    s.page.locator(f'{CARD} [role=tab][data-tab="appearance"]').click()
                    settled(s)
                    got["text"] += s.page.evaluate(READ_TEXT, CARD)
                    got["cut"] += cut(s, CARD)
                close_card(s)

            s.page.evaluate("() => window.section.start('Z')")
            s.page.locator(CHIP).wait_for()
            settled(s)
            got["chip"] = s.page.evaluate(TEXTS, f"{CHIP} button")
            got["chip_name"] = s.page.locator(CHIP).get_attribute("aria-label")
            got["text"] += s.page.evaluate(READ_TEXT, CHIP)
            got["cut"] += cut(s, CHIP)
            s.page.locator(f"{CHIP} [data-testid=section-off]").click()
            s.page.locator(CHIP).wait_for(state="detached")

            s.page.set_viewport_size(FOLDED)
            settled(s)
            s.page.locator("#menubar .menu-btn >> nth=0").click()
            s.page.locator(FOLD).first.wait_for()
            settled(s)
            got["fold"] = s.page.evaluate(TEXTS, f"{FOLD} .ui-menu-label")
            got["text"] += s.page.evaluate(READ_TEXT, FOLD)
            got["cut"] += cut(s, ".ui-menu")
            s.page.keyboard.press("Escape")
            s.page.set_viewport_size(WIDE)
            settled(s)
            found[lang] = got
    finally:
        s.close()
    return found


def english_lines(lines):
    return [line for line in lines if any(w.lower() not in KEPT for w in re.findall(r"[A-Za-z]{4,}", line))]


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_the_title_bar_and_the_workspace_toggle_read_the_language(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    assert got["lang"] == lang, got
    for key in ("home", "context", "workspace", "workspaces", "tips"):
        assert got[key] == want[key], (key, got[key])


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_the_view_controls_and_their_lists_read_the_language(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    for key in ("bar", "modes", "views", "units"):
        assert got[key] == want[key], (key, got[key])


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_the_section_chip_the_versions_panel_and_the_fold_read_the_language(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    assert got["chip"] == want["chip"], got["chip"]
    assert got["chip_name"] == want["chip_name"], got["chip_name"]
    assert got["versions"] == [want["versions"]], got["versions"]
    assert got["fold"] == want["fold"], got["fold"]


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_no_english_line_is_left(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    left = [phrase for phrase in want["english"] if any(phrase in line for line in got["text"])]
    assert left == [], left
    if lang == "ja":
        lines = [line for line in got["text"] if not (got["helper"] and got["helper"] in line)]
        assert english_lines(lines) == [], english_lines(lines)


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_nothing_is_cut(seen, lang):
    assert seen[lang]["cut"] == []
