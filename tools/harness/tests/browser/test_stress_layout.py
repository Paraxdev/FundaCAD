"""The Stress material boxes start at one x and stay on their label's line where they fit, and the Stress panel with History open
stays inside a small window with its Run button in view, in English, German, French and Spanish."""

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
            for lang in LANGS:
                s.page.evaluate("async (c) => (await import('/src/i18n/index.ts')).setLanguage(c)", lang)
                settled(s)
                found[(size, lang)] = read(s)
                s.page.screenshot(path=str(out / f"stress_{size[0]}x{size[1]}_{lang}.png"))
        finally:
            s.close()
    return found


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("size", SIZES)
def test_custom_material_boxes_stay_on_their_line_and_share_one_left_x(seen, size, lang):
    got = seen[(size, lang)]
    assert len(got["boxes"]) == 4
    assert all(b["one_line"] for b in got["boxes"]), got["boxes"]
    lefts = [b["l"] for b in got["boxes"]]
    assert max(lefts) - min(lefts) <= 1, lefts


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("size", SIZES)
def test_material_select_lines_up_with_the_boxes_where_it_stays_on_its_line(seen, size, lang):
    got = seen[(size, lang)]
    if got["material"]["one_line"]:
        assert abs(got["material"]["l"] - got["boxes"][0]["l"]) <= 1, got
    else:
        # A long material name takes its own line, as it did before the labels shared a width, at the narrow window only.
        assert size == (1024, 600) and lang != "en", got


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("size", SIZES)
def test_stress_panel_and_run_stay_inside_the_window(seen, size, lang):
    got = seen[(size, lang)]
    assert got["run"] is not None
    assert got["panel"]["t"] >= -1
    assert got["panel"]["b"] <= size[1] + 1, got
    assert got["run"]["b"] <= got["panel"]["b"] + 1 and got["run"]["t"] >= got["panel"]["t"], got
