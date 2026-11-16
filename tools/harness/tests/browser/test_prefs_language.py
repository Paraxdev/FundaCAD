"""Preferences with Deutsch picked, then each other shipped language picked from the Appearance tab while the dialog
stays open, every tab walked at the narrowest window and a wide one: the tabs, pane titles, group titles and control
labels read German and French, no English line from the app's own strings is left in any language, no label is cut and
every control stays reachable, and a shot of each goes to the size output folder. The Plugins pane is not part of this
check, it keeps its English until its own pass."""

import json
from pathlib import Path

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import BASE, CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import PREFS_DIALOG, close_settings, open_settings, out_dir, pick, settled, settings_tab

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
TABS = ["appearance", "viewport", "navigation", "access", "updates", "mcp", "plugins", "experimental"]
# Checked for cut labels and English lines, Plugins stays English until its own pass.
CHECKED = [t for t in TABS if t != "plugins"]

LOCALES = Path(__file__).resolve().parents[4] / "src" / "i18n" / "locales"


def load(lang: str) -> dict[str, str]:
    return json.loads((LOCALES / f"{lang}.json").read_text(encoding="utf8"))


def english_lines(lang: str) -> set[str]:
    """The English text of every Preferences line the language has translated, so a line still showing it was missed.
    A text that another key of the language really spells the same way is no miss."""
    en, tr = load("en"), load(lang)
    own = {k: v for k, v in en.items() if k.startswith(("prefs.", "whatsNew.")) and "{" not in v}
    return {v for k, v in own.items() if tr.get(k) != v} - set(tr.values())


# Lines the app shows on purpose in English: Dialog's Close, the Plugins pane and names that are not translated.
DELIBERATE = {"Close"}

EXPECTED = {
    "de": {
        "title": "Einstellungen",
        "tabs": {
            "appearance": "Darstellung",
            "viewport": "3D-Ansicht",
            "navigation": "Navigation",
            "access": "Barrierefreiheit",
            "updates": "Updates",
            "mcp": "KI-Assistenten",
            "plugins": "Plug-ins",
            "experimental": "Experimentell",
        },
        "lines": {
            "appearance": ["Design", "Einheiten", "Hintergrund der Startseite"],
            "viewport": ["Spiegelungen", "Tangentenkanten", "Pfadverfolgung", "Leistungsmodus", "Kartoffelmodus"],
            "navigation": ["Glättung", "Drehpunkt", "Scrollen", "Zwei-Finger-Scrollen"],
            "access": [
                "Voreinstellung für Screenreader",
                "Auf Standard zurücksetzen",
                "Sehen",
                "Sprachausgabe",
                "Tastatur und Zeiger",
                "Bewegung",
                "Kontrast",
                "Größe der Oberfläche",
                "Beschriftungen der 3D-Ansicht",
                "Anzeigedauer von Meldungen",
                "Größere Klickziele",
            ],
            "updates": ["Kanal"],
            "mcp": ["KI-Assistenten (MCP)", "Live-Dokument", "Status"],
            "experimental": ["Pfadverfolgung", "Samples pro Pixel", "Größe der HDR-Umgebung", "Auf Standard zurücksetzen"],
        },
        "done": "Fertig",
    },
    "fr": {
        "title": "Préférences",
        "tabs": {
            "appearance": "Apparence",
            "viewport": "Vue 3D",
            "navigation": "Navigation",
            "access": "Accessibilité",
            "updates": "Mises à jour",
            "mcp": "Assistants IA",
            "plugins": "Extensions",
            "experimental": "Expérimental",
        },
        "lines": {
            "appearance": ["Thème", "Unités", "Arrière-plan de l'accueil"],
            "viewport": ["Reflets", "Arêtes tangentes", "Tracé de chemins", "Mode performance", "Mode patate"],
            "navigation": ["Lissage", "Pivot d'orbite", "Défilement", "Défilement à deux doigts"],
            "access": [
                "Préréglage lecteur d'écran",
                "Réinitialiser par défaut",
                "Vision",
                "Voix",
                "Clavier et pointeur",
                "Mouvement",
                "Contraste",
                "Taille de l'interface",
                "Libellés de la vue 3D",
                "Durée des notifications",
                "Cibles de clic plus grandes",
            ],
            "updates": ["Canal"],
            "mcp": ["Assistants IA (MCP)", "Document en direct", "État"],
            "experimental": ["Tracé de chemins", "Échantillons par pixel", "Taille de l'environnement HDR"],
        },
        "done": "Terminé",
    },
}

READ = """(root) => {
  const dialog = document.querySelector(root);
  if (!dialog) return null;
  const shown = (e) => e.getClientRects().length > 0;
  const lines = new Set();
  for (const el of dialog.querySelectorAll('*')) {
    if (!shown(el)) continue;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) lines.add(n.textContent.trim());
    for (const a of ['aria-label', 'title', 'placeholder']) {
      if (el.getAttribute(a)) lines.add(el.getAttribute(a).trim());
    }
  }
  const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '');
  const tabs = {};
  for (const t of dialog.querySelectorAll('[role=tab]')) tabs[t.dataset.tab] = t.textContent.trim();
  return {
    lang: document.documentElement.lang,
    title: title ? title.textContent.trim() : null,
    tabs,
    done: [...dialog.querySelectorAll('.modal-foot button')].map((b) => b.textContent.trim()),
    lines: [...lines],
  };
}"""


def inside(root: str, selectors: str) -> str:
    return ", ".join(f"{root} {c.strip()}" for c in selectors.split(","))


def frames(s: Session) -> None:
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def read_tab(s: Session, tab: str, lang: str, tag: str) -> dict:
    settings_tab(s, tab).click()
    s.page.locator(f'{PREFS_DIALOG} [role=tab][data-tab="{tab}"][aria-selected=true]').wait_for()
    settled(s)
    frames(s)
    found = s.page.evaluate(READ, PREFS_DIALOG)
    found["cut"] = cut_labels(s.page, inside(PREFS_DIALOG, BASE)) + clipped_controls(
        s.page, controls=inside(PREFS_DIALOG, CONTROLS)
    )
    s.page.locator(PREFS_DIALOG).screenshot(path=str(out_dir() / f"prefs_{lang}_{tab}_{tag}.png"))
    return found


def walk(size: tuple[int, int]) -> dict:
    s = Session(viewport=size)
    found: dict = {}
    tag = f"{size[0]}x{size[1]}"
    try:
        open_settings(s, "Appearance")
        for lang, name in LANGUAGES.items():
            settings_tab(s, "appearance").click()
            pick(s, "#prefs-language", name)
            settled(s)
            found[lang] = {tab: read_tab(s, tab, lang, tag) for tab in TABS}
        close_settings(s)
    finally:
        s.close()
    return found


@pytest.fixture(scope="module")
def seen():
    return {size: walk(size) for size in SIZES}


@pytest.mark.parametrize("lang", ["de", "fr"])
@pytest.mark.parametrize("size", SIZES)
def test_preferences_reads_the_language(seen, size, lang):
    want = EXPECTED[lang]
    for tab in TABS:
        got = seen[size][lang][tab]
        assert got["lang"] == lang, got
        assert got["title"] == want["title"], got
        assert got["tabs"] == want["tabs"], got
        assert got["done"] == [want["done"]], got
        for line in want["lines"].get(tab, []):
            assert line in got["lines"], (tab, line, got["lines"])


@pytest.mark.parametrize("lang", list(LANGUAGES))
@pytest.mark.parametrize("size", SIZES)
def test_preferences_leaves_no_english_line(seen, size, lang):
    english = english_lines(lang) - DELIBERATE
    for tab in CHECKED:
        got = seen[size][lang][tab]
        assert got["lang"] == lang, got
        assert sorted(english & set(got["lines"])) == [], (tab, got["lines"])


@pytest.mark.parametrize("lang", list(LANGUAGES))
@pytest.mark.parametrize("size", SIZES)
def test_preferences_cuts_nothing(seen, size, lang):
    for tab in CHECKED:
        got = seen[size][lang][tab]
        assert got["cut"] == [], (tab, got["cut"])
