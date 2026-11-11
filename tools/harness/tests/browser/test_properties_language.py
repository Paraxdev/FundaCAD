"""A feature's properties in German and French at the narrowest window and at 1024x600, plain and Comfortable text: every
row of an extrude (thin and two sided), a counterbored hole and a circular pattern stays inside the History card with its
label and control whole, a row either keeps its control beside the label or puts it under, and a bait row with a nowrap
label is found."""

import pytest

from fundacad_harness import Session
from fundacad_harness.layout import CONTROLS, clipped_controls, cut_labels
from fundacad_harness.screens import close_settings, open_settings, out_dir, settled

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

FIXTURE = "tools/harness/fixtures/feature_properties.json"
# 800x600 is the Tauri minimum.
SIZES = [(800, 600), (1024, 600)]
LANGS = ["de", "fr"]
TEXTS = ["plain", "comfortable"]
FEATURES = {"ex": 14, "ho": 8, "pat": 4}
# The Operation select shows the line of the extrude's new body option.
NEW_BODY = {"de": "Neuer Körper", "fr": "Nouveau corps"}

# Only the card's own controls, the rest of the page at 800 wide has its own cases.
IN_CARD = ", ".join(f"#timeline {c.strip()}" for c in CONTROLS.split(", "))

READ = """() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const panel = box(document.querySelector('#timeline'));
  const rows = [...document.querySelectorAll('#timeline .param-row')].filter((e) => e.getClientRects().length > 0);
  return {
    count: rows.length,
    rows: rows.map((row) => {
      const lab = row.querySelector(':scope > label');
      const ctl = row.querySelector(':scope > .param-value');
      if (!lab || !ctl) return { field: row.dataset.field ?? row.textContent.slice(0, 20), unread: true };
      const r = box(row), l = box(lab), c = box(ctl);
      return {
        label: lab.textContent,
        field: row.dataset.field ?? null,
        same_line: c.t < l.b - 1 && c.b > l.t + 1,
        under: c.t >= l.b - 1,
        left_gap: Math.abs(c.l - r.l),
        label_whole: lab.scrollWidth <= lab.clientWidth + 1,
        control_inside: c.r <= r.r + 1 && c.l >= r.l - 1,
        in_panel: r.l >= panel.l - 1 && r.r <= panel.r + 1,
      };
    }),
    operation: document.querySelector('#timeline .param-row[data-field="operation"] .select-trigger')?.textContent.trim() ?? null,
  };
}"""

# A real row whose label is forty characters that never wrap, as a longer language than French could make.
BAIT = """([clip, label]) => {
  const row = document.querySelector('#timeline .param-row').cloneNode(true);
  row.id = 'row-bait';
  const lab = row.querySelector(':scope > label');
  lab.textContent = label;
  lab.style.whiteSpace = 'nowrap';
  if (clip) { lab.style.overflow = 'hidden'; lab.style.width = '70px'; }
  document.querySelector('#timeline .timeline-props').append(row);
}"""
BAIT_LABEL = "Zwischenverbindungsdurchmesserwertangabe"
UNBAIT = "() => document.getElementById('row-bait')?.remove()"


def frames(s: Session) -> None:
    s.page.evaluate("() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))")


def read(s: Session) -> dict:
    frames(s)
    found = s.page.evaluate(READ)
    found["layout"] = cut_labels(s.page, "#timeline .param-row") + clipped_controls(s.page, controls=IN_CARD)
    return found


def walk(size: tuple[int, int]) -> dict:
    s = Session(viewport=size)
    found: dict = {}
    try:
        s.open_file(FIXTURE)
        s.view("fit")
        s.panel("History", open=True)
        s.settle()
        for text in TEXTS:
            if text == "comfortable":
                open_settings(s, "Accessibility")
                s.page.locator("#prefs-comfortable-text").click()
                close_settings(s)
            for lang in LANGS:
                s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
                settled(s)
                for fid in FEATURES:
                    s.click(f"feature:{fid}")
                    s.settle()
                    found[(text, lang, fid)] = read(s)
                    if fid == "ex" and text == "plain":
                        s.screenshot(out_dir() / f"properties_{size[0]}x{size[1]}_{lang}.png")
                    s.press("Escape")
                    s.settle()
        s.click("feature:ex")
        s.settle()
        for clip in (True, False):
            s.page.evaluate(BAIT, [clip, BAIT_LABEL])
            found["bait clipped" if clip else "bait nowrap"] = read(s)
            s.page.evaluate(UNBAIT)
    finally:
        s.close()
    return found


@pytest.fixture(scope="module")
def seen():
    return {size: walk(size) for size in SIZES}


CASES = [(size, text, lang, fid) for size in SIZES for text in TEXTS for lang in LANGS for fid in FEATURES]


@pytest.mark.parametrize("size,text,lang,fid", CASES)
def test_every_row_has_its_whole_label_and_control_inside_the_panel(seen, size, text, lang, fid):
    got = seen[size][(text, lang, fid)]
    assert got["count"] == FEATURES[fid], got
    assert [r for r in got["rows"] if r.get("unread")] == [], got
    assert [r["label"] for r in got["rows"] if not r["label_whole"]] == [], got
    assert [r["label"] for r in got["rows"] if not r["control_inside"]] == [], got
    assert [r["label"] for r in got["rows"] if not r["in_panel"]] == [], got
    assert got["layout"] == [], got


@pytest.mark.parametrize("size,text,lang,fid", CASES)
def test_a_row_keeps_its_control_beside_the_label_or_puts_it_under(seen, size, text, lang, fid):
    rows = seen[size][(text, lang, fid)]["rows"]
    assert [r["label"] for r in rows if not (r["same_line"] or (r["under"] and r["left_gap"] <= 1))] == [], rows


@pytest.mark.parametrize("size,text,lang", [(a, b, c) for a in SIZES for b in TEXTS for c in LANGS])
def test_the_operation_select_reads_the_chosen_language(seen, size, text, lang):
    assert seen[size][(text, lang, "ex")]["operation"] == NEW_BODY[lang]


@pytest.mark.parametrize("size", SIZES)
def test_some_rows_wrap_and_some_stay_beside_at_the_narrowest_window(seen, size):
    rows = [r for fid in FEATURES for r in seen[size][("comfortable", "de", fid)]["rows"]]
    assert [r for r in rows if r["under"]] != []
    assert [r for r in rows if r["same_line"]] != []


@pytest.mark.parametrize("size", SIZES)
def test_the_detectors_find_a_nowrap_label(seen, size):
    clipped = seen[size]["bait clipped"]
    assert any("cuts its text in x" in x for x in clipped["layout"]), clipped["layout"]
    nowrap = seen[size]["bait nowrap"]
    for got in (clipped, nowrap):
        assert [r["label"] for r in got["rows"] if not r["label_whole"]] == [BAIT_LABEL], got
