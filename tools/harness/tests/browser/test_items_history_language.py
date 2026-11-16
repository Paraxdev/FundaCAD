"""The Items and History panels with Deutsch picked, at the narrowest window and a wide one: the headings, folders, a
body's menu and the Geometry list read German, no label is cut and every control stays inside its panel, and a shot of
each panel goes to the size output folder."""

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import BASE, CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import close_settings, open_settings, out_dir, pick, settled

pytestmark = [pytest.mark.browser]

FIXTURE = "tools/harness/fixtures/feature_properties.json"
LANGUAGE = "Deutsch (maschinell übersetzt)"
# 800x600 is the Tauri minimum, where the panels are drawers; at 1280x800 both cards show.
SIZES = [(800, 600), (1280, 800)]


def inside(root: str, selectors: str) -> str:
    return ", ".join(f"{root} {c.strip()}" for c in selectors.split(","))


READ = """(root) => {
  const el = document.querySelector(root);
  if (!el) return null;
  const card = el.getBoundingClientRect();
  const shown = (e) => e.getClientRects().length > 0;
  const out = [...el.querySelectorAll('.tree-label, .float-card-title, .ui-tab, .empty-state, label')]
    .filter(shown)
    .filter((e) => { const r = e.getBoundingClientRect(); return r.right > card.right + 1 || r.left < card.left - 1; })
    .map((e) => e.textContent.trim());
  return {
    title: el.querySelector('.float-card-title')?.textContent.trim() ?? null,
    folders: [...el.querySelectorAll('.tree-folder .tree-label')].filter(shown).map((e) => e.textContent.trim()),
    labels: [...el.querySelectorAll('label')].filter(shown).map((e) => e.textContent.trim()),
    outside: out,
  };
}"""


def frames(s: Session) -> None:
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def read(s: Session, root: str) -> dict:
    frames(s)
    found = s.page.evaluate(READ, root)
    found["cut"] = cut_labels(s.page, inside(root, BASE)) + clipped_controls(s.page, controls=inside(root, CONTROLS))
    return found


def show(s: Session, root: str, keys: str) -> None:
    # On a narrow window Items and History are drawers, one open at a time.
    if not s.page.locator(root).is_visible():
        s.press(keys)
    s.page.locator(root).wait_for()
    settled(s)


def walk(size: tuple[int, int]) -> dict:
    s = Session(viewport=size)
    found: dict = {}
    tag = f"{size[0]}x{size[1]}"
    try:
        s.open_file(FIXTURE)
        s.view("fit")
        s.settle()
        open_settings(s, "Appearance")
        pick(s, "#prefs-language", LANGUAGE)
        settled(s)
        close_settings(s)
        found["lang"] = s.page.evaluate("() => document.documentElement.lang")

        show(s, "#browser", "Ctrl+Alt+s")
        found["items"] = read(s, "#browser")
        s.page.locator("#browser").screenshot(path=str(out_dir() / f"items_history_de_{tag}_items.png"))

        s.page.locator('#browser .feature-row[data-id^="body"]').first.click(button="right")
        s.page.locator(".ui-menu").first.wait_for()
        frames(s)
        found["menu"] = {
            "items": s.page.evaluate(
                "() => [...document.querySelectorAll('.ui-menu .ui-menu-item')].map((e) => e.textContent.trim())"
            ),
            "cut": cut_labels(s.page, ".ui-menu-item"),
        }
        s.page.keyboard.press("Escape")
        settled(s)

        s.page.locator('#browser [data-tab="geometry"]').click()
        settled(s)
        found["geometry"] = read(s, "#browser")
        s.page.locator("#browser").screenshot(path=str(out_dir() / f"items_history_de_{tag}_geometry.png"))

        show(s, "#timeline", "Ctrl+Alt+h")
        found["history"] = read(s, "#timeline")
        s.page.locator("#timeline").screenshot(path=str(out_dir() / f"items_history_de_{tag}_history.png"))
    finally:
        s.close()
    return found


@pytest.fixture(scope="module")
def seen():
    return {size: walk(size) for size in SIZES}


@pytest.mark.parametrize("size", SIZES)
def test_the_language_is_german(seen, size):
    assert seen[size]["lang"] == "de", seen[size]["lang"]


@pytest.mark.parametrize("size", SIZES)
def test_the_items_panel_reads_german_and_cuts_nothing(seen, size):
    got = seen[size]["items"]
    assert got["title"] == "Elemente", got
    assert {"Ursprung", "Körper", "Skizzen"} <= set(got["folders"]), got
    assert got["outside"] == [], got
    assert got["cut"] == [], got


@pytest.mark.parametrize("size", SIZES)
def test_a_body_menu_reads_german_and_cuts_nothing(seen, size):
    got = seen[size]["menu"]
    assert {"Verschieben nach", "Sichtbarkeit", "Umbenennen"} <= set(got["items"]), got
    assert got["cut"] == [], got


@pytest.mark.parametrize("size", SIZES)
def test_the_geometry_list_reads_german_and_cuts_nothing(seen, size):
    got = seen[size]["geometry"]
    assert {"Körper", "Mindestgröße"} <= set(got["labels"]), got
    assert got["outside"] == [], got
    assert got["cut"] == [], got


@pytest.mark.parametrize("size", SIZES)
def test_the_history_panel_reads_german_and_cuts_nothing(seen, size):
    got = seen[size]["history"]
    assert got["title"] == "Verlauf", got
    assert got["outside"] == [], got
    assert got["cut"] == [], got
