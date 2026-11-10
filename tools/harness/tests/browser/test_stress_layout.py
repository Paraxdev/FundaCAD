"""The Stress material boxes start at one x and stay on their label's line wherever they sat on it before the labels shared a
width, in the shipped face, a wider fallback face and Comfortable text, and the Stress panel with History open stays inside a
small window with its Run button in view, in English, German, French and Spanish, and under a History of ten, fourteen and twenty-four
features, opened before or after it."""

import pytest
from test_a11y import show_stress

from fundacad_harness import Session
from fundacad_harness.screens import out_dir, pick, settled

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

# Ten boxes, so History is tall enough to leave the Stress panel under it less room than its fixed rows and a short scroller.
TEN = "tools/harness/fixtures/history_ten.json"
SIZES = [(900, 800), (1366, 768), (1024, 600)]
LANGS = ["en", "de", "fr", "es"]

# The visible box edges: the number wells and the Material select trigger, not the inputs inside the wells.
BOXES = ".stress-e, .stress-nu, .stress-yield, .stress-density"
MATERIAL = ".stress-keyed .select-trigger"

# The label rule the keyed rows had before they shared a width: its own width, never under 72px.
BASE_LABELS = ".stress-keyed > .measure-k:first-child { flex: 0 0 auto; min-width: 72px; }"
# A face wider than the shipped one, as DejaVu Sans on a Linux runner is, so a box that only just fits shows.
WIDE_FACE = ':root { --ui: Verdana, "DejaVu Sans", sans-serif !important; }'
TEXTS = {
    "plain": (False, False),
    "wide": (True, False),
    "comfortable": (False, True),
}

READ = """([boxes, material]) => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const panel = document.querySelector('.stress-panel');
  const run = panel.querySelector('.stress-run');
  const body = panel.querySelector('.stress-setup');
  // Measured after scrolling the box into view, a box clipped out of the scrolled body reads the same left but not a real one.
  const seen = (e) => { e.scrollIntoView({ block: 'nearest' }); return e; };
  const row = (c) => {
    const k = seen(c.closest('.stress-field')).querySelector('.measure-k');
    const kb = box(k), cb = box(seen(c));
    return { l: Math.round(cb.l * 10) / 10, one_line: cb.t < kb.b && cb.b > kb.t };
  };
  return {
    window: [innerWidth, innerHeight],
    panel: box(panel),
    run: run ? box(run) : null,
    boxes: [...panel.querySelectorAll(boxes)].map(row),
    material: row(panel.querySelector(material)),
    body_scrolls: body ? body.scrollHeight > body.clientHeight : null,
  };
}"""


def read(s: Session) -> dict:
    return s.page.evaluate(READ, [BOXES, MATERIAL])


def style(s: Session, id_: str, css: str) -> None:
    s.page.evaluate(
        """([id, css]) => { document.getElementById(id)?.remove();
          if (css) { const e = document.createElement('style'); e.id = id; e.textContent = css; document.head.append(e); } }""",
        [id_, css],
    )


def show_text(s: Session, wide: bool, comfortable: bool) -> None:
    style(s, "probe-face", WIDE_FACE if wide else "")
    s.page.evaluate("(c) => { if (c) document.documentElement.dataset.text = 'comfortable'; else delete document.documentElement.dataset.text; }", comfortable)


@pytest.fixture(scope="module")
def seen():
    out = out_dir()
    found = {}
    for size in SIZES:
        s = Session(viewport=size)
        try:
            s.open_file(TEN)
            s.panel("History", open=True)
            show_stress(s)
            pick(s, ".stress-material", "Custom")
            for text, (wide, comfortable) in TEXTS.items():
                show_text(s, wide, comfortable)
                for lang in LANGS:
                    s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
                    settled(s)
                    found[(size, text, lang)] = read(s)
                    if text == "plain":
                        s.page.screenshot(path=str(out / f"stress_{size[0]}x{size[1]}_{lang}.png"))
                    style(s, "probe-base", BASE_LABELS)
                    settled(s)
                    found[(size, text, lang, "base")] = read(s)
                    style(s, "probe-base", "")
        finally:
            s.close()
    return found


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("text", TEXTS)
@pytest.mark.parametrize("size", SIZES)
def test_custom_material_boxes_share_one_left_x_where_they_sit_on_their_line(seen, size, text, lang):
    got = seen[(size, text, lang)]
    assert len(got["boxes"]) == 4
    lefts = [b["l"] for b in got["boxes"] if b["one_line"]]
    assert max(lefts) - min(lefts) <= 1, got["boxes"]


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("text", TEXTS)
@pytest.mark.parametrize("size", SIZES)
def test_a_row_that_sat_on_one_line_before_the_labels_shared_a_width_still_does(seen, size, text, lang):
    now = seen[(size, text, lang)]
    before = seen[(size, text, lang, "base")]
    rows_now = [now["material"], *now["boxes"]]
    rows_before = [before["material"], *before["boxes"]]
    wrapped = [i for i, (a, b) in enumerate(zip(rows_now, rows_before)) if b["one_line"] and not a["one_line"]]
    assert wrapped == [], (wrapped, rows_now, rows_before)


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("text", TEXTS)
@pytest.mark.parametrize("size", SIZES)
def test_material_select_lines_up_with_the_boxes_where_it_stays_on_its_line(seen, size, text, lang):
    got = seen[(size, text, lang)]
    if got["material"]["one_line"]:
        lefts = [b["l"] for b in got["boxes"] if b["one_line"]]
        assert lefts and abs(got["material"]["l"] - lefts[0]) <= 1, got


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("size", SIZES)
def test_stress_panel_and_run_stay_inside_the_window(seen, size, lang):
    got = seen[(size, "plain", lang)]
    assert got["run"] is not None
    assert got["panel"]["t"] >= -1
    assert got["panel"]["b"] <= size[1] + 1, got
    assert got["run"]["b"] <= got["panel"]["b"] + 1 and got["run"]["t"] >= got["panel"]["t"], got


FIXTURES = {10: TEN, 14: "tools/harness/fixtures/history_fourteen.json", 24: "tools/harness/fixtures/history_twentyfour.json"}
GROWN_SIZES = [(900, 800), (1366, 768)]

GROWN_READ = """() => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const panel = document.querySelector('.stress-panel');
  const history = document.querySelector('#timeline');
  const run = panel.querySelector('.stress-run');
  return {
    panel: box(panel),
    run: run ? box(run) : null,
    history: box(history),
    history_cap: history.style.maxHeight,
    list: box(history.querySelector('.timeline-scroll')),
  };
}"""


@pytest.fixture(scope="module")
def grown():
    found = {}
    for size in GROWN_SIZES:
        for count, path in FIXTURES.items():
            s = Session(viewport=size)
            try:
                s.open_file(path)
                s.panel("History", open=True)
                show_stress(s)
                settled(s)
                found[(size, count, "history first")] = s.page.evaluate(GROWN_READ)
                s.panel("History", open=False)
                settled(s)
                s.panel("History", open=True)
                settled(s)
                found[(size, count, "stress first")] = s.page.evaluate(GROWN_READ)
            finally:
                s.close()
    return found


@pytest.mark.parametrize("order", ["history first", "stress first"])
@pytest.mark.parametrize("count", FIXTURES)
@pytest.mark.parametrize("size", GROWN_SIZES)
def test_stress_panel_and_run_stay_inside_the_window_under_a_history_of_any_length(grown, size, count, order):
    got = grown[(size, count, order)]
    assert got["panel"]["t"] >= -1 and got["panel"]["b"] <= size[1] + 1, got
    assert got["run"]["t"] >= got["panel"]["t"] and got["run"]["b"] <= got["panel"]["b"] + 1, got
    assert got["panel"]["r"] - got["panel"]["l"] >= 250, got
    beside = got["panel"]["r"] <= got["history"]["l"] + 1 or got["panel"]["l"] >= got["history"]["r"] - 1
    assert beside or got["history"]["b"] <= got["panel"]["t"] + 1, got


@pytest.mark.parametrize("size", GROWN_SIZES)
def test_history_is_cut_only_where_the_panel_under_it_has_no_room_otherwise(grown, size):
    cut = {count: grown[(size, count, "history first")]["history_cap"] != "" for count in FIXTURES}
    if size == (900, 800):
        assert cut == {10: False, 14: True, 24: True}, grown
    else:
        assert not any(cut.values()), grown


def test_history_keeps_a_list_to_scroll_when_it_gives_room(grown):
    got = grown[((900, 800), 24, "history first")]
    assert got["list"]["b"] - got["list"]["t"] >= 40, got
