"""The Stress custom material boxes start at one x, and the Stress panel with History open stays inside a small window with its
Run button in view, in English and German."""

import pytest
from test_a11y import show_stress

from fundacad_harness import Session
from fundacad_harness.screens import out_dir, pick, settled

pytestmark = [pytest.mark.browser, pytest.mark.smoke]

# Ten boxes, so History is tall enough to leave the Stress panel under it less room than its fixed rows and a short scroller.
TEN = "tools/harness/fixtures/history_ten.json"
SIZES = [(900, 800), (1366, 768)]
LANGS = ["en", "de"]

BOXES = ".stress-e input, .stress-nu input, .stress-yield input, .stress-density input"

READ = """(boxes) => {
  const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
  const panel = document.querySelector('.stress-panel');
  const run = panel.querySelector('.stress-run');
  const body = panel.querySelector('.stress-setup');
  return {
    window: [innerWidth, innerHeight],
    panel: box(panel),
    run: run ? box(run) : null,
    lefts: [...panel.querySelectorAll(boxes)].map((e) => Math.round(box(e).l * 10) / 10),
    body_scrolls: body ? body.scrollHeight > body.clientHeight : null,
  };
}"""


def read(s: Session) -> dict:
    return s.page.evaluate(READ, BOXES)


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
def test_custom_material_boxes_share_one_left_x(seen, size, lang):
    lefts = seen[(size, lang)]["lefts"]
    assert len(lefts) == 4
    assert max(lefts) - min(lefts) <= 1, lefts


@pytest.mark.parametrize("lang", LANGS)
@pytest.mark.parametrize("size", SIZES)
def test_stress_panel_and_run_stay_inside_the_window(seen, size, lang):
    got = seen[(size, lang)]
    assert got["run"] is not None
    assert got["panel"]["t"] >= -1
    assert got["panel"]["b"] <= size[1] + 1, got
    assert got["run"]["b"] <= got["panel"]["b"] + 1 and got["run"]["t"] >= got["panel"]["t"], got
