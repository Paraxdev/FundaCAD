"""A set Extrude depth carries on to the next pick, in both camera rigs: a click on the new top face starts Press/Pull
on it, a click on an edge starts Fillet, a refused preview refuses the click and commits nothing, Ctrl+Z takes the
extrude back and closes the tool that started from it. The ambient Move gizmo the commit raises is stood down."""

import pytest
from fundacad_harness import Session

pytestmark = [pytest.mark.browser, pytest.mark.a11y]

PLATE = "tools/harness/fixtures/plate.json"
AT = (10, 3)
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
STATE = """() => ({
  extrude: window.extrude.active,
  pressPull: window.pressPull.active,
  fillet: window.edgeFeature.active ? window.edgeFeature.kind : null,
  move: window.__fundacad.move.active,
  types: window.store.document.features.map((f) => f.type),
  rests: window.pressPull.active
    ? window.pressPull.dependsOn()
    : window.edgeFeature.active ? window.edgeFeature.dependsOn() : [],
  anchorZ: window.pressPull.active ? window.pressPull.anchor.z : null,
  faces: window.viewport.highlighter.getSelectedFaces().length,
  preview: window.store.hasPreview,
})"""


@pytest.fixture(scope="module", params=["navigator", "classic"])
def rig(request):
    session = Session()
    try:
        if request.param == "classic":
            session.page.goto(session.url + "&nav=legacy", wait_until="domcontentloaded", timeout=60_000)
            session._ensure_page()
        yield session
    finally:
        session.close()


@pytest.fixture
def s(rig):
    rig.press("Escape")
    rig.new_document()
    rig.open_file(PLATE)
    rig.view("iso")
    top = rig.page.evaluate(TOP)
    rig.page.evaluate(SKETCH, [*AT, top])
    rig.settle()
    rig.top = top
    yield rig
    for _ in range(3):
        rig.page.keyboard.press("Escape")


def open_extrude(s):
    s.click("feature:s")
    s.settle()
    s.tool("Extrude")
    s.settle()
    s.click_at(world=(*AT, s.top))
    s.settle()


def set_depth(s, mm=6):
    """The arrow dragged and let go, which sets the depth."""
    s.drag_handle("depth", mm=mm)
    s.page.wait_for_function(BUILT, timeout=20000)
    s.settle()
    # A drag by mm lands near the depth, not on it
    s.lifted = s.page.evaluate(TOP)
    assert s.lifted > s.top + 1


def state(s):
    return s.page.evaluate(STATE)


def click_canvas(s, point):
    s.page.mouse.move(point["x"], point["y"], steps=4)
    s.page.wait_for_timeout(60)
    s.page.mouse.click(point["x"], point["y"])


def top_face_point(s):
    return s.call("facePoint", select=f"near={AT[0]},{AT[1]},{s.lifted}")


def test_a_click_on_the_new_top_face_starts_press_pull_on_it(s):
    before = state(s)["types"]
    open_extrude(s)
    set_depth(s)
    click_canvas(s, top_face_point(s))
    s.page.wait_for_function("() => window.pressPull.active", timeout=20000)
    s.settle()
    st = state(s)
    assert st["extrude"] is False and st["move"] is False and st["fillet"] is None
    assert st["types"] == [*before, "extrude"]
    assert st["faces"] == 1
    assert st["anchorZ"] == pytest.approx(s.lifted, abs=0.01)
    assert len(st["rests"]) == 1
    assert s.page_errors() == []


def test_a_click_on_an_edge_starts_fillet_on_it(s):
    before = state(s)["types"]
    open_extrude(s)
    set_depth(s)
    click_canvas(s, s.call("edgePoint", select=f"near={AT[0] + 5},{AT[1]},{s.lifted}", via="edge"))
    s.page.wait_for_function("() => window.edgeFeature.active", timeout=20000)
    s.settle()
    st = state(s)
    assert st["fillet"] == "fillet" and st["extrude"] is False and st["pressPull"] is False
    assert st["types"] == [*before, "extrude"]
    assert len(st["rests"]) == 1
    assert s.page_errors() == []


REFUSE = """() => Object.defineProperty(window.store, "previewError", {
  get: () => "kernel said no", configurable: true })"""
FORGIVE = """() => { delete window.store.previewError; }"""


def test_a_refused_preview_refuses_the_click_and_commits_nothing_until_it_builds(s):
    before = state(s)["types"]
    open_extrude(s)
    s.type("D", "6")
    s.page.wait_for_function(BUILT, timeout=20000)
    s.settle()
    s.lifted = s.page.evaluate(TOP)
    # The kernel's own refusals are the unit tests' ground, here the click has to listen to the verdict it is given
    s.page.evaluate(REFUSE)
    try:
        click_canvas(s, top_face_point(s))
        s.settle()
        st = state(s)
        assert st["extrude"] is True and st["pressPull"] is False and st["fillet"] is None
        assert st["types"] == before
    finally:
        s.page.evaluate(FORGIVE)
    click_canvas(s, top_face_point(s))
    s.page.wait_for_function("() => window.pressPull.active", timeout=20000)
    s.settle()
    assert state(s)["types"] == [*before, "extrude"]
    assert s.page_errors() == []


def test_ctrl_z_takes_the_extrude_back_and_closes_the_tool_that_started_from_it(s):
    before = state(s)["types"]
    open_extrude(s)
    set_depth(s)
    click_canvas(s, top_face_point(s))
    s.page.wait_for_function("() => window.pressPull.active", timeout=20000)
    s.settle()
    s.press("Control+z")
    s.settle()
    st = state(s)
    assert st["pressPull"] is False and st["types"] == before
    assert s.page_errors() == []
