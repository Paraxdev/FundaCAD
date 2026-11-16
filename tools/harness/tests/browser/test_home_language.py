"""Home with Deutsch picked, then each other shipped language picked from Home's own Accessibility button while Home
stays open, at the narrowest window and a wide one: the headings, the welcome, Blank and Open, the example cards and
the footer read German and French, no English line is left in any language, no label is cut and every control stays
reachable, and a shot of each goes to the size output folder. Safe mode is not covered here: the harness has no way
to start the app in it."""

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import BASE, CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import close_settings, open_settings, out_dir, pick, settled

pytestmark = [pytest.mark.browser]

LANGUAGES = {
    "de": "Deutsch (maschinell übersetzt)",
    "fr": "Français (traduction automatique)",
    "es": "Español (traducción automática)",
    "ja": "日本語 (機械翻訳)",
    "zh-CN": "简体中文 (机器翻译)",
}
# 800x600 is the Tauri minimum.
SIZES = [(800, 600), (1280, 800)]
HOME = ".home[role=dialog]"

ENGLISH = {
    "Start here",
    "Examples",
    "Welcome to FundaCAD",
    "Read the manual",
    "Hide",
    "Blank",
    "Open…",
    "FundaCAD documents",
    "Wall bracket",
    "Box with a lid",
    "Capsule holder",
    "Plate",
    "Pinned lever",
    "Find where it bends",
    "Accessibility",
    "Show Home on startup",
    "Report a problem",
    "Recent",
    "Folders",
    "Add folder…",
    "Recent documents appear here in the desktop app.",
    "Back to the document",
    "Search documents",
}

EXPECTED = {
    "de": {
        "section": "Hier beginnen",
        "welcome": "Willkommen bei FundaCAD",
        "new": ["Leer", "Öffnen…"],
        "examples": ["Wandhalter", "Schachtel mit Deckel", "Kapselhalter", "Platte", "Hebel am Bolzen"],
        "a11y": "Barrierefreiheit",
        "startup": "Startseite beim Start anzeigen",
        "close": "Zurück zum Dokument",
        "background": ["Papier", "Arbeitsbereich", "Eigenes Bild"],
    },
    "fr": {
        "section": "Commencer ici",
        "welcome": "Bienvenue dans FundaCAD",
        "new": ["Vide", "Ouvrir…"],
        "examples": ["Équerre murale", "Boîte avec couvercle", "Porte-capsules", "Plaque", "Levier sur axe"],
        "a11y": "Accessibilité",
        "startup": "Afficher l'Accueil au démarrage",
        "close": "Retour au document",
    },
}


def inside(root: str, selectors: str) -> str:
    return ", ".join(f"{root} {c.strip()}" for c in selectors.split(","))


READ = """(root) => {
  const home = document.querySelector(root);
  if (!home) return null;
  const shown = (e) => e.getClientRects().length > 0;
  const text = (sel) => [...home.querySelectorAll(sel)].filter(shown).map((e) => e.textContent.trim());
  const lines = new Set();
  for (const el of home.querySelectorAll('*')) {
    if (!shown(el)) continue;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) lines.add(n.textContent.trim());
    for (const a of ['aria-label', 'title', 'placeholder']) {
      if (el.getAttribute(a)) lines.add(el.getAttribute(a).trim());
    }
  }
  return {
    lang: document.documentElement.lang,
    sections: text('.home-section'),
    welcome: text('.home-welcome-title')[0] ?? null,
    new: text('.home-new-name'),
    examples: text('.home-example-name'),
    captions: text('.home-example-line'),
    room: [...home.querySelectorAll('.home-example-line')].map((e) => `${e.scrollWidth}/${e.clientWidth}`),
    a11y: text('.home-a11y')[0] ?? null,
    startup: text('.home-startup')[0] ?? null,
    close: home.querySelector('.modal-close')?.getAttribute('aria-label') ?? null,
    lines: [...lines],
  };
}"""


def frames(s: Session) -> None:
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def read(s: Session) -> dict:
    s.page.locator(f"{HOME} .home-example").first.wait_for()
    settled(s)
    frames(s)
    found = s.page.evaluate(READ, HOME)
    found["cut"] = cut_labels(s.page, inside(HOME, BASE)) + clipped_controls(s.page, controls=inside(HOME, CONTROLS))
    return found


def walk(size: tuple[int, int]) -> dict:
    s = Session(viewport=size)
    found: dict = {}
    tag = f"{size[0]}x{size[1]}"
    try:
        open_settings(s, "Appearance")
        pick(s, "#prefs-language", LANGUAGES["de"])
        settled(s)
        found["background"] = s.page.locator("#prefs-home-background [role=radio]").all_inner_texts()
        close_settings(s)

        s.page.locator("#home-btn").click()
        s.page.locator(HOME).wait_for()
        found["de"] = read(s)
        s.page.locator(HOME).screenshot(path=str(out_dir() / f"home_de_{tag}.png"))

        for lang in list(LANGUAGES)[1:]:
            # Preferences opens over Home, which stays and has to follow the switch.
            s.page.locator(f"{HOME} .home-a11y").click()
            s.page.locator('[role=dialog] [data-tab="appearance"]').click()
            pick(s, "#prefs-language", LANGUAGES[lang])
            settled(s)
            close_settings(s)
            found[lang] = read(s)
            s.page.locator(HOME).screenshot(path=str(out_dir() / f"home_{lang}_{tag}.png"))
    finally:
        s.close()
    return found


@pytest.fixture(scope="module")
def seen():
    return {size: walk(size) for size in SIZES}


@pytest.mark.parametrize("size", SIZES)
def test_the_home_picture_choice_reads_german(seen, size):
    assert [b.strip() for b in seen[size]["background"]] == EXPECTED["de"]["background"], seen[size]["background"]


@pytest.mark.parametrize("lang", ["de", "fr"])
@pytest.mark.parametrize("size", SIZES)
def test_home_reads_the_language(seen, size, lang):
    got, want = seen[size][lang], EXPECTED[lang]
    assert got["lang"] == lang, got
    assert got["sections"] == [want["section"]], got
    assert got["welcome"] == want["welcome"], got
    assert got["new"] == want["new"], got
    assert got["examples"] == want["examples"], got
    assert got["a11y"] == want["a11y"], got
    assert got["startup"] == want["startup"], got
    assert got["close"] == want["close"], got


@pytest.mark.parametrize("lang", list(LANGUAGES))
@pytest.mark.parametrize("size", SIZES)
def test_home_leaves_no_english_line(seen, size, lang):
    got = seen[size][lang]
    assert got["lang"] == lang, got
    assert len(got["examples"]) == len(got["captions"]) == 5, got
    assert sorted(ENGLISH & set(got["lines"])) == [], got["lines"]


@pytest.mark.parametrize("lang", list(LANGUAGES))
@pytest.mark.parametrize("size", SIZES)
def test_home_cuts_nothing(seen, size, lang):
    got = seen[size][lang]
    assert got["cut"] == [], (got["cut"], got["room"])
