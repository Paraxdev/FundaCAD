"""The tool rail in German at the two window heights, Comfortable text: every pill, in the rail and in each flyout,
wraps its words inside the window and cuts nothing."""

import pytest
from test_sketch_keys import to_items_plane

from fundacad_harness import Session
from fundacad_harness.layout import clipped_controls, cut_labels
from fundacad_harness.screens import close_settings, open_settings, settled

pytestmark = [pytest.mark.browser]

OFFSET = "tools/harness/fixtures/offset_box.json"
HEIGHTS = (600, 900)

PILLS = """() => {
  const bad = [];
  let seen = 0;
  for (const pill of document.querySelectorAll('.rail-pill')) {
    const r = pill.getBoundingClientRect();
    if (!r.width) continue;
    seen += 1;
    const name = pill.querySelector('.rail-label')?.textContent ?? '?';
    if (r.width > 14 * parseFloat(getComputedStyle(document.documentElement).fontSize) + 1) bad.push(`${name}: ${Math.round(r.width)}px is wider than 14rem`);
    if (r.right > innerWidth) bad.push(`${name}: right edge ${Math.round(r.right)} past ${innerWidth}`);
    for (const part of pill.querySelectorAll('.rail-label, .rail-sub')) {
      if (part.scrollWidth > part.clientWidth) bad.push(`${name}: ${part.className} scrolls ${part.scrollWidth} > ${part.clientWidth}`);
    }
  }
  return { seen, bad };
}"""

BAIT = """() => {
  const pill = document.createElement('span');
  pill.className = 'rail-pill';
  pill.id = 'pill-bait';
  pill.style.cssText = 'position:fixed;left:60px;top:60px;width:40px;z-index:2147483647';
  pill.innerHTML = '<span class="rail-label" style="white-space:nowrap;overflow:hidden">A label far too long</span>';
  document.body.append(pill);
}"""


# A real pill with a German compound that is far past the cap, as a longer language than German could make.
LONG = """() => {
  const pill = document.querySelector('.tool-rail .rail-pill').cloneNode(true);
  pill.id = 'pill-long';
  pill.style.cssText = 'position:fixed;left:70px;top:70px;z-index:2147483647';
  pill.querySelector('.rail-label').textContent = 'Konstruktionsebenenverschiebungswerkzeug mit Zusatzoptionen';
  document.body.append(pill);
}"""


def frames(s):
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def read(s) -> dict:
    frames(s)
    found = s.page.evaluate(PILLS)
    found["layout"] = cut_labels(s.page) + clipped_controls(s.page)
    return found


def open_flyouts(s, prefix: str) -> dict[str, dict]:
    out = {}
    ids = s.page.evaluate(
        "p => [...document.querySelectorAll(`[data-family^='${p}']`)].map((e) => e.dataset.family)", prefix
    )
    for fid in ids:
        s.page.locator(f"[data-family='{fid}']").click(button="right" if prefix == "fam:" else "left")
        s.page.locator(".float-popover.rail-flyout").wait_for()
        s.page.wait_for_function(
            "() => [...document.querySelectorAll('.float-popover.rail-flyout')].every((e) => +getComputedStyle(e).opacity === 1)"
        )
        out[fid] = read(s)
        s.page.keyboard.press("Escape")
        frames(s)
    return out


def walk_height(height: int) -> dict:
    s = Session(viewport=(1024, height))
    try:
        open_settings(s, "Accessibility")
        s.page.locator("#prefs-comfortable-text").click()
        close_settings(s)
        s.page.evaluate("async () => (await import('/src/i18n/index.ts')).setLanguage('de')")
        s.open_file(OFFSET)
        s.settle()
        settled(s)
        found = {"model": read(s)}
        found["compact"] = s.page.evaluate("() => document.querySelector('.tool-rail').classList.contains('compact')")
        found["create"] = s.page.evaluate("() => document.querySelector(\"[data-family='cat:CREATE'] .rail-label\")?.textContent")
        found["cats"] = open_flyouts(s, "cat:")
        s.page.evaluate(LONG)
        found["long"] = read(s)
        s.page.evaluate("() => document.querySelector('#pill-long').remove()")
        s.page.evaluate(BAIT)
        found["bait"] = read(s)
        s.page.evaluate("() => document.getElementById('pill-bait').remove()")
        s.press("Escape")
        to_items_plane(s)
        frames(s)
        found["sketch"] = read(s)
        found["fams"] = open_flyouts(s, "fam:")
        return found
    finally:
        s.close()


@pytest.fixture(scope="module")
def rail():
    return {h: walk_height(h) for h in HEIGHTS}


@pytest.mark.parametrize("height", HEIGHTS)
def test_every_pill_wraps_inside_the_window(rail, height):
    w = rail[height]
    reads = {"model": w["model"], "sketch": w["sketch"], **w["cats"], **w["fams"]}
    assert len(w["cats"]) >= 4 and len(w["fams"]) >= 3, (list(w["cats"]), list(w["fams"]))
    for name, r in reads.items():
        assert r["seen"] > 0, f"{height} {name}: no pill was read"
        assert r["bad"] == [], f"{height} {name}"
        assert r["layout"] == [], f"{height} {name}"


@pytest.mark.parametrize("height", HEIGHTS)
def test_a_long_name_wraps_inside_the_cap(rail, height):
    assert rail[height]["long"]["bad"] == [], rail[height]["long"]


def test_the_heights_cover_compact_on_and_off(rail):
    assert [rail[h]["compact"] for h in HEIGHTS] == [True, False]


def test_the_detector_finds_a_pill_that_cuts_its_label(rail):
    for h in HEIGHTS:
        assert any("A label far too long" in b for b in rail[h]["bait"]["bad"]), rail[h]["bait"]


def test_the_create_category_reads_german(rail):
    for h in HEIGHTS:
        assert rail[h]["create"] == "Erstellen", rail[h]["create"]
