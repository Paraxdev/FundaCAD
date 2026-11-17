"""The Render dock's Materials and Camera tabs and the surface node editor with Deutsch and then Japanese picked in
Preferences: the tabs, headings, glass and surface chips and node names read the language, no line the panels show is
left in English, and no label is cut. Everything is found by id, data attribute, role and position, never by text."""

import re

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import BASE, CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import close_settings, open_settings, pick, settled

pytestmark = [pytest.mark.browser]

DOCK = "#renderdock"
PANEL = f"{DOCK} [role=tabpanel]"
MATERIAL_TAB = f"{DOCK} [role=tab] >> nth=0"
CAMERA_TAB = f"{DOCK} [role=tab] >> nth=2"
GLASS = f'{DOCK} .rd-tile[data-material="m-glass"]'

EXPECTED = {
    "de": {
        "language": "Deutsch (maschinell übersetzt)",
        "tabs": ["Material", "Umgebung", "Kamera"],
        "search": "Materialien suchen",
        "ior": ["Wasser", "Glas", "Kristall", "Diamant"],
        "surface": ["Keine", "Rauschen", "Kratzer", "Gebürstet", "Abnutzung", "Streifen"],
        "camera": ["Objektiv", "Schärfentiefe", "Bild"],
        "graph": ["+ Rauschen", "+ Kratzer", "+ Gebürstet", "+ Abnutzung", "+ Streifen", "+ Fresnel"],
        "english": [
            "In this document",
            "Library",
            "Search materials",
            "Index of refraction",
            "Advanced",
            "Surface",
            "Edit graph",
            "Apply to",
            "Field of view",
            "Depth of field",
            "Edge lines",
            "Surface graph",
            "Converter",
            "outputs a",
        ],
    },
    "ja": {
        "language": "日本語 (機械翻訳)",
        "tabs": ["材料", "環境", "カメラ"],
        "search": "材料を検索",
        "ior": ["水", "ガラス", "クリスタル", "ダイヤモンド"],
        "surface": ["なし", "ノイズ", "傷", "ヘアライン", "摩耗", "縞"],
        "camera": ["レンズ", "被写界深度", "画像"],
        "graph": ["+ ノイズ", "+ 傷", "+ ヘアライン", "+ 摩耗", "+ 縞", "+ フレネル"],
        "english": [],
    },
}

# Key names read the same in every language.
KEPT = {"ctrl", "shift", "space", "enter"}

# Every text node, title, aria-label and placeholder the shown part of `root` holds, with the material names taken
# out: they are the document's own data and stay as the maker typed them.
READ_TEXT = """(root) => {
  const el = document.querySelector(root);
  if (!el) return [];
  const names = [...document.querySelectorAll(".rd-tile-name, .rd-used-name")]
    .map((e) => e.textContent.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const strip = (s) => names.reduce((acc, n) => acc.split(n).join(" "), s);
  const out = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const p = n.parentElement;
    if (!p || !p.checkVisibility() || p.closest("script, style")) continue;
    const s = strip(n.textContent).replace(/\\s+/g, " ").trim();
    if (s) out.push(s);
  }
  for (const e of [el, ...el.querySelectorAll("*")]) {
    if (!e.checkVisibility() && !e.classList.contains("sr-only")) continue;
    for (const a of ["title", "aria-label", "placeholder"]) {
      const v = e.getAttribute(a);
      if (v) out.push(strip(v).replace(/\\s+/g, " ").trim());
    }
  }
  return out;
}"""

READ = """() => {
  const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent.replace(/\\s+/g, " ").trim());
  return {
    lang: document.documentElement.lang,
    tabs: text("#renderdock [role=tab]"),
    search: document.getElementById("rd-material-search")?.placeholder ?? null,
    ior: text("#renderdock [data-ior]"),
    surface: text("#renderdock [data-surface]"),
  };
}"""


def shown_panel(s):
    s.page.evaluate(
        """() => {
  for (const p of document.querySelectorAll("#renderdock [role=tabpanel]")) {
    p.toggleAttribute("data-shown-panel", p.checkVisibility());
  }
}"""
    )
    return "#renderdock [data-shown-panel]"


def cut(s, scope):
    return cut_labels(s.page, f"{scope} {BASE.replace(', ', f', {scope} ')}") + clipped_controls(
        s.page, controls=f"{scope} {CONTROLS.replace(', ', f', {scope} ')}"
    )


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

            s.page.locator(MATERIAL_TAB).click()
            s.page.locator(GLASS).wait_for()
            if not s.page.locator(f"{DOCK} [data-ior]").count():
                s.page.locator(GLASS).click()
                s.page.locator(f"{DOCK} [data-ior]").first.wait_for()
            s.page.locator(f"{DOCK} [data-advanced] summary").click()
            settled(s)
            got = s.page.evaluate(READ)
            material = shown_panel(s)
            got["material_text"] = s.page.evaluate(READ_TEXT, material)
            got["cut"] = cut(s, PANEL) + cut(s, f"{DOCK} [role=tablist]")

            s.page.locator(f"{DOCK} [data-editgraph]").click()
            s.page.locator(".ne-overlay [data-add]").first.wait_for()
            settled(s)
            got["graph"] = s.page.evaluate(
                """() => [...document.querySelectorAll(".ne-overlay [data-add]")]
                  .map((e) => e.textContent.replace(/\\s+/g, " ").trim())"""
            )
            got["graph_text"] = s.page.evaluate(READ_TEXT, ".ne-overlay")
            got["cut"] += cut(s, ".ne-overlay")
            s.page.locator(".ne-overlay .ne-bar .btn-primary").click()
            s.page.locator(".ne-overlay").wait_for(state="detached")
            s.page.locator(f"{DOCK} [data-advanced] summary").click()

            s.page.locator(CAMERA_TAB).click()
            s.page.locator("#rd-fov").wait_for()
            settled(s)
            got["camera_heads"] = s.page.evaluate(
                """() => [...document.querySelectorAll("#renderdock .rd-head")].filter((e) => e.checkVisibility())
                  .map((e) => e.textContent.replace(/\\s+/g, " ").trim())"""
            )
            got["camera_text"] = s.page.evaluate(READ_TEXT, shown_panel(s))
            got["cut"] += cut(s, PANEL)
            found[lang] = got
    finally:
        s.close()
    return found


def english_words(lines):
    words = {w for line in lines for w in re.findall(r"[A-Za-z]{4,}", line)}
    return sorted(w for w in words if w.lower() not in KEPT)


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_the_materials_tab_and_its_lists_read_the_language(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    assert got["lang"] == lang, got
    assert got["tabs"] == want["tabs"], got["tabs"]
    assert got["search"] == want["search"], got["search"]
    assert got["ior"] == want["ior"], got["ior"]
    assert got["surface"] == want["surface"], got["surface"]


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_the_camera_tab_reads_the_language(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    for head in want["camera"]:
        assert head in got["camera_heads"], (head, got["camera_heads"])


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_the_node_editor_reads_the_language(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    assert got["graph"][: len(want["graph"])] == want["graph"], got["graph"]


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_no_english_line_is_left(seen, lang):
    want, got = EXPECTED[lang], seen[lang]
    assert any(want["search"] in line for line in got["material_text"]), got["material_text"]
    assert any(want["camera"][0] in line for line in got["camera_text"]), got["camera_text"]
    assert any(want["graph"][0][2:] in line for line in got["graph_text"]), got["graph_text"]
    lines = got["material_text"] + got["camera_text"] + got["graph_text"]
    left = [phrase for phrase in want["english"] if any(phrase in line for line in lines)]
    assert left == [], left
    if lang == "ja":
        assert english_words(lines) == [], english_words(lines)


@pytest.mark.parametrize("lang", list(EXPECTED))
def test_nothing_is_cut(seen, lang):
    assert seen[lang]["cut"] == []
