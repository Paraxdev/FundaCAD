"""A base plane row lit while Mirror waits for bodies draws its origin tile, alone and at the zoom of the moment, and
putting the row out hides it again. The tiles were hidden then, so the lit plane drew nothing."""

import pytest

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

PLATE = "tools/harness/fixtures/plate.json"
NEXT_FRAMES = "() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"

TILES = """() => {
  const v = window.viewport;
  return { visible: ["XY", "XZ", "YZ"].map((k) => v.scene.planes[k].visible), scale: v.scene.originTiles.group.scale.x };
}"""

# The scale a frame gives the tiles now, from the view as it stands.
FRESH_SCALE = """() => {
  const v = window.viewport;
  const tiles = v.scene.originTiles;
  const kept = tiles.group.scale.x;
  v.syncOriginTiles();
  const fresh = tiles.group.scale.x;
  tiles.group.scale.setScalar(kept);
  return fresh;
}"""


@pytest.fixture
def s(session):
    session.press("Escape")
    session.open_file(PLATE)
    session.settle()
    session.page.get_by_role("tab", name="Geometry").click()
    session.page.get_by_role("radio", name="Planes").click()
    session.command("Mirror")
    session.page.wait_for_function("() => window.__fundacad.mirror.active")
    # The plate's one body is taken at the start, which hands the clicks to the plane field.
    session.page.evaluate("() => window.__fundacad.mirror.activate('objects')")
    assert session.page.evaluate("() => window.__fundacad.mirror.fields.active") == "objects"
    yield session
    session.page.evaluate("() => document.activeElement?.blur()")
    for _ in range(3):
        session.page.keyboard.press("Escape")
    session.page.get_by_role("radio", name="Faces").click()
    session.page.get_by_role("tab", name="Items", exact=True).click()


def tiles(s):
    s.page.evaluate(NEXT_FRAMES)
    return s.page.evaluate(TILES)


def test_a_plane_lit_while_mirror_waits_for_bodies_is_drawn_alone_and_kept_to_the_view(s):
    assert tiles(s)["visible"] == [False, False, False]
    s.page.get_by_role("option", name="XZ plane").focus()
    lit = tiles(s)
    assert lit["visible"] == [False, True, False]
    assert lit["scale"] == pytest.approx(s.page.evaluate(FRESH_SCALE), rel=1e-6)
    s.page.evaluate("() => window.viewport.rig.zoomBy(3)")
    for _ in range(10):
        s.page.evaluate(NEXT_FRAMES)
    zoomed = tiles(s)
    assert zoomed["scale"] != pytest.approx(lit["scale"], rel=1e-3)
    assert zoomed["scale"] == pytest.approx(s.page.evaluate(FRESH_SCALE), rel=1e-6)
    s.page.get_by_role("option", name="YZ plane").focus()
    assert tiles(s)["visible"] == [False, False, True]
    s.page.evaluate("() => document.activeElement?.blur()")
    assert tiles(s)["visible"] == [False, False, False]


def test_the_lone_tile_takes_no_press(s):
    s.page.get_by_role("option", name="XY plane").focus()
    assert tiles(s)["visible"] == [True, False, False]
    centre = s.page.evaluate(
        """() => {
          const v = window.viewport;
          const p = v.projectToScreen(v.scene.planes.XY.getWorldPosition(new v.scene.planes.XY.position.constructor()));
          return v.pickPlane(p.x, p.y);
        }"""
    )
    assert centre is None
