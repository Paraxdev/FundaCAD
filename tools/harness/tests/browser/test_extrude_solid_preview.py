"""An open extrude shows the real body drawn solid with an outline of its profile up the height, never a see
through ghost, for a join and for a cut, in both themes."""

import pytest

from fundacad_harness.screens import close_settings, out_dir, set_theme

pytestmark = pytest.mark.browser

PLATE = "tools/harness/fixtures/plate.json"
SKETCH = """([x, y, z]) => window.store.addFeature({
  id: 's', type: 'sketch', name: 'S', plane: { origin: [0, 0, z], normal: [0, 0, 1], xdir: [1, 0, 0] },
  entities: [{ type: 'rectangle', id: 'r1', width: 10, height: 10, x, y }],
})"""
TOP = """() => {
  const p = window.store.buildState.result.mesh.positions;
  let top = -Infinity;
  for (let i = 2; i < p.length; i += 3) top = Math.max(top, p[i]);
  return top;
}"""
BUILT = "() => window.store.hasPreview && !window.store.buildState.building"
STATE = """() => {
  const v = window.viewport;
  let see = 0;
  v.scene.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || o.userData.owner === undefined) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (ms.some((m) => m.transparent && m.opacity < 1)) see++;
  });
  const out = window.extrude.outline;
  return {
    see,
    peek: [...v.peek],
    ghosted: v.ghosted,
    segments: out ? out.segments : 0,
    color: out ? out.color : 0,
    tris: window.store.buildState.result?.mesh.positions.length ?? 0,
    tool: window.extrude.active,
  };
}"""


@pytest.fixture
def s(session):
    yield session
    session.press("Escape")


def open_extrude(s, at):
    """A sketch lying on the plate's top face at `at`, open in Extrude with its area picked."""
    s.press("Escape")
    s.new_document()
    s.open_file(PLATE)
    s.view("iso")
    top = s.page.evaluate(TOP)
    s.page.evaluate(SKETCH, [*at, top])
    s.settle()
    s.click("feature:s")
    s.settle()
    s.tool("Extrude")
    s.settle()
    s.click_at(world=(*at, top))
    s.settle()


def depth(s, value):
    s.type("D", value)
    s.page.wait_for_function(BUILT, timeout=20000)
    s.settle()
    return s.page.evaluate(STATE)


def red_first(color):
    r, g, b = (color >> 16) & 255, (color >> 8) & 255, color & 255
    return r > g + 40 and r > b + 40


def test_a_join_shows_its_body_solid_with_the_outline_over_it(s):
    s.new_document()
    s.open_file(PLATE)
    s.settle()
    before = s.page.evaluate(STATE)["tris"]
    open_extrude(s, (10, 3))
    st = depth(s, "6")
    assert st["tool"] is True
    assert st["see"] == 0 and st["peek"] == [] and not st["ghosted"]
    assert st["tris"] > before, "the engine's body is on screen, not a local prism"
    assert st["segments"] >= 12, "a ring at each end and a line up each of the four corners"
    assert not red_first(st["color"])
    assert s.page_errors() == []


@pytest.mark.parametrize("theme", ["dark", "light"])
def test_a_cut_into_the_plate_keeps_the_body_opaque_with_an_error_coloured_outline(s, theme):
    set_theme(s, theme)
    close_settings(s)
    try:
        open_extrude(s, (-5, -5))
        added = depth(s, "1")
        cut = depth(s, "-1")
        for st in (added, cut):
            assert st["see"] == 0 and st["peek"] == [] and not st["ghosted"]
            assert st["segments"] >= 12
        assert cut["color"] != added["color"] and red_first(cut["color"])
        s.screenshot(out_dir() / f"extrude_cut_{theme}.png")
        assert s.page_errors() == []
    finally:
        if theme == "light":
            set_theme(s, "dark")
            close_settings(s)
