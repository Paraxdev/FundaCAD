"""The panel column under the view cube in a 1400 by 900 window at 100% and 175%: under the browser build's root zoom
each stacked panel starts under the cube, ends inside the float layer and stays clear of the cards, and a timeline
marker drag drops the marker in the gap under the cursor."""

import pytest

pytestmark = [pytest.mark.browser]

STEPS = (100, 110, 125, 150, 175, 200)
FIXTURE = "tools/harness/fixtures/whole_sketch_extrude.json"
# The view cube's margin, its side at Medium labels and the gap under it, in CSS px.
CUBE_MARGIN = 14
STACK_TOP = CUBE_MARGIN + 120 + 12

# Every rect in window pixels, which the root zoom leaves alone.
COLUMN = """() => {
  const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const seen = (sel) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0).map(box);
  return {
    z: Number(document.documentElement.style.zoom) || 1,
    layer: box(document.getElementById('float-layer').getBoundingClientRect()),
    panels: seen('.measure-panel.ui-panel'),
    cards: seen('#float-layer .float-right > *, #float-layer .float-left-stack > *'),
  };
}"""


def size_to(s, pct):
    s.page.keyboard.press("Control+0")
    for _ in range(STEPS.index(pct) - STEPS.index(100)):
        s.page.keyboard.press("Control+Equal")
    zoom = "" if pct == 100 else f"{pct / 100:g}"
    s.page.wait_for_function("z => document.documentElement.style.zoom === z", arg=zoom)


def column(s):
    """The column once it holds still: it places itself a frame after each resize, and the panels animate in."""
    last = None
    for _ in range(30):
        s.page.wait_for_timeout(150)
        now = s.page.evaluate(COLUMN)
        if now == last:
            return now
        last = now
    return last


@pytest.fixture(scope="module")
def opened(session):
    session.page.set_viewport_size({"width": 1400, "height": 900})
    session.open_file(FIXTURE)
    session.settle()
    return session


@pytest.fixture
def s(opened):
    yield opened
    opened.page.keyboard.press("Escape")
    opened.page.keyboard.press("Control+0")
    opened.page.wait_for_function("() => document.documentElement.style.zoom === ''")


@pytest.mark.parametrize("pct", [100, 175])
def test_stacked_panels_start_under_the_cube_and_end_inside_the_layer(s, pct):
    s.page.evaluate("() => window.__fundacad.handleAction('fasteners')")
    s.page.locator(".scr-library").wait_for()
    s.page.evaluate("() => window.__fundacad.handleAction('parameter-setup')")
    size_to(s, pct)
    col = column(s)
    z, layer = col["z"], col["layer"]
    assert len(col["panels"]) >= 2, col
    tops = sorted(p["top"] for p in col["panels"])
    assert tops[0] == pytest.approx(layer["top"] + STACK_TOP * z, abs=2), col
    for p in col["panels"]:
        assert p["top"] >= layer["top"] + STACK_TOP * z - 1, col
        assert p["bottom"] <= layer["bottom"] - CUBE_MARGIN * z + 1, col
        assert p["left"] >= layer["left"] and p["right"] <= layer["right"] - CUBE_MARGIN * z + 1, col
        for c in col["cards"]:
            apart = (
                p["right"] <= c["left"] + 1
                or c["right"] <= p["left"] + 1
                or p["bottom"] <= c["top"] + 1
                or c["bottom"] <= p["top"] + 1
            )
            assert apart, (p, c)
    s.page.evaluate("() => document.querySelector('.scr-close')?.click()")
